/**
 * board-272 / #2041 — broker /kill-peer disposition (HTTP end-to-end).
 *
 * The registered pid is the `bun server.ts` adapter — a CHILD of the `claude`
 * harness. The pre-fix broker signalled the registered pid and the session tab
 * survived (2 specimens, ~11h zombies). The fix resolves the harness up the
 * adapter's PPID chain (depth-1) and signals it, and reports a LOUD disposition
 * so a caller can never mistake a sibling kill for a session kill.
 *
 * Coverage split (a copied binary cannot be given `comm == "claude"` on macOS —
 * /bin/sh is SIP-blocked from exec, and a copied `bun` loses subprocess
 * spawning under argv[0] dispatch — so the `session` branch is proven at the
 * resolution layer):
 *   - resolution logic, replaying BOTH specimens → harness_resolve.test.ts
 *   - the real `ps` lookup it composes with        → ps_lookup.test.ts
 *   - the broker HTTP path + LOUD fields           → this file (sibling_only + stale)
 *
 * Run: bun test kill_harness.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  tmpDir: string;
}

async function waitForBroker(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker did not come up within ${timeoutMs}ms`);
}

async function spawnBroker(tmpDir: string): Promise<SpawnedBroker> {
  const dbPath = join(tmpDir, "peers.db");
  const port = 19000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForBroker(url);
  return { proc, url, tmpDir };
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

async function register(url: string, pid: number, cwd: string): Promise<string> {
  const { id } = await post<{ id: string }>(`${url}/register`, {
    pid,
    cwd,
    git_root: null,
    tty: null,
    profile: "",
    summary: "kill-harness-test peer",
  });
  return id;
}

async function listPeerIds(url: string, cwd: string): Promise<string[]> {
  const peers = await post<Array<{ id: string }>>(`${url}/list-peers`, {
    scope: "machine",
    cwd,
    git_root: null,
  });
  return peers.map((p) => p.id);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

type KillResponse = {
  ok: boolean;
  error?: string;
  pid?: number;
  killed?: "session" | "sibling_only" | "stale";
  harness_pid?: number;
  registered_pid?: number;
  note?: string;
};

describe("board-272 /kill-peer disposition (HTTP)", () => {
  let broker: SpawnedBroker;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-kill-harness-"));
    broker = await spawnBroker(tmpDir);
  });

  afterAll(() => {
    try {
      broker.proc.kill();
    } catch {
      /* ignore */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("no `claude` parent (bare process) → LOUD sibling_only; session-not-killed", async () => {
    // A bare child of the bun test runner: its direct parent is `bun`, not
    // `claude`, so depth-1 resolution finds no harness → sibling_only. (This is
    // ALSO the guard that a naive multi-hop walk must never trip: it must NOT
    // climb past the direct parent to the test runner's own real claude.)
    const child = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
    const cwd = "/tmp/kill-harness-sibling";
    const id = await register(broker.url, child.pid, cwd);

    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
      signal: "SIGTERM",
    });

    expect(result.ok).toBe(true); // the signal WAS delivered to the registered pid
    expect(result.killed).toBe("sibling_only");
    expect(result.registered_pid).toBe(child.pid);
    expect(result.harness_pid).toBeUndefined();
    expect(result.pid).toBe(child.pid); // primary pid is the sibling on this branch
    // Loud enough that an automated caller can tell the session may survive.
    expect(result.note ?? "").toMatch(/sibling|session.*surviv|manual/i);
    expect(await waitDead(child.pid)).toBe(true); // the bare process still dies
    expect(await listPeerIds(broker.url, cwd)).not.toContain(id);
  });

  test("already-dead registered pid → stale disposition", async () => {
    const child = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
    const deadPid = child.pid;
    child.kill();
    await child.exited;
    const cwd = "/tmp/kill-harness-stale";
    const id = await register(broker.url, deadPid, cwd);

    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
    });
    expect(result.ok).toBe(true);
    expect(result.killed).toBe("stale");
    expect(result.error ?? "").toContain("already exited");
    expect(await listPeerIds(broker.url, cwd)).not.toContain(id);
  });

  test("unsupported signal is still rejected (regression guard)", async () => {
    const child = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
    const id = await register(broker.url, child.pid, "/tmp/kill-harness-badsig");
    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
      signal: "SIGSTOP",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported signal");
    child.kill();
    await child.exited;
  });
});

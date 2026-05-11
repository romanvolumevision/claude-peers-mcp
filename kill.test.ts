/**
 * Tests for the `kill_peer` capability — broker `/kill-peer` endpoint
 * (Atlas #2573). Spawns an isolated broker on a random port + DB, registers
 * a peer backed by a real child process, then exercises:
 *   - terminate a live peer (SIGTERM) → ok, pid returned, process dies,
 *     peer leaves list-peers
 *   - unknown peer id → ok:false, "not found"
 *   - unsupported signal → ok:false
 *   - already-dead PID → ok:true with the stale-peer-cleaned note (ESRCH path)
 *
 * Run: bun test kill.test.ts
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
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker did not come up within ${timeoutMs}ms`);
}

async function spawnBroker(): Promise<SpawnedBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-kill-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForBroker(url);
  return { proc, url, tmpDir };
}

function killBroker(b: SpawnedBroker) {
  try {
    b.proc.kill();
  } catch {
    // ignore
  }
  try {
    rmSync(b.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
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
    summary: "kill-test peer",
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

type KillResponse = { ok: boolean; error?: string; pid?: number };

describe("kill_peer broker endpoint", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker();
  });

  afterAll(() => {
    killBroker(broker);
  });

  test("terminates a live peer, returns its pid, and drops it from list-peers", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const cwd = "/tmp/kill-test-live";
    const id = await register(broker.url, child.pid, cwd);
    expect(await listPeerIds(broker.url, cwd)).toContain(id);

    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
    });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(child.pid);

    const code = await child.exited;
    expect(code).not.toBe(0); // killed by signal, not a clean exit

    expect(await listPeerIds(broker.url, cwd)).not.toContain(id);
  });

  test("unknown peer id → ok:false with a not-found error", async () => {
    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: "nonexistent-peer",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("unsupported signal → ok:false", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const id = await register(broker.url, child.pid, "/tmp/kill-test-badsig");
    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
      signal: "SIGSTOP",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported signal");
    // Clean up the still-live child.
    child.kill();
    await child.exited;
  });

  test("already-dead PID → ok:true with the stale-peer-cleaned note", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const deadPid = child.pid;
    child.kill();
    await child.exited;
    const cwd = "/tmp/kill-test-stale";
    const id = await register(broker.url, deadPid, cwd);

    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
    });
    expect(result.ok).toBe(true);
    expect(result.error).toContain("already exited");
    expect(await listPeerIds(broker.url, cwd)).not.toContain(id);
  });
});

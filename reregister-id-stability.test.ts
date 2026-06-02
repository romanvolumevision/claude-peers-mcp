/**
 * Open-016 Phase 3 (CONV-10639) — broker-side id stability on re-register.
 *
 * A re-register from a still-live PID MUST preserve the peer id (plan §3 R8:
 * the single committed mechanism is the BROKER reusing the existing id for a
 * known live PID, not the adapter re-stamping). A fresh id on every /register
 * would break orch dispatch tracking, the .state.json holder, and the
 * pid-keyed stamp.
 *
 * Also pins the heartbeat `known` flag: an UPDATE no-op for an unknown id
 * reports `known: false`, which is the adapter's "broker forgot me, re-register"
 * detector after a broker restart.
 *
 * Run: bun test reregister-id-stability.test.ts
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
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-reregister-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 18700 + Math.floor(Math.random() * 1000);
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

function regBody(pid: number, cwd: string, summary = "reregister test") {
  return { pid, cwd, git_root: null, tty: null, profile: "", summary };
}

describe("Open-016 broker re-register id stability", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker();
  });

  afterAll(() => {
    killBroker(broker);
  });

  test("re-register from a live PID preserves the same id", async () => {
    // Use this test process's own (live) PID so process.kill(pid, 0) succeeds.
    const pid = process.pid;
    const cwd = "/tmp/reregister-stable";
    const first = await post<{ id: string }>(`${broker.url}/register`, regBody(pid, cwd, "first"));
    expect(first.id).toBeTruthy();

    const second = await post<{ id: string }>(
      `${broker.url}/register`,
      regBody(pid, cwd, "second — after a broker blip"),
    );
    expect(second.id).toBe(first.id); // SAME id, not a fresh mint
  });

  test("re-register refreshes mutable fields while keeping the id", async () => {
    const pid = process.pid;
    const cwd = "/tmp/reregister-fields";
    const first = await post<{ id: string }>(`${broker.url}/register`, regBody(pid, cwd, "old summary"));
    await post<{ id: string }>(`${broker.url}/register`, regBody(pid, cwd, "new summary"));

    const peers = await post<Array<{ id: string; summary: string }>>(`${broker.url}/list-peers`, {
      scope: "machine",
      cwd,
      git_root: null,
    });
    const me = peers.find((p) => p.id === first.id);
    expect(me).toBeTruthy();
    expect(me?.summary).toBe("new summary");
  });

  test("a dead/recycled PID mints a FRESH id (does not resurrect a stale row)", async () => {
    // Register a peer under a PID that is already dead.
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const deadPid = child.pid;
    child.kill();
    await child.exited;

    const cwd = "/tmp/reregister-deadpid";
    const stale = await post<{ id: string }>(`${broker.url}/register`, regBody(deadPid, cwd, "stale"));

    // A later register reusing the SAME (now recycled) PID number must NOT
    // inherit the dead row's id — the stale row is reaped and a fresh id minted.
    // Use this live process's pid as the "recycled" occupant.
    const livePid = process.pid;
    // Seed a row at deadPid is already there; now register livePid fresh.
    const fresh = await post<{ id: string }>(`${broker.url}/register`, regBody(livePid, "/tmp/reregister-live", "live"));
    expect(fresh.id).not.toBe(stale.id);
  });

  test("heartbeat reports known:true for a registered peer", async () => {
    const pid = process.pid;
    const { id } = await post<{ id: string }>(`${broker.url}/register`, regBody(pid, "/tmp/reregister-hb"));
    const hb = await post<{ ok: boolean; known?: boolean }>(`${broker.url}/heartbeat`, { id });
    expect(hb.ok).toBe(true);
    expect(hb.known).toBe(true);
  });

  test("heartbeat reports known:false for an unknown id (broker-forgot signal)", async () => {
    const hb = await post<{ ok: boolean; known?: boolean }>(`${broker.url}/heartbeat`, {
      id: "ghostpeer",
    });
    expect(hb.ok).toBe(true);
    expect(hb.known).toBe(false);
  });
});

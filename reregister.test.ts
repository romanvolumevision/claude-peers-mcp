/**
 * Open-016 Phase 3b (CONV-10639) — re-register-on-broker-loss.
 *
 * Two layers:
 *   1. Unit: the pure `shouldReRegister()` predicate — re-register ONLY on an
 *      explicit `known: false` heartbeat; a missing field (older broker) or
 *      `known: true` is a no-op so the adapter never churns.
 *   2. Integration: bounce the broker mid-session (restart with a fresh DB to
 *      simulate "broker forgot us"), assert heartbeat reports known:false, then
 *      a re-/register restores membership and heartbeat reports known:true.
 *
 * Run: bun test reregister.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldReRegister } from "./shared/reregister.ts";

describe("Open-016 shouldReRegister() predicate", () => {
  test("re-registers on an explicit known:false", () => {
    expect(shouldReRegister({ ok: true, known: false })).toBe(true);
  });

  test("does NOT re-register when known:true", () => {
    expect(shouldReRegister({ ok: true, known: true })).toBe(false);
  });

  test("does NOT re-register when known is absent (older broker, backward-tolerant)", () => {
    expect(shouldReRegister({ ok: true })).toBe(false);
  });

  test("does NOT re-register on a null/undefined response", () => {
    expect(shouldReRegister(null)).toBe(false);
    expect(shouldReRegister(undefined)).toBe(false);
  });
});

// --- integration: bounce the broker and re-register ---

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
  dbPath: string;
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

async function waitForBrokerDown(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) });
    } catch {
      return; // refused → down
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker still up after ${timeoutMs}ms`);
}

function spawnBrokerAt(port: number, dbPath: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

function regBody(pid: number, cwd: string, summary = "reregister integration") {
  return { pid, cwd, git_root: null, tty: null, profile: "", summary };
}

describe("Open-016 re-register after a broker bounce", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-rereg-integ-"));
    const port = 18900 + Math.floor(Math.random() * 1000);
    const dbPath = join(tmpDir, "peers.db");
    const proc = spawnBrokerAt(port, dbPath);
    const url = `http://127.0.0.1:${port}`;
    await waitForBroker(url);
    broker = { proc, url, port, dbPath, tmpDir };
  });

  afterAll(() => {
    try {
      broker.proc.kill();
    } catch {
      // ignore
    }
    try {
      rmSync(broker.tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("broker bounce → heartbeat known:false → re-register restores membership", async () => {
    const pid = process.pid; // live PID so id-reuse path is exercised
    const cwd = "/tmp/rereg-bounce";

    const first = await post<{ id: string }>(`${broker.url}/register`, regBody(pid, cwd));
    expect(first.id).toBeTruthy();
    let hb = await post<{ ok: boolean; known?: boolean }>(`${broker.url}/heartbeat`, { id: first.id });
    expect(hb.known).toBe(true);

    // Bounce the broker with a FRESH db (simulates "broker restarted, forgot us").
    broker.proc.kill();
    await broker.proc.exited;
    await waitForBrokerDown(broker.url);
    const freshDb = join(broker.tmpDir, "peers-fresh.db");
    broker.proc = spawnBrokerAt(broker.port, freshDb);
    await waitForBroker(broker.url);

    // Heartbeat now reports the broker no longer knows us — the re-register signal.
    hb = await post<{ ok: boolean; known?: boolean }>(`${broker.url}/heartbeat`, { id: first.id });
    expect(hb.known).toBe(false);
    expect(shouldReRegister({ ok: true, known: hb.known })).toBe(true);

    // The adapter re-/registers; membership is restored.
    const reReg = await post<{ id: string }>(`${broker.url}/register`, regBody(pid, cwd));
    expect(reReg.id).toBeTruthy();
    const after = await post<{ ok: boolean; known?: boolean }>(`${broker.url}/heartbeat`, { id: reReg.id });
    expect(after.known).toBe(true);
  });
});

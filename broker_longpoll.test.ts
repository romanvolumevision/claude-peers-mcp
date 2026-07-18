/**
 * board-10 / #3567 — broker DELIVERY-LAG (long-poll). CONV-11507.
 *
 * The delivery path used to be poll-GATED only: server.ts polled every 1000ms
 * and the broker's /poll-messages returned immediately (non-blocking, no
 * push-on-insert), so a queued message waited up to ~1s (avg ~500ms) for the
 * recipient's next poll. This suite pins the long-poll fix RED-first against the
 * REAL broker.ts booted on an ISOLATED random high port + tmp DB (NEVER the live
 * broker on :7899). It exercises the orch's 5 gates end-to-end over HTTP:
 *   gate 1 — a message inserted DURING a held poll is delivered near-instant, and
 *            no message is ever dropped across the register/hold gap.
 *   gate 2 — an insert for R1 wakes ONLY R1's held request (no thundering herd).
 *   gate 3 — an empty hold times out cleanly at ~wait_ms (bounded, not forever),
 *            a disconnected client is cleaned up, and repeated holds don't wedge.
 *   backward-compat — an OLD client (no wait_ms) is NEVER held (no long_poll
 *            flag, immediate return) so the live fleet stays byte-identical until
 *            it opts in.
 * gates 4 (client fallback pacing) and 5 (peer-list hoist) live in the pure
 * helper unit tests (longpoll_helpers.test.ts).
 *
 * Run: bun test broker_longpoll.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
  tmpDir: string;
  dbPath: string;
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

function spawnBroker(): SpawnedBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-longpoll-"));
  // Distinct high band (26000-28999) to avoid colliding with the sibling
  // broker-spawning suites (18xxx/19xxx/20xxx-21xxx). NEVER :7899.
  const port = 26000 + Math.floor(Math.random() * 3000);
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Long-poll is orthogonal to the HMAC + identity-bind + repo-wall layers;
      // keep them off so this test is not coupled to them.
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: "off",
      BROKER_REPO_WALL_MODE: "off",
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { proc, url: `http://127.0.0.1:${port}`, port, tmpDir, dbPath };
}

interface PostResult<T = unknown> {
  status: number;
  ok: boolean;
  json: T;
}

async function post<T = unknown>(url: string, body: unknown): Promise<PostResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    json = null as T;
  }
  return { status: res.status, ok: res.ok, json };
}

async function waitUntil(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface PollResult {
  messages: Array<{ from_id: string; to_id: string; text: string; sent_at: string }>;
  long_poll?: boolean;
}

describe("board-10 #3567 — broker long-poll delivery", () => {
  let broker: SpawnedBroker;
  // Registered peers are backed by REAL live child pids (sleep 30) so the
  // broker's process.kill(pid, 0) liveness filter + 30s stale-sweep keep the
  // rows + their undelivered messages alive for the test's duration.
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  async function registerLive(cwd: string): Promise<string> {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);
    const reg = await post<{ id: string }>(`${broker.url}/register`, {
      pid: child.pid,
      cwd,
      git_root: null,
      tty: null,
      profile: "",
      summary: "longpoll-test peer",
    });
    expect(reg.status).toBe(200);
    return reg.json.id;
  }

  beforeEach(async () => {
    broker = spawnBroker();
    await waitForBroker(broker.url);
  });

  afterEach(() => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        // ignore
      }
    }
    children.length = 0;
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

  test("backward-compat: a poll WITHOUT wait_ms is never held (immediate, no long_poll flag)", async () => {
    const id = await registerLive("/tmp/lp-compat");
    const t0 = Date.now();
    const res = await post<PollResult>(`${broker.url}/poll-messages`, { id });
    const elapsed = Date.now() - t0;
    expect(res.json.messages).toEqual([]);
    // An old client must NOT be held (else the live fleet would hang) and must
    // NOT see the new flag.
    expect(res.json.long_poll).toBeUndefined();
    expect(elapsed).toBeLessThan(500);
  }, 20_000);

  test("gate1: a message inserted DURING a held long-poll is delivered near-instant", async () => {
    const sender = await registerLive("/tmp/lp-g1");
    const recip = await registerLive("/tmp/lp-g1");
    const t0 = Date.now();
    // Start a long-poll with nothing queued — do NOT await yet.
    const pollP = post<PollResult>(`${broker.url}/poll-messages`, { id: recip, wait_ms: 5000 });
    // Let the poll register + start holding, THEN insert.
    await new Promise((r) => setTimeout(r, 300));
    await post(`${broker.url}/send-message`, { from_id: sender, to_id: recip, text: "hello-during-hold" });
    const res = await pollP;
    const elapsed = Date.now() - t0;
    expect(res.json.messages.map((m) => m.text)).toEqual(["hello-during-hold"]);
    expect(res.json.long_poll).toBe(true);
    // Woken by the insert (~300ms), NOT the 5s timeout.
    expect(elapsed).toBeLessThan(2500);
  }, 20_000);

  test("gate1: no message is dropped across the hold-gap (all N delivered, no dupes)", async () => {
    const sender = await registerLive("/tmp/lp-g1b");
    const recip = await registerLive("/tmp/lp-g1b");
    const N = 20;
    const received: string[] = [];
    let polling = true;
    const loop = (async () => {
      while (polling && received.length < N) {
        const res = await post<PollResult>(`${broker.url}/poll-messages`, { id: recip, wait_ms: 1000 });
        for (const m of res.json.messages) received.push(m.text);
      }
    })();
    // Fire sends with small gaps to repeatedly hit the register/hold gap window.
    for (let i = 0; i < N; i++) {
      await post(`${broker.url}/send-message`, { from_id: sender, to_id: recip, text: `m${i}` });
      await new Promise((r) => setTimeout(r, 15));
    }
    await waitUntil(() => received.length >= N, 8000);
    polling = false;
    await loop;
    expect(received.length).toBe(N);
    expect(new Set(received).size).toBe(N);
  }, 20_000);

  test("gate2: an insert for R1 wakes ONLY R1 — R2's hold is untouched", async () => {
    const sender = await registerLive("/tmp/lp-g2");
    const r1 = await registerLive("/tmp/lp-g2");
    const r2 = await registerLive("/tmp/lp-g2");
    const t0 = Date.now();
    const p1 = post<PollResult>(`${broker.url}/poll-messages`, { id: r1, wait_ms: 5000 });
    const p2 = post<PollResult>(`${broker.url}/poll-messages`, { id: r2, wait_ms: 800 });
    await new Promise((r) => setTimeout(r, 300));
    await post(`${broker.url}/send-message`, { from_id: sender, to_id: r1, text: "for-r1" });
    const res1 = await p1;
    const e1 = Date.now() - t0;
    expect(res1.json.messages.map((m) => m.text)).toEqual(["for-r1"]);
    expect(e1).toBeLessThan(2500); // R1 woken fast
    const res2 = await p2;
    // R2 was NOT woken by R1's insert — it returned empty via its OWN timeout.
    expect(res2.json.messages).toEqual([]);
  }, 20_000);

  test("gate2/DEFECT-1: two concurrent polls for the SAME peer — one gets the msg, the loser re-holds (no spurious instant-empty)", async () => {
    // Sol red-team DEFECT-1: one insert wakes BOTH same-peer holds; the loser
    // must re-hold for its remaining deadline, not return a spurious empty.
    const sender = await registerLive("/tmp/lp-same");
    const recip = await registerLive("/tmp/lp-same");
    const t0 = Date.now();
    const pA = post<PollResult>(`${broker.url}/poll-messages`, { id: recip, wait_ms: 1500 });
    const pB = post<PollResult>(`${broker.url}/poll-messages`, { id: recip, wait_ms: 1500 });
    await new Promise((r) => setTimeout(r, 300));
    await post(`${broker.url}/send-message`, { from_id: sender, to_id: recip, text: "one-msg" });
    const [rA, rB] = await Promise.all([pA, pB]);
    const texts = [...rA.json.messages, ...rB.json.messages].map((m) => m.text);
    // Exactly one poll delivered the single message — no dup, no loss.
    expect(texts).toEqual(["one-msg"]);
    // Promise.all resolves only when BOTH return; the loser re-held to its own
    // ~1500ms deadline instead of returning empty at the ~300ms wake. A
    // single-hold impl would return the loser empty at ~300ms → elapsed < 1200.
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1200);
  }, 20_000);

  test("gate3: an empty long-poll returns after ~wait_ms (bounded — not instant, not forever)", async () => {
    const id = await registerLive("/tmp/lp-g3");
    const wait = 700;
    const t0 = Date.now();
    const res = await post<PollResult>(`${broker.url}/poll-messages`, { id, wait_ms: wait });
    const elapsed = Date.now() - t0;
    expect(res.json.messages).toEqual([]);
    expect(res.json.long_poll).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(wait - 150); // it HELD ~wait
    expect(elapsed).toBeLessThan(wait + 3000); // bounded release, never forever
  }, 20_000);

  test("gate3: repeated timed-out holds don't wedge the broker (still responsive)", async () => {
    const id = await registerLive("/tmp/lp-g3b");
    for (let i = 0; i < 4; i++) {
      const res = await post<PollResult>(`${broker.url}/poll-messages`, { id, wait_ms: 250 });
      expect(res.json.messages).toEqual([]);
    }
    const health = await fetch(`${broker.url}/health`);
    expect(health.ok).toBe(true);
  }, 20_000);

  test("gate3: a client that disconnects mid-hold is cleaned up (next poll still works)", async () => {
    const sender = await registerLive("/tmp/lp-g3c");
    const recip = await registerLive("/tmp/lp-g3c");
    const ac = new AbortController();
    const dropped = fetch(`${broker.url}/poll-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: recip, wait_ms: 5000 }),
      signal: ac.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort(); // client disconnects mid-hold
    await dropped;
    // A fresh long-poll for the same peer still delivers.
    await post(`${broker.url}/send-message`, { from_id: sender, to_id: recip, text: "after-abort" });
    const res = await post<PollResult>(`${broker.url}/poll-messages`, { id: recip, wait_ms: 2000 });
    expect(res.json.messages.map((m) => m.text)).toEqual(["after-abort"]);
  }, 20_000);
});

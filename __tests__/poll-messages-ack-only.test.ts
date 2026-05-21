/**
 * Tests for the `?ack-only=true` query parameter on `POST /poll-messages`
 * (PR-C, CONV-10272).
 *
 * Default (no flag / falsy): existing atomic peek+mark-delivered behaviour —
 * messages are returned AND marked delivered (a second poll returns empty).
 *
 * `?ack-only=true` (truthy: true/1/yes/on, case-insensitive): peek-only —
 * messages are returned but NOT marked delivered, so repeated polls are
 * idempotent.
 *
 * Mirrors the isolated-broker spawn pattern from kill.test.ts / profile.test.ts:
 * a fresh broker on a random port + mkdtemp DB, waited on via /health, killed
 * in afterAll. HMAC signing (test 7) reuses sign() from ../auth, matching
 * __tests__/auth.test.ts.
 *
 * Run: bun test __tests__/poll-messages-ack-only.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sign } from "../auth";

const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;

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

async function spawnBroker(extraEnv: Record<string, string> = {}): Promise<SpawnedBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-ackonly-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 17000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      ...extraEnv,
    },
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

// Keep the spawned child handles so afterAll can reap them.
const liveChildren: Array<ReturnType<typeof Bun.spawn>> = [];

async function register(url: string, summary: string): Promise<string> {
  // Each peer gets a DISTINCT live PID. /register de-dupes by PID (a second
  // registration for the same PID deletes the first), so reusing process.pid
  // for two peers would silently clobber the first peer + orphan its messages.
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  liveChildren.push(child);
  const { id } = await post<{ id: string }>(`${url}/register`, {
    pid: child.pid,
    cwd: "/tmp/ackonly-test",
    git_root: null,
    tty: null,
    profile: "",
    summary,
  });
  return id;
}

function reapChildren() {
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  liveChildren.length = 0;
}

async function send(url: string, fromId: string, toId: string, text: string): Promise<void> {
  await post<{ ok: boolean }>(`${url}/send-message`, { from_id: fromId, to_id: toId, text });
}

interface PollResponse {
  messages: Array<{ id: number; text: string }>;
}

async function poll(url: string, id: string, query = ""): Promise<PollResponse> {
  return post<PollResponse>(`${url}/poll-messages${query}`, { id });
}

describe("/poll-messages?ack-only — peek-only query param", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker();
  });

  afterAll(() => {
    reapChildren();
    killBroker(broker);
  });

  test("ack-only=true returns undelivered messages WITHOUT marking delivered", async () => {
    const a = await register(broker.url, "recipient A");
    const b = await register(broker.url, "sender B");
    await send(broker.url, b, a, "msg-1");
    await send(broker.url, b, a, "msg-2");

    const first = await poll(broker.url, a, "?ack-only=true");
    expect(first.messages.map((m) => m.text).sort()).toEqual(["msg-1", "msg-2"]);

    // Peek is idempotent: a second peek returns the same undelivered messages.
    const second = await poll(broker.url, a, "?ack-only=true");
    expect(second.messages.map((m) => m.text).sort()).toEqual(["msg-1", "msg-2"]);
  });

  test("ack-only=true is idempotent — 3 calls return same message id sets", async () => {
    const a = await register(broker.url, "recipient idem");
    const b = await register(broker.url, "sender idem");
    await send(broker.url, b, a, "i-1");
    await send(broker.url, b, a, "i-2");

    const idSets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await poll(broker.url, a, "?ack-only=true");
      idSets.push(
        res.messages
          .map((m) => m.id)
          .sort((x, y) => x - y)
          .join(","),
      );
    }
    expect(idSets[0]).not.toBe("");
    expect(idSets[1]).toBe(idSets[0]);
    expect(idSets[2]).toBe(idSets[0]);
  });

  test("ack-only=true returns empty when no undelivered messages", async () => {
    const a = await register(broker.url, "empty recipient");
    const res = await poll(broker.url, a, "?ack-only=true");
    expect(res.messages).toEqual([]);
  });

  test("truthy variants true/1/yes/on (case-insensitive) all peek-only", async () => {
    const variants = ["true", "1", "yes", "on", "TRUE", "Yes"];
    for (const v of variants) {
      const a = await register(broker.url, `truthy-${v}`);
      const b = await register(broker.url, `truthy-sender-${v}`);
      await send(broker.url, b, a, `t-${v}`);

      const first = await poll(broker.url, a, `?ack-only=${v}`);
      expect(first.messages.map((m) => m.text)).toEqual([`t-${v}`]);

      // Peek-only: still undelivered, so a second poll returns it again.
      const second = await poll(broker.url, a, `?ack-only=${v}`);
      expect(second.messages.map((m) => m.text)).toEqual([`t-${v}`]);
    }
  });

  test("falsy/absent variants trigger atomic peek+ack", async () => {
    // "" represents ?ack-only= (present but empty value).
    const variants = ["", "?ack-only=false", "?ack-only=0", "?ack-only=", "?ack-only=garbage"];
    for (const q of variants) {
      const a = await register(broker.url, `falsy-${q}`);
      const b = await register(broker.url, `falsy-sender-${q}`);
      await send(broker.url, b, a, `f-${q}`);

      const first = await poll(broker.url, a, q);
      expect(first.messages.map((m) => m.text)).toEqual([`f-${q}`]);

      // Atomic: message was marked delivered, so the second poll is empty.
      const second = await poll(broker.url, a, q);
      expect(second.messages).toEqual([]);
    }
  });

  test("legacy /poll-messages (no query) still marks delivered", async () => {
    const a = await register(broker.url, "legacy recipient");
    const b = await register(broker.url, "legacy sender");
    await send(broker.url, b, a, "legacy-msg");

    const first = await poll(broker.url, a);
    expect(first.messages.map((m) => m.text)).toEqual(["legacy-msg"]);

    const second = await poll(broker.url, a);
    expect(second.messages).toEqual([]);
  });
});

describe("/poll-messages?ack-only — HMAC enforce mode", () => {
  const SECRET = "ackonly-enforce-secret-32-bytes-stub-data";
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker({
      BROKER_HMAC_MODE: "enforce",
      CLAUDE_PEERS_HMAC_SECRET: SECRET,
    });
  });

  afterAll(() => {
    killBroker(broker);
  });

  async function signedPost<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
    const rawBody = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(rawBody, ts, SECRET);
    const res = await fetch(`${broker.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Claude-Peers-Auth": sig,
        "X-Claude-Peers-Timestamp": String(ts),
      },
      body: rawBody,
    });
    return { status: res.status, json: (await res.json()) as T };
  }

  test("ack-only=true requires HMAC auth in enforce mode (unsigned → 401, signed → 200)", async () => {
    // Register a peer (signed, since enforce mode rejects unsigned everywhere).
    const reg = await signedPost<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/tmp/ackonly-enforce",
      git_root: null,
      tty: null,
      profile: "",
      summary: "enforce recipient",
    });
    expect(reg.status).toBe(200);
    const a = reg.json.id;

    // Unsigned poll with ack-only=true → 401.
    const unsigned = await fetch(`${broker.url}/poll-messages?ack-only=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a }),
    });
    expect(unsigned.status).toBe(401);

    // Signed poll with ack-only=true → 200.
    const signed = await signedPost<PollResponse>("/poll-messages?ack-only=true", { id: a });
    expect(signed.status).toBe(200);
    expect(Array.isArray(signed.json.messages)).toBe(true);
  });
});

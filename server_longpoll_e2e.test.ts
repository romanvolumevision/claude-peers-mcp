/**
 * board-10 / #3567 — long-poll WIRING proof (CONV-11507).
 *
 * The broker HTTP tests (broker_longpoll.test.ts) prove the hold/wake mechanism
 * and the helper unit tests (longpoll_helpers.test.ts) prove the client's pacing
 * + hoist decisions. This file closes the "code-complete-not-wired" gap: it
 * boots the REAL `bun server.ts` (mirroring board-49's session_id_populate
 * harness) against an ISOLATED broker (random high port + tmp DB, NEVER :7899),
 * lets it settle into a held long-poll, then sends it a message and measures how
 * fast the broker marks that row `delivered=1` — i.e. how fast the running
 * server actually WOKE and drained.
 *
 * If server.ts didn't send wait_ms, or the loop never re-polled, or the drain
 * never ran, the row would either never flip (loop broken) or take up to the old
 * ~1s interval — so a sub-second, repeatable delivery proves the whole chain is
 * wired: server sends wait_ms → broker holds → insert wakes it → server drains.
 *
 * Run: bun test server_longpoll_e2e.test.ts
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const SERVER_SCRIPT = new URL("./server.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
  tmpDir: string;
  dbPath: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBroker(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`Broker did not come up within ${timeoutMs}ms`);
}

function spawnBroker(): SpawnedBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-lp-e2e-"));
  const port = 28000 + Math.floor(Math.random() * 2000); // distinct band from siblings
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: "off",
      BROKER_REPO_WALL_MODE: "off",
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { proc, url: `http://127.0.0.1:${port}`, port, tmpDir, dbPath };
}

async function post<T = unknown>(url: string, body: unknown): Promise<{ status: number; json: T }> {
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
  return { status: res.status, json };
}

/** Boot the real server.ts, wait for it to self-register, return its peer id. */
async function bootServer(
  broker: SpawnedBroker,
): Promise<{ server: ReturnType<typeof Bun.spawn>; id: string | null }> {
  const server = Bun.spawn(["bun", SERVER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(broker.port),
      OPENAI_API_KEY: "", // no summary LLM
      CLAUDE_PEERS_HMAC_SECRET: "",
      ITERM_SESSION_ID: "",
      TMUX: "",
      ITERM_PROFILE: "",
      TMUX_PROFILE: "",
      CLAUDE_CODE_SESSION_ID: "lp-e2e-session",
      CLAUDE_SESSION_ID: "",
    },
    stdin: "pipe", // keep stdio transport from hitting EOF
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 12_000;
  let id: string | null = null;
  while (Date.now() < deadline) {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      const row = db.query("SELECT id FROM peers WHERE pid = ?").get(server.pid) as
        | { id: string }
        | null;
      if (row) id = row.id;
    } catch {
      // db mid-write; retry
    } finally {
      db.close();
    }
    if (id) break;
    await sleep(150);
  }
  return { server, id };
}

/** Poll the broker DB for the delivered flag on a specific message. */
function isDelivered(dbPath: string, toId: string, text: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT delivered FROM messages WHERE to_id = ? AND text = ?")
      .get(toId, text) as { delivered: number } | null;
    return (row?.delivered ?? 0) === 1;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

describe("board-10 #3567 — server.ts long-poll delivery is wired end-to-end", () => {
  let broker: SpawnedBroker | null = null;
  let server: ReturnType<typeof Bun.spawn> | null = null;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  afterEach(() => {
    try {
      const sink = server?.stdin;
      if (sink && typeof sink !== "number") sink.end();
    } catch {
      // ignore
    }
    for (const c of [server, ...children, broker?.proc]) {
      try {
        c?.kill();
      } catch {
        // ignore
      }
    }
    children.length = 0;
    try {
      if (broker) rmSync(broker.tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    server = null;
    broker = null;
  });

  test("a message to a settled (held) server is delivered near-instant, repeatably", async () => {
    broker = spawnBroker();
    await waitForBroker(broker.url);
    const booted = await bootServer(broker);
    server = booted.server;
    expect(booted.id).not.toBeNull();
    const recipId = booted.id!;

    // A sender peer, backed by a real live pid so its row survives the sweep.
    const senderChild = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(senderChild);
    const reg = await post<{ id: string }>(`${broker.url}/register`, {
      pid: senderChild.pid,
      cwd: "/tmp/lp-e2e",
      git_root: null,
      tty: null,
      profile: "",
      summary: "e2e sender",
    });
    const senderId = reg.json.id;

    // Let the server drain its initial (empty) poll and settle into a HELD
    // long-poll before we start timing.
    await sleep(1500);

    for (let i = 0; i < 3; i++) {
      const text = `lp-e2e-msg-${i}`;
      const t0 = Date.now();
      await post(`${broker.url}/send-message`, { from_id: senderId, to_id: recipId, text });

      let latency = -1;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (isDelivered(broker.dbPath, recipId, text)) {
          latency = Date.now() - t0;
          break;
        }
        await sleep(20);
      }

      // Delivered at all → the loop is wired (a broken loop never flips the flag).
      expect(latency).toBeGreaterThanOrEqual(0);
      // Near-instant → the held poll was WOKEN by the insert, not waiting out the
      // old ~1s interval. Generous bound (<600ms) vs the sub-100ms real latency.
      expect(latency).toBeLessThan(600);

      await sleep(300); // let the server re-enter its hold before the next send
    }
  }, 30_000);
});

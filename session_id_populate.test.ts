/**
 * board-49 (CONV-11482): broker session_id populate-at-registration.
 *
 * Before this change every peer row carried session_id = '' (13/13 live rows,
 * orch-verified 12:56Z). The broker has ALWAYS stored `body.session_id ?? ''`
 * (broker.ts) and the column + RegisterRequest type already exist — the gap was
 * purely the PEER CLIENT: server.ts never put session_id in the /register body,
 * so it always defaulted to ''. Populating it upgrades caller-binding from
 * process-topology (pid) to session-identity — the #1185 roadmap path.
 *
 * The session id source is `CLAUDE_CODE_SESSION_ID` (canonical; the value Claude
 * Code stamps into every MCP subprocess env — verified present in all 13 live
 * server.ts processes) with a `CLAUDE_SESSION_ID` legacy fallback.
 *
 * These are REAL-server.ts end-to-end tests (mirroring identity_bind_client.ts
 * §2): boot the actual `bun server.ts` against an ISOLATED broker on a random
 * high port + tmp DB (NEVER the live broker on :7899), then read the peers row
 * back and assert session_id. That proves the whole chain — env → register body
 * → broker → DB row — not a mock of it.
 *
 * Run: bun test session_id_populate.test.ts
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
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-board49-"));
  const port = 19900 + Math.floor(Math.random() * 90);
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // session_id populate is orthogonal to the HMAC + identity-bind layers;
      // keep them off so this test is not coupled to them.
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: "off",
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { proc, url: `http://127.0.0.1:${port}`, port, tmpDir, dbPath };
}

/**
 * Boot the real `bun server.ts` MCP process against `broker`, overriding the
 * session-id env exactly as `sessionEnv` specifies (so an ambient
 * CLAUDE_CODE_SESSION_ID from the test runner's own env never leaks in), wait
 * for it to self-register, and return the stored peers row (or null on timeout).
 */
async function bootServerAndReadRow(
  broker: SpawnedBroker,
  sessionEnv: Record<string, string>,
): Promise<{ server: ReturnType<typeof Bun.spawn>; row: { pid: number; session_id: string } | null }> {
  const server = Bun.spawn(["bun", SERVER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(broker.port),
      // No summary LLM call, no HMAC, no terminal-title side effects.
      OPENAI_API_KEY: "",
      CLAUDE_PEERS_HMAC_SECRET: "",
      ITERM_SESSION_ID: "",
      TMUX: "",
      ITERM_PROFILE: "",
      TMUX_PROFILE: "",
      // Explicitly control the session-id inputs (default both to '' so the
      // runner's own CLAUDE_CODE_SESSION_ID cannot bleed into the assertion).
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
      ...sessionEnv,
    },
    // Keep stdin OPEN so the stdio transport doesn't hit EOF and exit.
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });

  const deadline = Date.now() + 12_000;
  let row: { pid: number; session_id: string } | null = null;
  while (Date.now() < deadline) {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      row = db
        .query("SELECT pid, session_id FROM peers WHERE pid = ?")
        .get(server.pid) as typeof row;
    } catch {
      row = null;
    } finally {
      db.close();
    }
    if (row) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { server, row };
}

describe("board-49 — server.ts populates session_id at registration", () => {
  let broker: SpawnedBroker | null = null;
  let server: ReturnType<typeof Bun.spawn> | null = null;

  afterEach(() => {
    try {
      const sink = server?.stdin;
      if (sink && typeof sink !== "number") sink.end();
    } catch {
      // ignore
    }
    try {
      server?.kill();
    } catch {
      // ignore
    }
    try {
      broker?.proc.kill();
    } catch {
      // ignore
    }
    try {
      if (broker) rmSync(broker.tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    server = null;
    broker = null;
  });

  test("CLAUDE_CODE_SESSION_ID (canonical) lands in the peers.session_id column", async () => {
    broker = spawnBroker();
    await waitForBroker(broker.url);
    const sid = "board49-canonical-2f7c9a10-uuid";
    const res = await bootServerAndReadRow(broker, { CLAUDE_CODE_SESSION_ID: sid });
    server = res.server;
    expect(res.row).not.toBeNull();
    // RED before the fix: server.ts never sent session_id, so the broker stored
    // '' (its NOT NULL DEFAULT). GREEN after: the canonical env value is stored.
    expect(res.row!.session_id).toBe(sid);
  }, 20_000);

  test("CLAUDE_SESSION_ID is used as a legacy fallback when the canonical var is empty", async () => {
    broker = spawnBroker();
    await waitForBroker(broker.url);
    const sid = "board49-legacy-fallback-uuid";
    const res = await bootServerAndReadRow(broker, {
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: sid,
    });
    server = res.server;
    expect(res.row).not.toBeNull();
    expect(res.row!.session_id).toBe(sid);
  }, 20_000);

  test("neither var set → session_id stays '' (byte-compatible with a legacy peer)", async () => {
    broker = spawnBroker();
    await waitForBroker(broker.url);
    const res = await bootServerAndReadRow(broker, {});
    server = res.server;
    expect(res.row).not.toBeNull();
    expect(res.row!.session_id).toBe("");
  }, 20_000);
});

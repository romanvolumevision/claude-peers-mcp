/**
 * PR-B peer-client integration tests for the S1 identity binding (GBA-8/9).
 *
 * PR #11 hardened the BROKER (mint token on /register, flag-gated owner-check +
 * boot_id-echo). This suite proves the PEER-CLIENT half that PR-B adds to
 * server.ts: on /register it sends its per-process boot_id in the BODY and
 * captures the minted scope-token, and on every subsequent write it ECHOES the
 * token + boot_id headers so a bound peer PASSES enforce.
 *
 * Two layers, both against a REAL broker spawned on an isolated tmp DB + random
 * high port (NEVER the live broker.db):
 *   1. Contract mirror — replays the exact wire sequence server.ts performs,
 *      using the SAME shared helpers (buildIdentityHeaders) + the SAME header
 *      constants, and asserts enforce accepts the echoed credential and rejects
 *      its absence. This is the regression guard for the client contract: if the
 *      header names drift or the register body drops boot_id, it fails.
 *   2. Real server.ts end-to-end — boots the actual `bun server.ts` MCP process
 *      against an ENFORCE broker and asserts (a) its stored row carries a minted
 *      token + a 32-hex boot_id (so it really sent boot_id in the register body)
 *      and (b) its background poll/heartbeat writes are NOT rejected (no 401),
 *      i.e. the client echoes the credential on every write.
 *
 * Run: bun test identity_bind_client.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  BOOT_ID_HEADER,
  PEER_TOKEN_HEADER,
  buildIdentityHeaders,
  generateBootId,
} from "./shared/identity_bind.ts";

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

function spawnBroker(mode: "off" | "warn" | "enforce"): SpawnedBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), `claude-peers-prb-${mode}-`));
  const port = 19000 + Math.floor(Math.random() * 900);
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Isolate from the HMAC layer so identity-bind is what's under test.
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: mode,
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { proc, url: `http://127.0.0.1:${port}`, port, tmpDir, dbPath };
}

function teardown(b: SpawnedBroker) {
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

interface PostResult<T = unknown> {
  status: number;
  ok: boolean;
  json: T;
}

async function post<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<PostResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
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

function regBody(pid: number, bootId: string, extra: Record<string, unknown> = {}) {
  return {
    pid,
    cwd: "/tmp/gba789-prb",
    git_root: null,
    tty: null,
    profile: "",
    summary: "prb client contract",
    // What server.ts's PR-B /register now sends in the BODY.
    boot_id: bootId,
    ...extra,
  };
}

// --- 1. Contract mirror — the exact server.ts wire sequence -----------------

describe("PR-B client contract — echoed credential passes enforce", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = spawnBroker("enforce");
    await waitForBroker(broker.url);
  });
  afterAll(() => teardown(broker));

  test("register sends boot_id in the body and returns a minted token", async () => {
    const bootId = generateBootId();
    const reg = await post<{ id: string; token?: string }>(
      `${broker.url}/register`,
      regBody(910001, bootId),
    );
    expect(reg.status).toBe(200);
    expect(reg.json.id).toBeTruthy();
    expect(reg.json.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a write echoing buildIdentityHeaders(token, bootId) is ACCEPTED", async () => {
    const bootId = generateBootId();
    const reg = await post<{ id: string; token: string }>(
      `${broker.url}/register`,
      regBody(910002, bootId),
    );
    const { id, token } = reg.json;

    // Exactly what server.ts's brokerFetch now attaches to every POST.
    const headers = buildIdentityHeaders(token, bootId);
    expect(headers[PEER_TOKEN_HEADER]).toBe(token);
    expect(headers[BOOT_ID_HEADER]).toBe(bootId);

    const sent = await post<{ ok: boolean }>(
      `${broker.url}/set-summary`,
      { id, summary: "bound + echoing" },
      headers,
    );
    expect(sent.status).toBe(200);
    expect(sent.json.ok).toBe(true);
  });

  test("the SAME write WITHOUT the echoed headers is REJECTED (401)", async () => {
    const bootId = generateBootId();
    const reg = await post<{ id: string; token: string }>(
      `${broker.url}/register`,
      regBody(910003, bootId),
    );
    const { id } = reg.json;

    // A caller that did NOT capture/echo the token (the pre-PR-B behaviour, or a
    // forger) is rejected for a bound peer.
    const sent = await post<{ error?: string }>(`${broker.url}/set-summary`, {
      id,
      summary: "no credential",
    });
    expect(sent.status).toBe(401);
    expect(sent.json.error).toContain("token_missing");
  });

  test("a re-register with the SAME boot_id is identity-stable + still bound", async () => {
    const bootId = generateBootId();
    const first = await post<{ id: string; token: string }>(
      `${broker.url}/register`,
      // process.pid is live, so the reuse path (not fresh-mint) is exercised.
      regBody(process.pid, bootId),
    );
    const rereg = await post<{ id: string; token: string }>(
      `${broker.url}/register`,
      regBody(process.pid, bootId),
    );
    expect(rereg.status).toBe(200);
    expect(rereg.json.id).toBe(first.json.id);
    // Token preserved across the re-register → the cached client token stays valid.
    expect(rereg.json.token).toBe(first.json.token);

    const sent = await post<{ ok: boolean }>(
      `${broker.url}/heartbeat`,
      { id: rereg.json.id },
      buildIdentityHeaders(rereg.json.token, bootId),
    );
    expect(sent.status).toBe(200);
  });
});

// --- 2. Real server.ts end-to-end against an ENFORCE broker -----------------

describe("PR-B server.ts e2e — real MCP peer is bound + passes enforce", () => {
  let broker: SpawnedBroker;
  let server: ReturnType<typeof Bun.spawn>;
  let stderr = "";

  beforeAll(async () => {
    broker = spawnBroker("enforce");
    await waitForBroker(broker.url);

    server = Bun.spawn(["bun", SERVER_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(broker.port),
        // No summary LLM call, no HMAC, no terminal title side-effects.
        OPENAI_API_KEY: "",
        CLAUDE_PEERS_HMAC_SECRET: "",
        ITERM_SESSION_ID: "",
        TMUX: "",
        ITERM_PROFILE: "",
        TMUX_PROFILE: "",
      },
      // Keep stdin OPEN (piped) so the stdio transport doesn't hit EOF and exit.
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });

    // Drain stderr in the background so we can assert on the log stream.
    (async () => {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of server.stderr as ReadableStream<Uint8Array>) {
          stderr += decoder.decode(chunk);
        }
      } catch {
        // stream closed on teardown
      }
    })();
  });

  afterAll(() => {
    try {
      const sink = server.stdin;
      if (sink && typeof sink !== "number") sink.end();
    } catch {
      // ignore
    }
    try {
      server.kill();
    } catch {
      // ignore
    }
    teardown(broker);
  });

  test("server registers, its row carries a token + 32-hex boot_id, and its writes are NOT 401'd", async () => {
    // Wait for the real server to self-register (it may spend up to ~3s on the
    // best-effort summary race before /register).
    const deadline = Date.now() + 12_000;
    let row: { id: string; pid: number; token: string; boot_id: string } | null = null;
    while (Date.now() < deadline) {
      // Read-only peek at the broker's DB (WAL — safe alongside the live writer).
      const db = new Database(broker.dbPath, { readonly: true });
      try {
        row = db
          .query("SELECT id, pid, token, boot_id FROM peers WHERE pid = ?")
          .get(server.pid) as typeof row;
      } catch {
        row = null;
      } finally {
        db.close();
      }
      if (row) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(row).not.toBeNull();
    // GBA-9: the broker minted + stored a per-peer scope-token.
    expect(row!.token).toMatch(/^[0-9a-f]{64}$/);
    // GBA-8: the CLIENT sent its boot_id in the /register body (else this is '').
    expect(row!.boot_id).toMatch(/^[0-9a-f]{32}$/);

    // Let the poll (1s) + heartbeat run several cycles. In enforce mode a bound
    // peer that fails to echo its token gets 401'd on /poll-messages, which
    // server.ts logs as a "Poll error". Assert that does NOT happen — i.e. the
    // client echoes the credential on its background writes.
    await new Promise((r) => setTimeout(r, 3500));
    expect(stderr).toContain("Registered as peer");
    expect(stderr).not.toContain("401");
    expect(stderr).not.toMatch(/Poll error/);
  }, 20_000);
});

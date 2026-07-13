/**
 * Integration tests for the S1 broker hardening (GBA-7/8/9) — end-to-end against
 * a REAL broker process spawned on an isolated tmp DB + random high port. NEVER
 * touches the live broker.db (each spawn gets its own CLAUDE_PEERS_DB under a
 * mkdtemp dir, torn down in afterAll). HMAC is forced off so the identity-bind
 * behaviour is isolated from the signature layer.
 *
 * Proves:
 *   - additive schema doesn't break existing reads (/list-peers still returns
 *     the Peer shape) AND never leaks the minted `token`/`boot_id` columns.
 *   - flag OFF (default) = byte-identical: a forged from_id is ACCEPTED, and
 *     /register returns the new additive `token` field.
 *   - flag ENFORCE: a forged/missing token on a write path is REJECTED (401),
 *     the correct token is ACCEPTED, a mismatched boot_id echo is REJECTED, and
 *     the PID-spoof /register hijack is REJECTED unless the victim's boot_id is
 *     echoed.
 *
 * Run: bun test identity_bind_integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_ID_HEADER,
  PEER_TOKEN_HEADER,
} from "./shared/identity_bind.ts";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
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

function spawnBroker(mode: "off" | "warn" | "enforce"): SpawnedBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), `claude-peers-gba789-${mode}-`));
  const port = 18000 + Math.floor(Math.random() * 900);
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Isolate from the HMAC layer so identity-bind is what's under test.
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: mode,
      // Keep the audit relay inert (default-off anyway) — no external POSTs.
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { proc, url: `http://127.0.0.1:${port}`, port, tmpDir };
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

function regBody(pid: number, extra: Record<string, unknown> = {}) {
  return {
    pid,
    cwd: "/tmp/gba789",
    git_root: null,
    tty: null,
    profile: "",
    summary: "gba789 integration",
    ...extra,
  };
}

// --- flag OFF (default) — byte-identical + additive-schema safety ---

describe("GBA789 flag OFF — additive + byte-identical", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = spawnBroker("off");
    await waitForBroker(broker.url);
  });
  afterAll(() => teardown(broker));

  test("/register returns the additive `token` field alongside `id`", async () => {
    const reg = await post<{ id: string; token?: string }>(
      `${broker.url}/register`,
      regBody(process.pid),
    );
    expect(reg.status).toBe(200);
    expect(reg.json.id).toBeTruthy();
    expect(typeof reg.json.token).toBe("string");
    expect(reg.json.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("/list-peers still returns the Peer shape AND never leaks token/boot_id", async () => {
    // process.pid is already registered above (live PID → survives the
    // liveness filter). Request from a different context so it isn't excluded.
    const res = await post<Array<Record<string, unknown>>>(`${broker.url}/list-peers`, {
      scope: "machine",
      cwd: "/somewhere/else",
      git_root: null,
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect(res.json.length).toBeGreaterThan(0);
    const peer = res.json.find((p) => p.pid === process.pid)!;
    expect(peer).toBeDefined();
    // Existing reads intact.
    expect(peer.id).toBeTruthy();
    expect(peer.cwd).toBe("/tmp/gba789");
    expect("summary" in peer).toBe(true);
    expect("last_seen" in peer).toBe(true);
    // Secret / off-contract columns MUST NOT be projected.
    expect("token" in peer).toBe(false);
    expect("boot_id" in peer).toBe(false);
    expect("repo_id" in peer).toBe(false);
    expect("session_id" in peer).toBe(false);
  });

  test("a FORGED from_id on /send-message is ACCEPTED when the flag is off", async () => {
    // Target = the real process.pid peer. from_id is a fabricated id the caller
    // does not own — off mode accepts it verbatim (today's behaviour).
    const target = await post<{ id: string }>(`${broker.url}/register`, regBody(process.pid));
    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_id: "forged00",
      to_id: target.json.id,
      text: "spoofed but accepted while flag is off",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

// --- flag ENFORCE — the credential is required ---

describe("GBA789 flag ENFORCE — owner-check + boot_id echo", () => {
  let broker: SpawnedBroker;
  // Distinct FAKE pids: fresh-mint each (no reuse path), and binding lookups +
  // send-message target checks don't liveness-probe, so they persist for the
  // (sub-30s) test without being reaped by cleanStalePeers.
  let peerA: { id: string; token: string };
  let peerB: { id: string; token: string };

  beforeAll(async () => {
    broker = spawnBroker("enforce");
    await waitForBroker(broker.url);
    const a = await post<{ id: string; token: string }>(`${broker.url}/register`, regBody(900001));
    const b = await post<{ id: string; token: string }>(`${broker.url}/register`, regBody(900002));
    peerA = a.json;
    peerB = b.json;
  });
  afterAll(() => teardown(broker));

  test("bound peer gets a token at register", () => {
    expect(peerA.token).toMatch(/^[0-9a-f]{64}$/);
    expect(peerB.token).toMatch(/^[0-9a-f]{64}$/);
    expect(peerA.id).not.toBe(peerB.id);
  });

  test("/send-message from A WITHOUT a token is REJECTED (401 token_missing)", async () => {
    const res = await post<{ error?: string }>(`${broker.url}/send-message`, {
      from_id: peerA.id,
      to_id: peerB.id,
      text: "no token",
    });
    expect(res.status).toBe(401);
    expect(res.json.error).toContain("token_missing");
  });

  test("/send-message from A WITH the correct token is ACCEPTED", async () => {
    const res = await post<{ ok: boolean }>(
      `${broker.url}/send-message`,
      { from_id: peerA.id, to_id: peerB.id, text: "bound + correct" },
      { [PEER_TOKEN_HEADER]: peerA.token },
    );
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  test("a FORGED from_id (A) with the WRONG token is REJECTED (401 token_mismatch)", async () => {
    const res = await post<{ error?: string }>(
      `${broker.url}/send-message`,
      { from_id: peerA.id, to_id: peerB.id, text: "impersonation attempt" },
      { [PEER_TOKEN_HEADER]: peerB.token }, // B's token can't authorise a claim to be A
    );
    expect(res.status).toBe(401);
    expect(res.json.error).toContain("token_mismatch");
  });

  test("/set-summary is bound too: wrong token rejected, correct token accepted", async () => {
    const bad = await post<{ error?: string }>(
      `${broker.url}/set-summary`,
      { id: peerA.id, summary: "hijacked summary" },
      { [PEER_TOKEN_HEADER]: "f".repeat(64) },
    );
    expect(bad.status).toBe(401);

    const good = await post<{ ok: boolean }>(
      `${broker.url}/set-summary`,
      { id: peerA.id, summary: "legit summary" },
      { [PEER_TOKEN_HEADER]: peerA.token },
    );
    expect(good.status).toBe(200);
    expect(good.json.ok).toBe(true);
  });

  test("GBA-8: a mismatched boot_id echo is REJECTED even with the correct token", async () => {
    const boot = "a".repeat(32);
    const reg = await post<{ id: string; token: string }>(
      `${broker.url}/register`,
      regBody(900003, { boot_id: boot }),
    );
    const peerC = reg.json;

    // Correct token, but a boot_id that doesn't match what was registered.
    const bad = await post<{ error?: string }>(
      `${broker.url}/set-summary`,
      { id: peerC.id, summary: "wrong boot" },
      { [PEER_TOKEN_HEADER]: peerC.token, [BOOT_ID_HEADER]: "e".repeat(32) },
    );
    expect(bad.status).toBe(401);
    expect(bad.json.error).toContain("bootid_mismatch");

    // Correct token + correct boot_id echo → accepted.
    const good = await post<{ ok: boolean }>(
      `${broker.url}/set-summary`,
      { id: peerC.id, summary: "right boot" },
      { [PEER_TOKEN_HEADER]: peerC.token, [BOOT_ID_HEADER]: boot },
    );
    expect(good.status).toBe(200);
  });

  test("GBA-8: PID-spoof /register hijack is REJECTED unless the boot_id is echoed", async () => {
    // Victim registers on a LIVE pid (process.pid) with a secret boot_id.
    const victimBoot = "9".repeat(32);
    const victim = await post<{ id: string }>(
      `${broker.url}/register`,
      regBody(process.pid, { boot_id: victimBoot }),
    );
    expect(victim.status).toBe(200);
    const victimId = victim.json.id;

    // Attacker knows the live PID (not secret) but NOT the boot_id → rejected,
    // so they never receive the victim's real peer id.
    const hijack = await post<{ error?: string }>(
      `${broker.url}/register`,
      regBody(process.pid, { boot_id: "1".repeat(32) }),
    );
    expect(hijack.status).toBe(401);
    expect(hijack.json.error).toContain("bootid_mismatch");

    // The victim itself re-registers with the SAME boot_id → identity-stable,
    // same id returned, row unchanged by the failed hijack.
    const rereg = await post<{ id: string }>(
      `${broker.url}/register`,
      regBody(process.pid, { boot_id: victimBoot }),
    );
    expect(rereg.status).toBe(200);
    expect(rereg.json.id).toBe(victimId);
  });
});

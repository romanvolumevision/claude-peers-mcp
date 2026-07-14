/**
 * Broker hardening tests (audit fixes, CONV-10767). Each spawns an isolated
 * broker on a random high port + its own mkdtemp CLAUDE_PEERS_DB — NEVER the
 * live ~/.claude-peers.db, the live broker pid, or port 7899. HMAC + relay are
 * forced off so the identity-bind layer is what's under test.
 *
 * Covers:
 *   Fix 1 — /kill-peer authorization: under enforce, a kill needs the TARGET's
 *           scope-token. No token / wrong token → 403 and the process is NOT
 *           signalled; the correct token → the peer is terminated. Flag-off is
 *           byte-identical (a token-less kill still succeeds).
 *   Fix 2 — /register rejects a malformed / path-like pid (400) before it can
 *           reach path.join (stampPeerIdFile). Safe in all modes.
 *   Fix 3(a) — a broker-CREATED DB file is mode 0600; a pre-existing file is
 *           left untouched.
 *
 * Run: bun test broker_hardening.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEER_TOKEN_HEADER } from "./shared/identity_bind.ts";

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

function spawnBroker(
  mode: "off" | "warn" | "enforce",
  opts: { dbPath?: string } = {},
): SpawnedBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), `claude-peers-hardening-${mode}-`));
  const dbPath = opts.dbPath ?? join(tmpDir, "peers.db");
  // Distinct high port band (20000-21999) to avoid colliding with the other
  // broker-spawning suites (18xxx/19xxx).
  const port = 20000 + Math.floor(Math.random() * 2000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
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

function regBody(pid: unknown, cwd: string) {
  return { pid, cwd, git_root: null, tty: null, profile: "", summary: "hardening-test peer" };
}

async function listPeerIds(url: string, cwd: string): Promise<string[]> {
  const res = await post<Array<{ id: string }>>(`${url}/list-peers`, {
    scope: "machine",
    cwd,
    git_root: null,
  });
  return res.json.map((p) => p.id);
}

/** True while pid names a signalable process owned by us (signal 0 = probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- Fix 1: /kill-peer authorization (enforce) ---

describe("Fix 1 — /kill-peer requires the target's token (enforce)", () => {
  let broker: SpawnedBroker;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  beforeAll(async () => {
    broker = spawnBroker("enforce");
    await waitForBroker(broker.url);
  });
  afterAll(() => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        // ignore
      }
    }
    teardown(broker);
  });

  // Register a peer backed by a REAL live child so we can prove process.kill was
  // (or was NOT) delivered by observing the child's liveness.
  async function registerLiveChild(
    cwd: string,
  ): Promise<{ id: string; token: string; pid: number }> {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);
    const reg = await post<{ id: string; token: string }>(
      `${broker.url}/register`,
      regBody(child.pid, cwd),
    );
    expect(reg.status).toBe(200);
    expect(reg.json.token).toMatch(/^[0-9a-f]{64}$/);
    return { id: reg.json.id, token: reg.json.token, pid: child.pid! };
  }

  test("zero-credential kill (no from_id, no token) → 403 and the peer is NOT killed", async () => {
    const cwd = "/tmp/killauthz-zerocred";
    const t = await registerLiveChild(cwd);

    // The exact vuln being closed: no from_id AND no token.
    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/kill-peer`, {
      to_id: t.id,
    });
    expect(res.status).toBe(403);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toContain("token_missing");

    // process.kill was NOT called → child still alive + still listed.
    expect(isAlive(t.pid)).toBe(true);
    expect(await listPeerIds(broker.url, cwd)).toContain(t.id);
  });

  test("kill with a WRONG token → 403 and the peer is NOT killed", async () => {
    const cwd = "/tmp/killauthz-wrongtok";
    const t = await registerLiveChild(cwd);

    const res = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/kill-peer`,
      { from_id: "orch-test", to_id: t.id },
      { [PEER_TOKEN_HEADER]: "f".repeat(64) },
    );
    expect(res.status).toBe(403);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toContain("token_mismatch");

    expect(isAlive(t.pid)).toBe(true);
    expect(await listPeerIds(broker.url, cwd)).toContain(t.id);
  });

  test("kill WITH the target's valid token → 200 and the peer is terminated", async () => {
    const cwd = "/tmp/killauthz-valid";
    const t = await registerLiveChild(cwd);

    const res = await post<{ ok: boolean; pid?: number; error?: string }>(
      `${broker.url}/kill-peer`,
      { from_id: "orch-test", to_id: t.id },
      { [PEER_TOKEN_HEADER]: t.token },
    );
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.pid).toBe(t.pid);

    // The signal WAS delivered → child dies and leaves list-peers.
    await waitUntil(() => !isAlive(t.pid));
    expect(isAlive(t.pid)).toBe(false);
    expect(await listPeerIds(broker.url, cwd)).not.toContain(t.id);
  });
});

// --- Fix 1: /kill-peer flag-off byte-identical ---

describe("Fix 1 — /kill-peer flag-off behavior unchanged", () => {
  let broker: SpawnedBroker;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  beforeAll(async () => {
    broker = spawnBroker("off");
    await waitForBroker(broker.url);
  });
  afterAll(() => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        // ignore
      }
    }
    teardown(broker);
  });

  test("a kill with NO token STILL succeeds at flag off (today's behaviour)", async () => {
    const cwd = "/tmp/killauthz-flagoff";
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);
    const reg = await post<{ id: string }>(`${broker.url}/register`, regBody(child.pid, cwd));
    expect(reg.status).toBe(200);
    const id = reg.json.id;

    const res = await post<{ ok: boolean; pid?: number }>(`${broker.url}/kill-peer`, {
      from_id: "orch-test",
      to_id: id,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.pid).toBe(child.pid);

    await waitUntil(() => !isAlive(child.pid!));
    expect(await listPeerIds(broker.url, cwd)).not.toContain(id);
  });
});

// --- Fix 2: malformed pid rejected before path construction ---

describe("Fix 2 — /register rejects a malformed pid (all modes)", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    // Use flag-off to prove the pid guard is NOT gated on the identity-bind mode.
    broker = spawnBroker("off");
    await waitForBroker(broker.url);
  });
  afterAll(() => teardown(broker));

  const badPids: Array<{ label: string; pid: unknown }> = [
    { label: "path-like string", pid: "../../../../tmp/evil-marker" },
    { label: "negative integer", pid: -1 },
    { label: "zero", pid: 0 },
    { label: "non-integer float", pid: 3.14 },
  ];

  for (const bad of badPids) {
    test(`rejects a ${bad.label} pid with 400`, async () => {
      const res = await post<{ error?: string }>(
        `${broker.url}/register`,
        regBody(bad.pid, "/tmp/badpid"),
      );
      expect(res.status).toBe(400);
      expect(res.json.error).toContain("invalid pid");
    });
  }

  test("still accepts a valid positive-integer pid", async () => {
    const res = await post<{ id: string; token?: string }>(
      `${broker.url}/register`,
      regBody(987654, "/tmp/goodpid"),
    );
    expect(res.status).toBe(200);
    expect(res.json.id).toBeTruthy();
  });
});

// --- Fix 3(a): DB file permissions ---

describe("Fix 3(a) — a broker-created DB file is mode 0600", () => {
  test("a freshly-created DB file is owner-only (0600)", async () => {
    const broker = spawnBroker("off");
    try {
      await waitForBroker(broker.url);
      const mode = statSync(broker.dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      teardown(broker);
    }
  });

  test("a PRE-EXISTING DB file is NOT re-permissioned on open", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-preexist-"));
    const dbPath = join(tmpDir, "peers.db");
    // Simulate an operator's existing DB (an empty file is a valid empty SQLite
    // DB) with deliberately looser perms.
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o644);

    const broker = spawnBroker("off", { dbPath });
    try {
      await waitForBroker(broker.url);
      const mode = statSync(dbPath).mode & 0o777;
      // Left untouched — the live ~/.claude-peers.db must not be silently
      // re-chmod'd on a launchd respawn.
      expect(mode).toBe(0o644);
    } finally {
      teardown(broker);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

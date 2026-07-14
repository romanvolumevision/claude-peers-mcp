/**
 * Respawn-safety proof for the S1 broker hardening (GBA-7/8/9) — the
 * launchd-KeepAlive scenario.
 *
 * The live broker runs under launchd with KeepAlive=true: it executes
 * `bun broker.ts` from the working tree, and if the process exits it is
 * respawned onto WHATEVER broker.ts is on disk at that moment. So the moment
 * PR #11 merges to `main` (and the 60s GitHub→Mac down-sync lands it), the very
 * next uncontrolled respawn boots the MERGED broker.ts on the SAME peers DB
 * that the pre-PR broker was using — with EXISTING peers already registered by
 * pre-PR-B clients (no scope-token echo, no boot_id).
 *
 * LOAD-BEARING CLAIM proven here: at BROKER_IDENTITY_BIND_MODE=off (the merged
 * default), a respawn onto the merged broker.ts changes NOTHING for existing
 * peers — they are still accepted byte-identically, their messages still flow,
 * a FORGED from_id still flows (today's behaviour), /list-peers reads them back
 * cleanly, and no token/boot_id/repo_id/session_id column is ever leaked. This
 * is what makes merging #11 a non-event.
 *
 * SAFETY: everything runs on an isolated mkdtemp CLAUDE_PEERS_DB + a random
 * high port (18000-18899), HMAC off, relay off, flag unset (=off). It NEVER
 * touches ~/.claude-peers.db, the live broker pid, or the launchd plist. The
 * two broker spawns share one dbPath to simulate kill→KeepAlive-respawn onto
 * the same on-disk DB.
 *
 * Run: bun test identity_bind_respawn.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
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

/**
 * Spawn the MERGED broker.ts on an explicit dbPath + port. Flag is left UNSET
 * (= off, the merged default a real respawn boots with). HMAC + relay off so
 * the identity-bind layer is what's isolated.
 */
function spawnBroker(dbPath: string, port: number): SpawnedBroker {
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      BROKER_HMAC_MODE: "off",
      // BROKER_IDENTITY_BIND_MODE deliberately UNSET → resolves to "off".
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { proc, url: `http://127.0.0.1:${port}`, port };
}

async function killBroker(b: SpawnedBroker): Promise<void> {
  try {
    b.proc.kill();
  } catch {
    // ignore
  }
  // Wait for the port to actually free so the respawn can rebind it.
  try {
    await b.proc.exited;
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

/** An "existing-style" register body: what today's pre-PR-B clients send — no
 * boot_id, and (by omission) they never echo a token afterwards. */
function existingStyleRegBody(pid: number, tag: string) {
  return {
    pid,
    cwd: `/tmp/gba789-respawn/${tag}`,
    git_root: null,
    tty: null,
    profile: "",
    summary: `respawn peer ${tag}`,
  };
}

interface LivePeer {
  helper: ReturnType<typeof Bun.spawn>;
  pid: number;
  tag: string;
  id: string;
  token: string | undefined;
}

/** Spawn a long-lived child so the peer has a REAL live pid that survives the
 * respawn's cleanStalePeers() + the /list-peers PID-filter (the pre-existing
 * liveness contract — flag-independent). */
function spawnLiveHelper(): ReturnType<typeof Bun.spawn> {
  // A bun no-op that just sleeps; killed in teardown.
  return Bun.spawn(["bun", "-e", "setTimeout(() => {}, 600000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// Sort helper so pre/post projections compare order-independently.
function byId(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

const SECRET_COLS = ["token", "boot_id", "repo_id", "session_id"] as const;
function assertNoLeak(peer: Record<string, unknown>) {
  for (const c of SECRET_COLS) {
    expect(c in peer).toBe(false);
  }
}

describe("GBA789 respawn-onto-merged-code @ flag OFF — byte-identical for existing peers", () => {
  let tmpDir: string;
  let dbPath: string;
  let port: number;
  let brokerA: SpawnedBroker;
  const peers: LivePeer[] = [];
  // Typed accessor — the array is populated to length 3 in beforeAll, but
  // noUncheckedIndexedAccess widens peers[i] to `LivePeer | undefined`.
  const peer = (i: number): LivePeer => {
    const p = peers[i];
    if (!p) throw new Error(`peer ${i} not registered`);
    return p;
  };

  // Captured pre-respawn evidence, asserted byte-identical post-respawn.
  let listBefore: Array<Record<string, unknown>>;
  let realSendBefore: PostResult<{ ok: boolean; error?: string }>;
  let forgedSendBefore: PostResult<{ ok: boolean; error?: string }>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-gba789-respawn-"));
    dbPath = join(tmpDir, "peers.db");
    port = 18000 + Math.floor(Math.random() * 900);

    // --- broker-A: the merged broker on a fresh scratch DB ---
    brokerA = spawnBroker(dbPath, port);
    await waitForBroker(brokerA.url);

    // --- register 3 existing-style peers on REAL live pids ---
    for (const tag of ["alpha", "bravo", "charlie"]) {
      const helper = spawnLiveHelper();
      const pid = helper.pid!;
      const reg = await post<{ id: string; token?: string }>(
        `${brokerA.url}/register`,
        existingStyleRegBody(pid, tag),
      );
      expect(reg.status).toBe(200);
      peers.push({ helper, pid, tag, id: reg.json.id, token: reg.json.token });
    }

    // --- capture pre-respawn behaviour ---
    listBefore = (
      await post<Array<Record<string, unknown>>>(`${brokerA.url}/list-peers`, {
        scope: "machine",
        cwd: "/somewhere/else",
        git_root: null,
      })
    ).json;

    // real from_id → send between two existing peers (today's happy path)
    realSendBefore = await post(`${brokerA.url}/send-message`, {
      from_id: peer(0).id,
      to_id: peer(1).id,
      text: "real-from_id pre-respawn",
    });

    // FORGED from_id → an id the caller does not own; off mode accepts it
    forgedSendBefore = await post(`${brokerA.url}/send-message`, {
      from_id: "forged00",
      to_id: peer(1).id,
      text: "forged-from_id pre-respawn",
    });
  });

  afterAll(async () => {
    try {
      await killBroker(brokerA);
    } catch {
      // ignore
    }
    for (const p of peers) {
      try {
        p.helper.kill();
      } catch {
        // ignore
      }
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("pre-respawn: existing peers registered, forged from_id accepted, no leak", () => {
    expect(peers.length).toBe(3);
    expect(realSendBefore.status).toBe(200);
    expect(realSendBefore.json.ok).toBe(true);
    expect(forgedSendBefore.status).toBe(200);
    expect(forgedSendBefore.json.ok).toBe(true);
    expect(listBefore.length).toBe(3);
    for (const peer of listBefore) assertNoLeak(peer);
  });

  test("stored token state: merged /register mints a token even at flag OFF (nuance vs 'unbound')", () => {
    // Introspect the on-disk DB directly (read-only) to record what the merged
    // broker actually stored. The rollout note assumes pre-PR-B clients leave
    // peers effectively 'unbound'; in fact the MERGED broker mints a token at
    // /register unconditionally (the column populates so enforce can flip on
    // later w/o a re-register storm). At flag OFF this is inert — no write path
    // reads it — so it does NOT change acceptance. boot_id stays '' because the
    // existing-style client sent none.
    const ro = new Database(dbPath, { readonly: true });
    try {
      const rows = ro
        .query("SELECT id, token, boot_id, repo_id, session_id FROM peers")
        .all() as Array<{ id: string; token: string; boot_id: string; repo_id: string; session_id: string }>;
      expect(rows.length).toBe(3);
      for (const r of rows) {
        expect(r.token).toMatch(/^[0-9a-f]{64}$/); // minted, non-empty
        expect(r.boot_id).toBe(""); // existing-style client echoed none
      }
    } finally {
      ro.close();
    }
  });

  test("RESPAWN onto merged code @ flag OFF: existing peers accepted BYTE-IDENTICALLY", async () => {
    // Simulate the launchd KeepAlive respawn: kill broker-A, boot broker-B from
    // the SAME merged broker.ts on the SAME on-disk DB + same port. The helper
    // pids are still alive, so the respawn's cleanStalePeers() keeps them.
    await killBroker(brokerA);
    const brokerB = spawnBroker(dbPath, port);
    await waitForBroker(brokerB.url);

    try {
      // (a) /list-peers reads the same peers back — projection byte-identical.
      const listAfter = (
        await post<Array<Record<string, unknown>>>(`${brokerB.url}/list-peers`, {
          scope: "machine",
          cwd: "/somewhere/else",
          git_root: null,
        })
      ).json;
      expect(listAfter.length).toBe(3);
      for (const peer of listAfter) assertNoLeak(peer);
      // Deep-equal the sorted projections: same rows, same values, no drift.
      expect(byId(listAfter)).toEqual(byId(listBefore));

      // (b) real from_id still flows.
      const realAfter = await post<{ ok: boolean }>(`${brokerB.url}/send-message`, {
        from_id: peer(0).id,
        to_id: peer(1).id,
        text: "real-from_id post-respawn",
      });
      expect(realAfter.status).toBe(200);
      expect(realAfter.json.ok).toBe(true);

      // (c) FORGED from_id STILL flows — byte-identical to the pre-respawn call.
      const forgedAfter = await post<{ ok: boolean; error?: string }>(
        `${brokerB.url}/send-message`,
        { from_id: "forged00", to_id: peer(1).id, text: "forged-from_id post-respawn" },
      );
      expect(forgedAfter.status).toBe(forgedSendBefore.status); // 200 === 200
      expect(forgedAfter.json.ok).toBe(forgedSendBefore.json.ok); // true === true

      // (d) messages actually deliver: peer[1] polls and receives all 4
      // (2 pre-respawn + 2 post-respawn — the message table persisted across
      // the respawn on the shared DB).
      const poll = await post<{ messages: Array<{ from_id: string; text: string }> }>(
        `${brokerB.url}/poll-messages`,
        { id: peer(1).id },
      );
      expect(poll.status).toBe(200);
      const texts = poll.json.messages.map((m) => m.text).sort();
      expect(texts).toEqual(
        [
          "forged-from_id post-respawn",
          "forged-from_id pre-respawn",
          "real-from_id post-respawn",
          "real-from_id pre-respawn",
        ].sort(),
      );
      // The forged sender id survived verbatim — no binding rewrote it.
      const forgedDelivered = poll.json.messages.filter((m) => m.from_id === "forged00");
      expect(forgedDelivered.length).toBe(2);

      // (e) no secret column leaked post-respawn either.
      const ro = new Database(dbPath, { readonly: true });
      try {
        const cols = (ro.query("PRAGMA table_info(peers)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        // Additive columns exist on disk…
        for (const c of SECRET_COLS) expect(cols).toContain(c);
        // …but were never projected into the /list-peers response above.
      } finally {
        ro.close();
      }
    } finally {
      await killBroker(brokerB);
    }
  });
});

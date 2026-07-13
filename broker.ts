#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * Phase 0 broker-auth-substrate additions (Atlas #2904, CONV-9671):
 *   - Bind-host configurable via CLAUDE_PEERS_BIND_HOST env-var
 *     (default 127.0.0.1; unblocks tunnel-accessible interface for
 *     Phase 2 Sergei tunnel without affecting localhost-only deployments).
 *   - HMAC-based authentication middleware. Mode controlled by
 *     BROKER_HMAC_MODE env-var: "off" (no auth, no emits), "warn"
 *     (accept all + emit auth_skipped/auth_success — default), or
 *     "enforce" (reject unsigned with 401 + emit auth_failure).
 *   - Audit emissions go via the aggregator-relay endpoint at
 *     http://127.0.0.1:7901/broker-audit-relay (extension of
 *     scripts/lib/peers_aggregator.py — see guppi workstream T0.5
 *     amendment + Atlas #3058). Fail-open: any relay failure swallows
 *     to console.error to avoid blocking broker requests.
 *
 * Atlas #3136 (PR-A-FOLLOWUP-1, CONV-9989) — relay POST hardening:
 *   - emitAudit signs every outbound relay POST via auth.sign (mirroring
 *     server.ts brokerFetch HMAC pattern, c7e96b1).
 *   - The emit is gated by CLAUDE_PEERS_RELAY_AUDIT_ENABLED (default-off)
 *     so PR-A ships solo without flooding /broker-audit-relay 401s
 *     during the PR-B gap window. Operators flip ON once PR-B (guppi
 *     consumer-side HMAC verify) is deployed AND CLAUDE_PEERS_HMAC_SECRET
 *     is provisioned. See relay-audit.ts for flag semantics.
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  KillPeerRequest,
  KillPeerResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";
import { verify } from "./auth";
import {
  RELAY_AUDIT_FLAG_ENV,
  relayAuditEnabled,
  buildRelayAuditHeaders,
} from "./relay-audit";
import { stampPeerIdFile } from "./shared/stamp";
import {
  BOOT_ID_HEADER,
  PEER_TOKEN_HEADER,
  type BindStatus,
  type IdentityBindMode,
  bindingAccepts,
  classifyBinding,
  generatePeerToken,
  identityBindMode,
  isBindMismatch,
} from "./shared/identity_bind";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BIND_HOST = process.env.CLAUDE_PEERS_BIND_HOST ?? "127.0.0.1";
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const HMAC_SECRET = process.env.CLAUDE_PEERS_HMAC_SECRET ?? "";
type HmacMode = "off" | "warn" | "enforce";
const HMAC_MODE: HmacMode = ((): HmacMode => {
  const raw = (process.env.BROKER_HMAC_MODE ?? "warn").toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "warn";
})();
const AGGREGATOR_RELAY_URL =
  process.env.GUPPI_BROKER_AUDIT_RELAY_URL ?? "http://127.0.0.1:7901/broker-audit-relay";

// S1 broker hardening (GBA-7/8/9) — per-peer identity binding. Three-state,
// DEFAULT OFF (mirrors BROKER_HMAC_MODE). off = byte-identical to today; warn =
// observe + emit identity_mismatch; enforce = reject a mismatch for a bound
// peer. See shared/identity_bind.ts. Read once at boot; never flipped here.
const IDENTITY_BIND_MODE: IdentityBindMode = identityBindMode();

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    profile TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    machine TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migrate existing databases: add columns if missing.
// SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so we probe pragma_table_info.
{
  const cols = db.query("PRAGMA table_info(peers)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "profile")) {
    db.run("ALTER TABLE peers ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "host")) {
    db.run("ALTER TABLE peers ADD COLUMN host TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "machine")) {
    db.run("ALTER TABLE peers ADD COLUMN machine TEXT NOT NULL DEFAULT ''");
  }
  // S1 broker hardening (GBA-7/8/9) — strictly-additive identity columns via the
  // same probe-then-ALTER idiom. NOT NULL DEFAULT '' matches the existing style:
  // ADD COLUMN is O(1) metadata-only (does NOT rewrite existing rows), old rows
  // get '' (= "unbound" → binding skipped), WAL + busy_timeout make it safe to
  // run at boot against the live on-disk DB.
  //   boot_id    — per-process id echoed to defeat PID-spoof register hijack.
  //   token      — minted per-peer scope-token; the bind credential. NEVER
  //                returned via /list-peers (see the explicit column lists below).
  //   repo_id    — future repo-scoping key (stored, not yet enforced).
  //   session_id — future session-scoping key (stored, not yet enforced).
  if (!cols.some((c) => c.name === "boot_id")) {
    db.run("ALTER TABLE peers ADD COLUMN boot_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "token")) {
    db.run("ALTER TABLE peers ADD COLUMN token TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "repo_id")) {
    db.run("ALTER TABLE peers ADD COLUMN repo_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "session_id")) {
    db.run("ALTER TABLE peers ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

// Public peer columns returned to OTHER peers via /list-peers. This MUST NOT
// include `token` (the per-peer bind secret) — a `SELECT *` would leak every
// peer's credential to every caller. Keeping it to exactly the Peer-type fields
// also keeps /list-peers output byte-identical to pre-GBA789 (the new columns
// are simply never projected). boot_id/repo_id/session_id are non-secret but
// off-contract, so they are excluded too.
const PEER_COLUMNS =
  "id, pid, cwd, git_root, tty, profile, host, machine, summary, registered_at, last_seen";

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, profile, host, machine, summary, registered_at, last_seen, boot_id, token, repo_id, session_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT ${PEER_COLUMNS} FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT ${PEER_COLUMNS} FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT ${PEER_COLUMNS} FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

// Open-016 Phase 3 (CONV-10639): a re-register MUST preserve the peer id when
// it comes from a still-live PID we already know. The old code minted a fresh
// id + DELETEd the prior PID row on EVERY /register, so an adapter that
// re-registered after a broker blip got a brand-new id — which breaks orch
// dispatch tracking, the .state.json holder, and the pid-keyed stamp. Decision
// (plan §3 R8, single committed mechanism): the BROKER reuses the existing id
// for a known live PID. A new PID still mints fresh; a dead prior PID is still
// reaped. This is the only id-stability mechanism — the adapter does NOT
// re-stamp a fresh id, it just re-/registers and gets the same id back.
// GBA-9/GBA-8: /register both mints the peer's scope-token (returned in the
// response) and — on the re-register-of-a-live-PID reuse path — enforces the
// boot_id-echo anti-hijack. The outcome is a discriminated union so the caller
// can turn a `bootid_mismatch` in enforce mode into a 401.
type RegisterOutcome =
  | { ok: true; response: RegisterResponse }
  | { ok: false; status: BindStatus };

function handleRegister(body: RegisterRequest, mode: IdentityBindMode): RegisterOutcome {
  const now = new Date().toISOString();
  const presentedBootId = body.boot_id ?? "";
  const repoId = body.repo_id ?? "";
  const sessionId = body.session_id ?? "";

  // Look up any existing registration for this PID.
  const existing = db
    .query("SELECT id, pid, token, boot_id FROM peers WHERE pid = ?")
    .get(body.pid) as { id: string; pid: number; token: string; boot_id: string } | null;

  if (existing) {
    // Known PID. Reuse the id IF the process is still alive (a genuine
    // re-register of the same session — preserve identity). If the PID is dead
    // (a recycled PID now owned by a different process) reap the stale row and
    // mint fresh below.
    let pidAlive = true;
    try {
      process.kill(existing.pid, 0);
    } catch {
      pidAlive = false;
    }
    if (pidAlive) {
      // GBA-8 anti-hijack: a re-register for a live PID must echo the SAME
      // boot_id that first registered it. PID is not secret, so an attacker who
      // knows a victim's live PID could POST /register{pid:victimPid} and get
      // the victim's real id back — UNLESS they also present the victim's
      // boot_id (which they don't know). Only fires once the row is boot-bound
      // (existing.boot_id !== ''); a legitimate re-register from the same
      // process presents the same boot_id and passes.
      if (mode === "enforce" && existing.boot_id !== "") {
        if (presentedBootId !== existing.boot_id) {
          emitAudit("identity_mismatch", {
            path: "/register",
            claimed_id: existing.id,
            status: "bootid_mismatch",
            mode,
            phase: "reregister",
          });
          return { ok: false, status: "bootid_mismatch" };
        }
      } else if (
        mode === "warn" &&
        existing.boot_id !== "" &&
        presentedBootId !== "" &&
        presentedBootId !== existing.boot_id
      ) {
        emitAudit("identity_mismatch", {
          path: "/register",
          claimed_id: existing.id,
          status: "bootid_mismatch",
          mode,
          phase: "reregister",
        });
      }

      // Preserve the existing token (identity-stable across a broker blip); mint
      // one if the row predates GBA-9 (stored token ''). Same for boot_id: keep
      // the first-registered value, else adopt the presented one.
      const token = existing.token !== "" ? existing.token : generatePeerToken();
      const bootId = existing.boot_id !== "" ? existing.boot_id : presentedBootId;
      // Refresh the mutable fields in place; KEEP the id.
      db.run(
        "UPDATE peers SET cwd = ?, git_root = ?, tty = ?, profile = ?, host = ?, machine = ?, summary = ?, last_seen = ?, token = ?, boot_id = ?, repo_id = ?, session_id = ? WHERE id = ?",
        [
          body.cwd,
          body.git_root,
          body.tty,
          body.profile ?? "",
          body.host ?? "",
          body.machine ?? "",
          body.summary,
          now,
          token,
          bootId,
          repoId,
          sessionId,
          existing.id,
        ],
      );
      // Re-stamp the marker (idempotent — same filename + format).
      stampPeerIdFile(body.pid, existing.id, body.profile ?? "");
      return { ok: true, response: { id: existing.id, token } };
    }
    // Dead PID — recycled. Drop the stale row and fall through to mint fresh.
    deletePeer.run(existing.id);
  }

  const id = generateId();
  // GBA-9: mint the per-peer scope-token. Minting is unconditional (even in
  // off mode) so the column populates and enforcement can be flipped on later
  // without a re-register storm; the token is only VERIFIED when the flag is on.
  const token = generatePeerToken();
  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.profile ?? "",
    body.host ?? "",
    body.machine ?? "",
    body.summary,
    now,
    now,
    presentedBootId,
    token,
    repoId,
    sessionId,
  );
  // CONV-10613: pid-keyed peer-id marker backstop. server.ts also stamps from
  // inside the spawned session (the authoritative writer); this broker-side
  // write is belt-and-suspenders so the marker exists even if the session's
  // own stamp races or is skipped. Idempotent — same filename + format, so a
  // later server.ts overwrite is harmless. Best-effort; never blocks register.
  stampPeerIdFile(body.pid, id, body.profile ?? "");
  return { ok: true, response: { id, token } };
}

// Open-016 Phase 3 (CONV-10639): report whether this id is still known. The
// UPDATE is a no-op for an unknown id, so `changes === 0` means the broker has
// no record of this peer (e.g. it restarted) — the adapter re-/registers on
// that signal. `known` is the heartbeat's failed/not-registered detector.
function handleHeartbeat(body: HeartbeatRequest): HeartbeatResponse {
  const res = updateLastSeen.run(new Date().toISOString(), body.id);
  return { ok: true, known: res.changes > 0 };
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive.
  //
  // CROSS-REPO INVARIANT (GUPPI orchestrator.lock — Open-016 / CONV-10639):
  // this inline `process.kill(p.pid, 0)` PID-filter (together with the 30s
  // cleanStalePeers setInterval above) is the liveness guard the GUPPI
  // orch-lock harness-liveness self-release depends on. GUPPI's
  // lock._orch_harness_peer_present() trusts membership of THIS /list-peers
  // response as proof of PID-liveness and applies NO recency filter of its
  // own — so if this filter is weakened or removed, a dead orch is no longer
  // reaped promptly and the fail-CLOSED orch-lock can hang.
  //
  // The contract is regression-tested in the CONTROL-PLANE repo (NOT here),
  // in tests/orchestrator/test_lock.py. The live guards are
  // test_harness_peer_present_tri_state,
  // test_harness_peer_present_ignores_stale_orch_peer, and the dedicated
  // test_broker_membership_is_pid_filtered_contract — the last landed under
  // Open-016 Phase 3 (control-plane PR #286, merged) and directly asserts
  // that THIS /list-peers response is PID-filtered. Any change to this filter
  // (or the Phase-3c re-register id-reuse, which briefly removes-then-re-adds
  // a row) MUST be gated by running that control-plane suite — see plan §3a
  // cross-repo verification matrix.
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

const ALLOWED_KILL_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT"]);

function dropPeer(id: string): void {
  deletePeer.run(id);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
}

function handleKillPeer(body: KillPeerRequest): KillPeerResponse {
  const peer = db.query("SELECT id, pid FROM peers WHERE id = ?").get(body.to_id) as
    | { id: string; pid: number }
    | null;
  if (!peer) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }
  const signal = body.signal ?? "SIGTERM";
  if (!ALLOWED_KILL_SIGNALS.has(signal)) {
    return { ok: false, error: `Unsupported signal ${signal} (allowed: SIGTERM, SIGKILL, SIGINT)` };
  }
  const actor = body.from_id ?? null;
  try {
    process.kill(peer.pid, signal as NodeJS.Signals);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "ESRCH") {
      // Process is already gone — clean up the stale row and report success.
      dropPeer(peer.id);
      // A5 (Open-016, CONV-10639): mirror the Python guppi-mcp
      // kill_peer_dispatched envelope so a destructive cross-tier kill is at
      // least as observable as a keystroke. ESRCH = no signal actually
      // delivered; record the stale-clean outcome so audit doesn't imply a
      // live process was terminated. Never-raise (emitAudit is fire-and-forget).
      emitAudit("kill_peer_dispatched", {
        actor,
        target_peer_id: peer.id,
        target_pid: peer.pid,
        signal,
        result: "esrch_stale_cleaned",
      });
      return { ok: true, pid: peer.pid, error: "process already exited (stale peer cleaned)" };
    }
    emitAudit("kill_peer_dispatched", {
      actor,
      target_peer_id: peer.id,
      target_pid: peer.pid,
      signal,
      result: "error",
      detail: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      error: `kill(${peer.pid}, ${signal}) failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // Drop the peer so it disappears from list-peers immediately; the target's
  // own SIGTERM handler also calls /unregister (a no-op if we win the race).
  dropPeer(peer.id);
  console.error(`[claude-peers broker] kill ${peer.id} (pid ${peer.pid}, ${signal}) by ${actor ?? "?"}`);
  // A5: action-level audit envelope for the successful kill dispatch. This is
  // the irreversible, cross-tier branch — the one that most needs to be at
  // least as observable as a keystroke. Fire-and-forget; never blocks/raises.
  emitAudit("kill_peer_dispatched", {
    actor,
    target_peer_id: peer.id,
    target_pid: peer.pid,
    signal,
    result: "ok",
  });
  return { ok: true, pid: peer.pid };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- Phase 0 audit emit (aggregator-relay) ---
//
// broker.ts is dependency-free (stdlib only — node:crypto + bun:sqlite +
// bun:test in tests). Audit rows are POSTed to the guppi aggregator's
// /broker-audit-relay endpoint, which forwards to Supabase via the
// shared.audit_envelope.log_event_envelope primitive (T0.5 amended per
// CONV-9671 GAP-4; sibling Atlas #3058).
//
// Atlas #3136 (PR-A-FOLLOWUP-1) hardening:
//   - Default-off via CLAUDE_PEERS_RELAY_AUDIT_ENABLED — gate the emit
//     entirely during the PR-B gap window so PR-A solo-deploy doesn't
//     flood 401s against an unready receiver. Flip ON once both sides
//     are ready + CLAUDE_PEERS_HMAC_SECRET is provisioned.
//   - When enabled, every relay POST is HMAC-signed via buildRelayAuditHeaders
//     so the guppi receiver (enforce-mode verify pipeline) accepts it cleanly.
//
// Fail-open: any relay failure or missing-secret skip swallows to
// console.error.
function emitAudit(actionType: string, context: Record<string, unknown>, convId?: string): void {
  if (!relayAuditEnabled()) {
    // Default-off — no relay attempted. Removes the PR-B gap-window 401 flood.
    return;
  }
  const envelope = {
    script: "claude_peers_broker",
    action_type: actionType,
    conv_id: convId ?? null,
    details_envelope: {
      timestamp: new Date().toISOString(),
      context,
    },
  };
  const rawBody = JSON.stringify(envelope);
  const headers = buildRelayAuditHeaders(rawBody, { secret: HMAC_SECRET });
  if (!headers) {
    console.error(
      `[claude-peers broker] audit relay skipped: ${RELAY_AUDIT_FLAG_ENV} is on but CLAUDE_PEERS_HMAC_SECRET is unset`,
    );
    return;
  }
  // Fire-and-forget; do NOT await (would block broker request handling).
  fetch(AGGREGATOR_RELAY_URL, {
    method: "POST",
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(500),
  }).catch((e) => {
    console.error(`[claude-peers broker] audit relay failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

// --- Phase 0 HMAC middleware ---
//
// Returns null when the request is authenticated (or in "off"/"warn"
// mode with no secret configured). Returns a Response when the request
// should be short-circuited (401 in "enforce" mode + missing/invalid sig).
//
// Side effect: emits one of auth_failure / auth_success / auth_skipped per
// the workstream T0.5 substrate. The caller passes the raw body text so
// verify() can run against the same bytes the broker handler will consume.
function applyHmacMiddleware(
  req: Request,
  path: string,
  rawBody: string,
): Response | null {
  if (HMAC_MODE === "off") {
    return null;
  }

  const sig = req.headers.get("X-Claude-Peers-Auth") ?? "";
  const tsRaw = req.headers.get("X-Claude-Peers-Timestamp") ?? "";
  const anchor = req.headers.get("X-Claude-Peers-Session-Anchor") ?? "";
  const remote = req.headers.get("X-Forwarded-For") ?? "local";

  if (!sig || !tsRaw) {
    // Unsigned request.
    if (HMAC_MODE === "enforce") {
      emitAudit("auth_failure", { path, reason: "missing", remote, session_anchor: anchor });
      return Response.json({ error: "missing X-Claude-Peers-Auth or X-Claude-Peers-Timestamp" }, { status: 401 });
    }
    // warn mode — accept and observe.
    emitAudit("auth_skipped", { path, reason: "unsigned", remote, session_anchor: anchor });
    return null;
  }

  const ts = parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) {
    if (HMAC_MODE === "enforce") {
      emitAudit("auth_failure", { path, reason: "malformed_timestamp", remote, session_anchor: anchor });
      return Response.json({ error: "malformed X-Claude-Peers-Timestamp" }, { status: 401 });
    }
    emitAudit("auth_skipped", { path, reason: "malformed_timestamp", remote, session_anchor: anchor });
    return null;
  }

  if (!HMAC_SECRET) {
    // No secret configured — fail closed in enforce mode, warn-emit otherwise.
    if (HMAC_MODE === "enforce") {
      emitAudit("auth_failure", { path, reason: "no_secret_configured", remote, session_anchor: anchor });
      return Response.json({ error: "broker HMAC secret not configured" }, { status: 401 });
    }
    emitAudit("auth_skipped", { path, reason: "no_secret_configured", remote, session_anchor: anchor });
    return null;
  }

  if (verify(sig, rawBody, ts, HMAC_SECRET)) {
    emitAudit("auth_success", { path, remote, session_anchor: anchor });
    return null;
  }

  // Verification failed.
  if (HMAC_MODE === "enforce") {
    emitAudit("auth_failure", { path, reason: "invalid_signature", remote, session_anchor: anchor });
    return Response.json({ error: "invalid HMAC signature or expired timestamp" }, { status: 401 });
  }
  emitAudit("auth_skipped", { path, reason: "invalid_signature_warn_mode", remote, session_anchor: anchor });
  return null;
}

// --- S1 identity-binding middleware (GBA-7/8/9) ---
//
// Binds the body-claimed actor id on a write path to the per-peer credential
// the caller echoes (scope-token header + optional boot_id header). Gated by
// BROKER_IDENTITY_BIND_MODE (default off = byte-identical to today). Returns a
// 401 Response only in enforce mode on a mismatch for a BOUND peer; warn emits
// an audit event but accepts; off short-circuits before any DB read.

/** The body field carrying the actor id for each authenticated write path. */
function claimedActorId(path: string, body: unknown): string | null {
  const b = body as Record<string, unknown>;
  switch (path) {
    case "/send-message":
    case "/kill-peer":
      // Actor of the write. kill-peer's from_id is optional (advisory) — when
      // absent we cannot bind it, so the check is skipped for that request.
      return typeof b?.from_id === "string" ? b.from_id : null;
    case "/set-summary":
    case "/heartbeat":
    case "/unregister":
    case "/poll-messages":
      return typeof b?.id === "string" ? b.id : null;
    default:
      return null;
  }
}

function applyIdentityBinding(
  req: Request,
  path: string,
  claimedId: string | null,
): Response | null {
  if (IDENTITY_BIND_MODE === "off") {
    return null;
  }
  if (!claimedId) {
    // No actor id on this path (or an absent optional actor) — nothing to bind.
    return null;
  }

  const row = db.query("SELECT token, boot_id FROM peers WHERE id = ?").get(claimedId) as
    | { token: string; boot_id: string }
    | null;
  const storedToken = row?.token ?? "";
  const storedBootId = row?.boot_id ?? "";
  const presentedToken = req.headers.get(PEER_TOKEN_HEADER) ?? "";
  const presentedBootId = req.headers.get(BOOT_ID_HEADER) ?? "";

  const status = classifyBinding({
    storedToken,
    storedBootId,
    presentedToken,
    presentedBootId,
  });

  if (bindingAccepts(IDENTITY_BIND_MODE, status)) {
    // warn mode observes a mismatch but still accepts.
    if (IDENTITY_BIND_MODE === "warn" && isBindMismatch(status)) {
      emitAudit("identity_mismatch", { path, claimed_id: claimedId, status, mode: IDENTITY_BIND_MODE });
    }
    return null;
  }

  // enforce + mismatch → reject.
  emitAudit("identity_mismatch", { path, claimed_id: claimedId, status, mode: IDENTITY_BIND_MODE });
  return Response.json({ error: `identity binding failed: ${status}` }, { status: 401 });
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: BIND_HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        // /health stays unauthenticated for tunnel + launchd health checks.
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      // Read raw body text BEFORE JSON.parse so HMAC verification has the
      // same bytes the signer used. Subsequent JSON.parse picks the same
      // string up.
      const rawBody = await req.text();
      const authRejection = applyHmacMiddleware(req, path, rawBody);
      if (authRejection) {
        return authRejection;
      }
      const body = JSON.parse(rawBody);

      // S1 identity binding (GBA-7/8/9) — bind the body-claimed actor id to the
      // echoed per-peer credential. /register is handled inside its own case
      // (it needs the reuse-path boot_id anti-hijack + minting); every other
      // write path binds here. No-op when the flag is off.
      if (path !== "/register") {
        const bindRejection = applyIdentityBinding(req, path, claimedActorId(path, body));
        if (bindRejection) {
          return bindRejection;
        }
      }

      switch (path) {
        case "/register": {
          const outcome = handleRegister(body as RegisterRequest, IDENTITY_BIND_MODE);
          if (!outcome.ok) {
            return Response.json(
              { error: `identity binding failed: ${outcome.status}` },
              { status: 401 },
            );
          }
          return Response.json(outcome.response);
        }
        case "/heartbeat":
          return Response.json(handleHeartbeat(body as HeartbeatRequest));
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/kill-peer":
          return Response.json(handleKillPeer(body as KillPeerRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(
  `[claude-peers broker] listening on ${BIND_HOST}:${PORT} ` +
    `(db: ${DB_PATH}, hmac_mode: ${HMAC_MODE}, identity_bind_mode: ${IDENTITY_BIND_MODE})`,
);

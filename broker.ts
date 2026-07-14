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
import { chmodSync, existsSync } from "node:fs";
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
  BindOrchestratorRequest,
  BindOrchestratorResponse,
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
import {
  type RepoWallMode,
  type WallParticipant,
  classifyWall,
  isOrchestrator,
  isWalled,
  repoWallMode,
  wallAllows,
  walledSendContext,
} from "./shared/repo_wall";

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

// Repo-scoped message walls (CONV-10767) — an INDEPENDENT feature from identity
// binding above (separate flag, separate code path: applied at the SEND path,
// not as a per-request credential middleware). Three-state, DEFAULT OFF (mirrors
// BROKER_HMAC_MODE / BROKER_IDENTITY_BIND_MODE): off = byte-identical to today
// (no wall check at all); shadow = evaluate + log a would-reject but STILL
// DELIVER; enforce = reject a walled send. See shared/repo_wall.ts. Read once at
// boot; never flipped here.
const REPO_WALL_MODE: RepoWallMode = repoWallMode();

// --- Database setup ---

// Fix 3(a) (audit hardening, CONV-10767): a broker-CREATED DB file holds every
// peer's scope-token in plaintext, so lock it to owner-only (0600) at birth.
// Capture existence BEFORE opening — bun:sqlite creates the file in the
// constructor, so only a file WE just created is chmod'd here; a PRE-EXISTING
// DB (including the live ~/.claude-peers.db on a launchd respawn) is left
// untouched so we never silently re-permission an operator's file. Best-effort:
// a chmod failure must never block broker boot. Independent of the identity-bind
// flag (a plaintext-token DB should be owner-only in every mode).
const dbFileExistedBeforeOpen = existsSync(DB_PATH);
const db = new Database(DB_PATH);
if (!dbFileExistedBeforeOpen) {
  try {
    chmodSync(DB_PATH, 0o600);
  } catch (e) {
    console.error(
      `[claude-peers broker] could not chmod new DB to 0600: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
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
    display_name TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL DEFAULT '',
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
  // D-0060 (CONV-10767) — human-readable display columns via the same
  // probe-then-ALTER idiom as host/machine. Strictly additive, O(1) metadata-only
  // ADD COLUMN (no row rewrite), old rows get '' (= "no readable name" → the
  // list_peers render omits the Name/Slug line). PUBLIC, unlike `token` — they
  // ARE projected in PEER_COLUMNS below so peers can see each other's readable
  // names; they are NEVER a routing key.
  if (!cols.some((c) => c.name === "display_name")) {
    db.run("ALTER TABLE peers ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "slug")) {
    db.run("ALTER TABLE peers ADD COLUMN slug TEXT NOT NULL DEFAULT ''");
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
  // bind_orchestrator (CONV-10767) — strictly-additive `role` column via the same
  // probe-then-ALTER idiom as host/machine/display_name/boot_id. NOT NULL DEFAULT
  // '' → an old row (and every peer that never calls bind_orchestrator) reads ''
  // = "no bound role", byte-identical to today. Set to "orchestrator" only by the
  // bind_orchestrator self-op. This is the field repo_wall's isOrchestrator() and
  // the future lease model key off — a BOUND role the server asserts, not a
  // spoofable summary tag (see the PR's follow-on note). Unlike boot_id/repo_id it
  // is non-secret, so it IS projected in PEER_COLUMNS below.
  if (!cols.some((c) => c.name === "role")) {
    db.run("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT ''");
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
// off-contract, so they are excluded too. D-0060 display_name/slug ARE public
// Peer-type fields, so they ARE projected here (default '' → the list_peers
// render omits the Name/Slug line for an unlabeled peer, keeping its rendered
// output byte-identical to pre-D-0060).
// bind_orchestrator (CONV-10767) adds `role` here: it is a PUBLIC, non-secret
// "who is the orchestrator" signal (like display_name/slug), so peers may see it
// via /list-peers. It defaults '' (→ omitted from any render), keeping output
// byte-identical for an unbound peer. token/boot_id/repo_id/session_id remain
// OUT of this list (secret or off-contract — see the leak-regression tests).
const PEER_COLUMNS =
  "id, pid, cwd, git_root, tty, profile, host, machine, display_name, slug, role, summary, registered_at, last_seen";

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, profile, host, machine, display_name, slug, summary, registered_at, last_seen, boot_id, token, repo_id, session_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  | { ok: false; status: BindStatus }
  | { ok: false; badRequest: string };

// Fix 2 (audit hardening, CONV-10767): body.pid is untrusted JSON that flows
// into path.join via stampPeerIdFile → markerPath(`${pid}.peerid`); a string
// like "../../../evil" would normalise OUT of ~/.guppi/sessions and let a
// register call write a marker anywhere. POSIX pids are positive integers;
// 2^31-1 is a portable ceiling well above any real max_pid that still rejects
// overflow / absurd values. Reject anything that isn't a real pid BEFORE any
// path construction or DB lookup.
const MAX_PID = 2 ** 31 - 1;
function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function handleRegister(body: RegisterRequest, mode: IdentityBindMode): RegisterOutcome {
  // Fix 2: reject a malformed / path-like pid before it can reach path.join
  // (stampPeerIdFile) or the pid-keyed DB lookup below. Safe in ALL modes — a
  // non-integer / negative / zero / path-like pid was never a valid register.
  if (!isValidPid(body.pid)) {
    return {
      ok: false,
      badRequest: "invalid pid: must be a positive integer within OS pid range",
    };
  }
  const now = new Date().toISOString();
  const presentedBootId = body.boot_id ?? "";
  const repoId = body.repo_id ?? "";
  const sessionId = body.session_id ?? "";
  // D-0060 display fields — default '' when the peer registers without them
  // (byte-identical to today). Display-only; never consulted for routing.
  const displayName = body.display_name ?? "";
  const slug = body.slug ?? "";

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
      // D-0060: refresh display_name/slug in place too so a re-register (or a
      // broker blip that lands on the reuse path) never BLANKS a peer's readable
      // name — the peer re-presents the same values it cached from its env.
      db.run(
        "UPDATE peers SET cwd = ?, git_root = ?, tty = ?, profile = ?, host = ?, machine = ?, display_name = ?, slug = ?, summary = ?, last_seen = ?, token = ?, boot_id = ?, repo_id = ?, session_id = ? WHERE id = ?",
        [
          body.cwd,
          body.git_root,
          body.tty,
          body.profile ?? "",
          body.host ?? "",
          body.machine ?? "",
          displayName,
          slug,
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
    displayName,
    slug,
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
  // Fix 4 (audit note, CONV-10767): the `token` returned here is ALSO returned
  // at flag-off — intentionally. It is the enforce-readiness bootstrap: a peer
  // must cache + echo its token BEFORE the operator flips enforce, otherwise the
  // flip would mass-reject the live fleet. Returning it flag-off is inert today
  // (no path verifies it) and is the prerequisite for a no-re-register-storm
  // cutover. No behavior change.
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

  // Repo-scoped message wall (CONV-10767). No-op when the flag is off — the
  // helper short-circuits before any extra DB read, so off mode is byte-
  // identical to pre-CONV-10767 (target-existence check, then insert). In
  // enforce mode a walled send returns an ok:false refusal (same shape as the
  // target-not-found error above — a delivery refusal, NOT an auth failure) and
  // is NOT inserted. In shadow mode it is logged but still delivered.
  const walled = applyRepoWall(body);
  if (walled) {
    return walled;
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

// --- Repo-scoped message walls (CONV-10767) ---
//
// Load exactly the fields the wall needs for one side of a send. Returns null
// when the id is unknown to the broker (a missing sender/recipient row can't be
// classified). NOTE: `token`/`boot_id` are NEVER selected here — the wall is
// pure routing metadata (git_root + orch signals), no credential is read.
function loadWallParticipant(id: string): WallParticipant | null {
  const row = db
    .query("SELECT id, git_root, summary, profile FROM peers WHERE id = ?")
    .get(id) as { id: string; git_root: string | null; summary: string; profile: string } | null;
  if (!row) return null;
  return { id: row.id, git_root: row.git_root, is_orch: isOrchestrator(row) };
}

// Apply THE WALL RULE to a send. Returns an ok:false refusal ONLY in enforce
// mode on a walled send; returns null (deliver) in every other case. Gated by
// BROKER_REPO_WALL_MODE — off short-circuits before any lookup so the live bus
// stays byte-identical until the flag is flipped.
function applyRepoWall(
  body: SendMessageRequest,
): { ok: false; error: string } | null {
  if (REPO_WALL_MODE === "off") {
    return null;
  }

  const sender = loadWallParticipant(body.from_id);
  const recipient = loadWallParticipant(body.to_id);
  if (!sender || !recipient) {
    // Unknown sender or recipient — nothing to classify. Fail-open: never let
    // the wall block a send it can't reason about (recipient-not-found is
    // already handled by handleSendMessage's own existence check).
    return null;
  }

  const decision = classifyWall(sender, recipient);
  if (!isWalled(decision)) {
    // same-repo or orchestrators-room — allowed in every mode; deliver, no log.
    return null;
  }

  // Walled send. Emit a structured, secret-free line in BOTH shadow and enforce
  // (ids + git_roots + is_orch flags + reason + mode — NO message text, NO
  // token/boot_id). console.error is the broker's stderr log sink (goes to the
  // launchd broker log); emitAudit mirrors it to the aggregator relay when that
  // is enabled (default-off), for observability parity with identity binding.
  const context = walledSendContext(REPO_WALL_MODE, sender, recipient, decision);
  console.error(`[claude-peers broker] repo_wall ${JSON.stringify(context)}`);
  emitAudit("repo_wall_blocked", context);

  if (!wallAllows(REPO_WALL_MODE, decision)) {
    // enforce — refuse. Clear error to the sender; the message is NOT inserted.
    return {
      ok: false,
      error: `repo wall: cross-repo delivery blocked (${decision.reason})`,
    };
  }

  // shadow — logged as a would-reject, but STILL DELIVER.
  return null;
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

// --- bind_orchestrator (CONV-10767) — authoritative orchestrator self-bind ---
//
// The keystone of the orchestrator-boot-hardening. A booting orchestrator used
// to reconstruct its OWN peer id from ~6 scattered signals (env marker keyed by
// a wrong pid → tty → sqlite lookup) — the source of the self-collision bug. But
// the MCP server already knows its own id (`myId` — it created the row at
// /register), so it binds SELF authoritatively here.
//
// `id` is the CALLER'S OWN id (server.ts injects its myId). The op sets
// role="orchestrator", repo_id, boot_id on THAT row and echoes the peer id back.
// It is idempotent — a re-bind updates in place. It binds exactly the row named
// by `id` and nothing else; the MCP tool never lets a session name another id
// (it exposes only {repo_id, boot_id}), so a session can only bind ITSELF. That
// is the security property: identity is asserted by the server that owns the row.
//
// The written `role` column is what repo_wall's isOrchestrator() (which already
// checks role==="orchestrator" first) and the future lease model read — a BOUND
// role, not a spoofable summary tag. Wiring the wall's loadWallParticipant to
// SELECT this column is a small, tested follow-on (see the PR body); here we only
// ADD the column + the bind op, so this PR stays a clean substrate drop.
//
// boot_id: the value the caller asserts becomes the row's boot_id. In enforce
// mode (dormant/default-off) that column is the GBA-789 anti-hijack echo anchor,
// so a caller running under BROKER_IDENTITY_BIND_MODE=enforce should pass its own
// process boot_id (server.ts sends the tool's boot_id argument). This PR ships
// with the flag off, where the field is inert.
type BindOrchestratorOutcome =
  | { ok: true; response: BindOrchestratorResponse }
  | { ok: false; status: number; error: string };

function handleBindOrchestrator(body: BindOrchestratorRequest): BindOrchestratorOutcome {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    // No self id on the body — the server always injects myId, so a blank id is a
    // malformed request, never a silent no-op.
    return { ok: false, status: 400, error: "bind_orchestrator requires the caller's own peer id" };
  }
  const repoId = typeof body.repo_id === "string" ? body.repo_id : "";
  const bootId = typeof body.boot_id === "string" ? body.boot_id : "";

  const existing = db.query("SELECT id FROM peers WHERE id = ?").get(id) as { id: string } | null;
  if (!existing) {
    // Unknown id → 404. Never INSERT — bind only ever mutates an existing,
    // already-registered self row (no phantom rows).
    return { ok: false, status: 404, error: `Peer ${id} not found` };
  }

  db.run("UPDATE peers SET role = 'orchestrator', repo_id = ?, boot_id = ? WHERE id = ?", [
    repoId,
    bootId,
    id,
  ]);
  return { ok: true, response: { peer_id: id, repo_id: repoId, boot_id: bootId } };
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
      // Actor of the write — the from_id claimed as the sender.
      return typeof b?.from_id === "string" ? b.from_id : null;
    case "/set-summary":
    case "/heartbeat":
    case "/unregister":
    case "/poll-messages":
      return typeof b?.id === "string" ? b.id : null;
    default:
      // /kill-peer is deliberately NOT here: its from_id is advisory (and
      // optional), so binding on it authorizes nothing. It is authorized on the
      // TARGET's token instead — see authorizeKill (Fix 1).
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

// --- Fix 1 (audit hardening, CONV-10767): /kill-peer authorization ---
//
// /kill-peer was the one write path bound to NOTHING enforceable: its only
// "actor" is the OPTIONAL, advisory from_id, so a caller could simply omit
// from_id and evict ANY peer with ZERO credentials — even in enforce mode. A
// kill is destructive + irreversible, so we require the caller to prove
// authority over the TARGET: present to_id's own scope-token (and a matching
// boot_id if the target recorded one) — exactly as /unregister binds a peer on
// its own token before removing it. This is the target-token analog of
// applyIdentityBinding.
//
//   off     — no check (byte-identical to today; short-circuits before any DB read).
//   warn    — classify + emit an audit on a mismatch, but ALLOW the kill.
//   enforce — reject an unauthorized kill with 403 (Forbidden — an authorization
//             decision, distinct from the credential-binding 401s) and do NOT
//             dispatch the signal or drop the row.
//
// A target with no stored token ('' — unbound / pre-upgrade) is skipped in every
// mode (the same backward-tolerance the other paths use); a non-existent target
// is 'unbound' too, so it passes here and handleKillPeer returns its own
// not-found response.
//
// Residual (audit finding HIGH-2, ACCEPTED + documented in shared/identity_bind.ts):
// a same-user process that can read ~/.claude-peers.db can read the target's
// token and forge a valid kill. This fix raises the bar from zero-credential to
// must-hold-target-token, consistent with every other write path; it does not
// (and cannot) defend against read access to the broker's own DB file.
function authorizeKill(req: Request, body: KillPeerRequest): Response | null {
  if (IDENTITY_BIND_MODE === "off") {
    return null;
  }
  const targetId = typeof body?.to_id === "string" ? body.to_id : null;
  if (!targetId) {
    // No target id on the body — handleKillPeer returns its own not-found /
    // validation response; there is nothing to bind.
    return null;
  }

  const row = db.query("SELECT token, boot_id FROM peers WHERE id = ?").get(targetId) as
    | { token: string; boot_id: string }
    | null;
  const status = classifyBinding({
    storedToken: row?.token ?? "",
    storedBootId: row?.boot_id ?? "",
    presentedToken: req.headers.get(PEER_TOKEN_HEADER) ?? "",
    presentedBootId: req.headers.get(BOOT_ID_HEADER) ?? "",
  });
  const actor = typeof body?.from_id === "string" ? body.from_id : null;

  if (bindingAccepts(IDENTITY_BIND_MODE, status)) {
    // warn observes a mismatch but still allows the kill.
    if (IDENTITY_BIND_MODE === "warn" && isBindMismatch(status)) {
      emitAudit("kill_peer_unauthorized", {
        path: "/kill-peer",
        target_peer_id: targetId,
        actor,
        status,
        mode: IDENTITY_BIND_MODE,
        outcome: "warn_allowed",
      });
    }
    return null;
  }

  // enforce + mismatch/missing → refuse BEFORE any process.kill / dropPeer.
  emitAudit("kill_peer_unauthorized", {
    path: "/kill-peer",
    target_peer_id: targetId,
    actor,
    status,
    mode: IDENTITY_BIND_MODE,
    outcome: "rejected",
  });
  return Response.json(
    {
      ok: false,
      error: `kill unauthorized: ${status} (present the target peer's ${PEER_TOKEN_HEADER})`,
    },
    { status: 403 },
  );
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

      // Fix 1: /kill-peer is authorized on the TARGET's token (see authorizeKill),
      // not the advisory from_id, so it is bound here rather than via the generic
      // actor-id path above. No-op when the flag is off.
      if (path === "/kill-peer") {
        const killRejection = authorizeKill(req, body as KillPeerRequest);
        if (killRejection) {
          return killRejection;
        }
      }

      switch (path) {
        case "/register": {
          const outcome = handleRegister(body as RegisterRequest, IDENTITY_BIND_MODE);
          if (!outcome.ok) {
            if ("badRequest" in outcome) {
              // Fix 2: malformed pid — a client error, not an auth failure.
              return Response.json({ error: outcome.badRequest }, { status: 400 });
            }
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
        case "/bind-orchestrator": {
          // bind_orchestrator (CONV-10767) — self-bind role/repo_id/boot_id. The
          // `id` is the caller's own myId (server-injected); the op mutates only
          // that row. Not wired into the identity-bind middleware (claimedActorId)
          // in this PR — the self-only guarantee is provided at the MCP-tool layer
          // (no target-id parameter); a lease-model authority check is the follow-on.
          const outcome = handleBindOrchestrator(body as BindOrchestratorRequest);
          if (!outcome.ok) {
            return Response.json({ error: outcome.error }, { status: outcome.status });
          }
          return Response.json(outcome.response);
        }
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
    `(db: ${DB_PATH}, hmac_mode: ${HMAC_MODE}, identity_bind_mode: ${IDENTITY_BIND_MODE}, ` +
    `repo_wall_mode: ${REPO_WALL_MODE})`,
);

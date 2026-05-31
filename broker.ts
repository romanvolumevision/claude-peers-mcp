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
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migrate existing databases: add `profile` column if missing.
// SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so we probe pragma_table_info.
{
  const cols = db.query("PRAGMA table_info(peers)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "profile")) {
    db.run("ALTER TABLE peers ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
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

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, profile, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
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

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.profile ?? "",
    body.summary,
    now,
    now,
  );
  // CONV-10613: pid-keyed peer-id marker backstop. server.ts also stamps from
  // inside the spawned session (the authoritative writer); this broker-side
  // write is belt-and-suspenders so the marker exists even if the session's
  // own stamp races or is skipped. Idempotent — same filename + format, so a
  // later server.ts overwrite is harmless. Best-effort; never blocks register.
  stampPeerIdFile(body.pid, id, body.profile ?? "");
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
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

  // Verify each peer's process is still alive
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
  try {
    process.kill(peer.pid, signal as NodeJS.Signals);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "ESRCH") {
      // Process is already gone — clean up the stale row and report success.
      dropPeer(peer.id);
      return { ok: true, pid: peer.pid, error: "process already exited (stale peer cleaned)" };
    }
    return {
      ok: false,
      error: `kill(${peer.pid}, ${signal}) failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // Drop the peer so it disappears from list-peers immediately; the target's
  // own SIGTERM handler also calls /unregister (a no-op if we win the race).
  dropPeer(peer.id);
  console.error(`[claude-peers broker] kill ${peer.id} (pid ${peer.pid}, ${signal}) by ${body.from_id ?? "?"}`);
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

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
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
    `(db: ${DB_PATH}, hmac_mode: ${HMAC_MODE})`,
);

// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  profile: string; // iTerm2 dynamic-profile name (from ITERM_PROFILE env), "" if unset
  host: string; // client app hosting the session: "VS Code", "iTerm", "Terminal", "tmux", … ("" if undetected)
  machine: string; // physical machine: "MacBook", "Forge", … (GUPPI_SURFACE / hostname-derived; "" if undetected)
  // D-0060 human-readable display fields (CONV-10767). DISPLAY-ONLY — never a
  // routing key: the opaque `id` stays the sole FK across send/kill/heartbeat/
  // set_summary and the GUPPI orch-lock holder_id. Both default '' so a peer
  // that registers WITHOUT them (no GUPPI_PEER_LABEL in env) is byte-identical
  // to today. The naming grammar lives ONCE in the GUPPI Python peer_names.py
  // (compose_peer_name / peer_id_slug); the composed strings are injected into
  // the session env and transported here VERBATIM — TS never re-implements it.
  //   display_name — full readable label, e.g. "🟢 Green · P1 · Uma — offplan".
  //   slug         — deterministic short handle, e.g. "offplan-g1-uma".
  display_name: string;
  slug: string;
  // bind_orchestrator (CONV-10767) — the peer's bound role. '' for a normal peer
  // (and for any row that predates the migration); "orchestrator" once the peer
  // has authoritatively bound itself via bind_orchestrator. PUBLIC + non-secret
  // (unlike token/boot_id/repo_id) — it IS projected via /list-peers so peers can
  // see who the orchestrator is; it is NEVER a routing key. Optional so an
  // un-upgraded broker (or a synthetic Peer literal) that omits it is unaffected.
  role?: string;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  profile: string;
  host?: string;
  machine?: string;
  // D-0060 (CONV-10767) — optional, back-compat display fields. An un-upgraded
  // server.ts omits them; the broker stores '' (byte-identical to today). Never
  // a routing key — see the Peer-type note above.
  display_name?: string;
  slug?: string;
  summary: string;
  // S1 broker hardening (GBA-7/8/9) — all optional + backward-tolerant (an
  // un-upgraded server.ts omits them; the broker stores '' and the identity
  // binding treats an empty stored token as "unbound → skip").
  //   boot_id    — per-process random id (GBA-8); stored + echoed to defeat the
  //                PID-spoof /register hijack and stale-row impersonation.
  //   repo_id    — future repo-scoping key (GBA-7); stored, not yet enforced.
  //   session_id — future session-scoping key (GBA-7); stored, not yet enforced.
  boot_id?: string;
  repo_id?: string;
  session_id?: string;
}

export interface RegisterResponse {
  id: PeerId;
  // GBA-9 scope-token minted by the broker at /register. Optional so older
  // consumers that only read `id` are unaffected; server.ts (PR-B) caches it
  // and echoes it via X-Claude-Peers-Peer-Token on subsequent writes.
  token?: string;
}

export interface HeartbeatRequest {
  id: PeerId;
}

// Open-016 Phase 3 (CONV-10639): the heartbeat response now reports whether the
// broker still knows this peer id. After a broker restart the adapter is alive
// but registered nowhere; `known: false` is the signal the adapter uses to
// re-`/register` (preserving its id via the broker's reuse-id-for-known-PID
// path). Optional so older brokers stay backward-tolerant — the adapter treats
// a missing field as "known" and won't churn re-registrations against them.
export interface HeartbeatResponse {
  ok: true;
  known?: boolean;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

// Remote peer-terminate. The broker looks the peer up by id, sends `signal`
// (default SIGTERM) to its PID, and drops the row so it leaves list-peers
// immediately. `from_id` is advisory (audit/log only).
export interface KillPeerRequest {
  from_id?: PeerId;
  to_id: PeerId;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT";
}

export interface KillPeerResponse {
  ok: boolean;
  error?: string;
  pid?: number;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// bind_orchestrator (CONV-10767) — the orchestrator-boot-hardening keystone.
//
// A booting orchestrator no longer reconstructs its own peer id from scattered
// signals: the MCP server already knows its own id (it created the row at
// /register), so it binds SELF authoritatively.
//
// `id` is the CALLER'S OWN id — server.ts injects its `myId`. It is NOT a
// caller-chosen target: the MCP tool that fronts this op exposes only
// {repo_id, boot_id} (no id parameter), so a session can bind ITSELF and nothing
// else. That is the security property — identity is asserted by the server that
// owns the row, not reconstructed or claimed.
export interface BindOrchestratorRequest {
  id: PeerId;
  repo_id: string;
  boot_id: string;
}

// The authoritative self peer id echoed back, plus the bound scope fields.
export interface BindOrchestratorResponse {
  peer_id: PeerId;
  repo_id: string;
  boot_id: string;
}

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
  // repo_root — the NORMALIZED main-worktree root (CONV-10767 worktree fix). A
  // repo and ALL its linked worktrees resolve to the SAME repo_root (the main
  // working tree), so a peer running in a per-colour git WORKTREE (git_root = the
  // worktree path) and the repo's main-checkout orchestrator classify into the
  // SAME repo room. PUBLIC + non-secret (like display_name/slug/role) — it IS
  // projected via /list-peers. Optional / '' for a LEGACY row that predates the
  // column; the wall falls back to git_root in that case. NEVER a routing key.
  repo_root?: string | null;
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
  // repo_root (CONV-10767 worktree fix) — the normalized main-worktree root the
  // peer computes at registration (server.ts resolveRepoRoot). Optional +
  // back-compat: an un-upgraded server.ts omits it; the broker stores '' and the
  // wall falls back to git_root. Never a routing key — see the Peer-type note.
  repo_root?: string | null;
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

// board-272 / #2041: the disposition of a kill. `session` = the claude harness
// pid was resolved (via the registered adapter's PPID chain) and signalled — the
// tab actually dies. `sibling_only` = NO claude ancestor resolved, so only the
// registered MCP-adapter pid was signalled and the SESSION LIKELY SURVIVES (the
// caller must not treat this as a session death). `stale` = the registered pid
// was already gone (ESRCH) and the row was cleaned.
export type KillDisposition = "session" | "sibling_only" | "stale";

export interface KillPeerResponse {
  ok: boolean;
  error?: string;
  // The pid actually signalled: the harness pid on a `session` kill, else the
  // registered adapter pid. Kept as the primary field for backward compatibility.
  pid?: number;
  // board-272 / #2041 — LOUD kill provenance so a caller can never mistake a
  // sibling kill for a session kill. All optional → an old client ignores them.
  killed?: KillDisposition;
  harness_pid?: number; // resolved claude harness pid (present iff killed === "session")
  registered_pid?: number; // the broker-row pid = the MCP adapter sibling
  note?: string; // human-readable; LOUD on `sibling_only`
}

export interface PollMessagesRequest {
  id: PeerId;
  // board-10 / #3567 long-poll (CONV-11507) — the max ms the broker may HOLD an
  // empty poll open before returning, waiting for an insert for this peer.
  // Optional + backward-tolerant: an OLD client omits it → the broker does not
  // hold (immediate return, byte-identical to the pre-long-poll broker); an OLD
  // broker ignores it → the client sees no `long_poll` flag and falls back to
  // interval polling. Broker-side clamped to [0, max]. Never a routing key.
  wait_ms?: number;
}

export interface PollMessagesResponse {
  messages: Message[];
  // board-10 / #3567 (CONV-11507) — set true ONLY by a long-poll-capable broker
  // when the client opted in (sent a positive wait_ms). It is the client's
  // capability signal: true → re-poll immediately (continuous long-poll); absent
  // (an old broker, or a non-opted-in poll) → the client keeps its interval
  // floor. Optional so an old broker that never sets it stays byte-compatible.
  long_poll?: boolean;
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

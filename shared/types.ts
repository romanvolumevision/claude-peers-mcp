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

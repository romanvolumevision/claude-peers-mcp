// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  profile: string; // iTerm2 dynamic-profile name (from ITERM_PROFILE env), "" if unset
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
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
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

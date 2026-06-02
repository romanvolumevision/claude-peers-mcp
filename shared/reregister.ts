/**
 * Open-016 Phase 3b (CONV-10639) — re-register-on-broker-loss decision logic.
 *
 * The per-session stdio adapter (`server.ts`) registers with the broker ONCE
 * at startup. After a broker restart the adapter is still alive but registered
 * NOWHERE — its poll/heartbeat just silently no-op, so it lingers blind (the
 * CONV-10639 "claude-peers seems broken" silent strand). This module holds the
 * pure predicate that decides when to re-`/register`, kept separate from the
 * server's I/O so it is unit-testable without booting the stdio MCP / broker.
 *
 * The actual re-register (re-POST /register, update myId, re-stamp) lives in
 * server.ts; the broker preserves the id for a known live PID (Phase 3c), so a
 * re-register is identity-stable.
 */

import type { HeartbeatResponse } from "./types.ts";

/**
 * True when the broker has explicitly told us it no longer knows this peer id
 * (`known === false`), which is the "broker restarted / forgot me" signal.
 *
 * A heartbeat response with no `known` field (an older broker that predates
 * Open-016) is treated as "still known" so the adapter never churns
 * re-registrations against a broker that can't report membership. A `known:
 * true` likewise means no action.
 */
export function shouldReRegister(resp: HeartbeatResponse | null | undefined): boolean {
  return resp?.known === false;
}

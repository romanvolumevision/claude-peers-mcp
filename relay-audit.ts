/**
 * relay-audit.ts — HMAC signing + feature-flag gate for the broker's
 * /broker-audit-relay POST.
 *
 * Atlas #3136 (PR-A-FOLLOWUP-1) — cross-repo with guppi PR-B.2.
 * Closes the wire-level injection / unsigned-relay window flagged at
 * Council Rev 2 C-SEC-1 (cross-org-broker-phase-0b plan).
 *
 * Public surface:
 *   - RELAY_AUDIT_FLAG_ENV — canonical env-var name (string constant).
 *   - relayAuditEnabled(env?) — boolean gate; reads env-var (default-off).
 *   - buildRelayAuditHeaders(rawBody, opts?) — returns signed headers dict,
 *     or null when secret unavailable.
 *
 * Flag semantics (per Atlas #3136 details + orch CONV-9070 routing
 * 2026-05-19T00:52Z): default-off so PR-A (claude-peers-mcp) ships solo
 * without flooding /broker-audit-relay 401s during the PR-B gap window.
 * Operators flip ON once PR-B (guppi /broker-audit-relay endpoint) is
 * deployed AND CLAUDE_PEERS_HMAC_SECRET is provisioned.
 *
 * Truthy values (case-insensitive): "1", "true", "yes", "on".
 *
 * Cross-references:
 *   - Atlas #3136 (cross-repo HMAC sign on relay POST)
 *   - guppi workstream: cross-org-broker-phase-0b-guppi-consumer-side.md
 *   - guppi PR #76 (PR-B.1 consumer-side HMAC verify)
 *   - sibling auth.ts (Phase 0 broker-auth-substrate Atlas #2904)
 *   - origin: Pink CONV-9989 2026-05-19.
 */

export const RELAY_AUDIT_FLAG_ENV = "CLAUDE_PEERS_RELAY_AUDIT_ENABLED";

export interface BuildRelayAuditHeadersOpts {
  ts?: number;
  secret?: string;
  sessionAnchor?: string;
}

export function relayAuditEnabled(
  _env: Record<string, string | undefined> = process.env,
): boolean {
  // STUB — Atlas #3136 implementation pending (RED commit).
  return false;
}

export function buildRelayAuditHeaders(
  _rawBody: string,
  _opts: BuildRelayAuditHeadersOpts = {},
): Record<string, string> | null {
  // STUB — Atlas #3136 implementation pending (RED commit).
  return null;
}

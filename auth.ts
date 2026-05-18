/**
 * HMAC sign/verify primitives for the claude-peers broker authentication
 * substrate.
 *
 * Phase 0 broker-auth-substrate (guppi workstream
 * `cross-org-broker-phase-0-broker-auth-substrate.md` T0.2; Atlas #2904).
 *
 * Public surface:
 *   - sign(body, timestamp, secret) — HMAC-SHA256 hex digest over
 *     `${timestamp}:${body}` canonical form.
 *   - verify(signature, body, timestamp, secret) — constant-time hex compare
 *     plus a 5-minute timestamp-skew window.
 *   - MAX_TIMESTAMP_SKEW_SEC — exported for callers + tests (300s per plan
 *     §Decision 8).
 *
 * Canonical signed message for Phase 0 (minimal):
 *
 *     timestamp + ":" + body
 *
 * Phase 1+ extension (per plan body §Decision 8 replay-protection tuple):
 *   `(nonce, timestamp, session_anchor)` will extend the canonical form to
 *   `timestamp + ":" + nonce + ":" + session_anchor + ":" + body`. The
 *   broker middleware (T0.3) will adopt the extended form; this module
 *   exports `signEnvelope` / `verifyEnvelope` once that lands.
 *
 * Threat model:
 *   - Closes wire-level injection (signature over body protects against
 *     mutation by anyone without the shared secret).
 *   - Closes timestamp replay outside the 5-minute window.
 *   - Does NOT close same-UID attacker (out-of-scope MVP; UDS+SO_PEERCRED
 *     scoped for Phase 1.2 follow-on per plan body honest threat model).
 *
 * Constant-time guarantee:
 *   - `crypto.timingSafeEqual` (Node/Bun built-in) compares byte buffers
 *     in fixed time. We convert hex strings to Buffers and call it.
 *   - Length-prefix early-return is fine — leaking the length of an
 *     attacker's claimed signature is not exploitable (length is public
 *     information; SHA-256 outputs are always 32 bytes / 64 hex chars).
 *
 * Cross-references:
 *   - Workstream: cross-org-broker-phase-0-broker-auth-substrate.md (Rev 2)
 *   - Plan: plans/cross-org-peer-broker-substrate.md §Phase 0
 *   - Atlas #2904 (parent), #3057 (op:// bootstrap dep), #3058 (relay endpoint)
 *   - Origin: 🩷 Pink CONV-9671 2026-05-18.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Plan body §Decision 8 — 5-minute timestamp-skew window. */
export const MAX_TIMESTAMP_SKEW_SEC = 300;

/** Length of an HMAC-SHA256 hex digest. */
const HEX_DIGEST_LEN = 64;
const HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Sign a request body with HMAC-SHA256.
 *
 * @param body — request body as a string (caller is responsible for
 *               canonical JSON serialisation — e.g. stable key order).
 * @param timestamp — UNIX seconds at the moment of signing.
 * @param secret — shared HMAC secret (rotated via Phase 0 T0.8 bootstrap).
 * @returns 64-char lowercase hex digest.
 */
export function sign(body: string, timestamp: number, secret: string): string {
  const canonical = `${timestamp}:${body}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Verify an HMAC signature against a request body + claimed timestamp.
 *
 * Returns `false` (never throws) on any failure mode:
 *   - Signature not 64 lowercase hex chars
 *   - Body tampered
 *   - Wrong secret
 *   - Timestamp skew exceeds {@link MAX_TIMESTAMP_SKEW_SEC} (compared
 *     against the current wall clock — caller supplies the *claimed*
 *     timestamp from the request header).
 *
 * @param signature — claimed signature from request header.
 * @param body — request body as a string.
 * @param timestamp — claimed UNIX seconds from request header.
 * @param secret — shared HMAC secret.
 * @returns true iff signature is valid + timestamp within window.
 */
export function verify(
  signature: string,
  body: string,
  timestamp: number,
  secret: string,
): boolean {
  // Length + format gate — Buffer.from with hex encoding silently truncates
  // on invalid input, so we validate the regex first.
  if (typeof signature !== "string" || signature.length !== HEX_DIGEST_LEN) {
    return false;
  }
  if (!HEX_REGEX.test(signature)) {
    return false;
  }

  // Timestamp skew gate — compare claimed timestamp against current clock.
  // Use abs so both past-skew (replay) and future-skew (clock-drift attacker)
  // are rejected.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > MAX_TIMESTAMP_SKEW_SEC) {
    return false;
  }

  // Compute the expected signature and compare in constant time.
  const expected = sign(body, timestamp, secret);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

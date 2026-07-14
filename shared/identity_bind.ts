/**
 * identity_bind.ts — per-peer identity-binding primitives for the claude-peers
 * broker (S1 broker hardening — GBA-7 / GBA-8 / GBA-9).
 *
 * Motivation (recon GBA-7): the broker binds NOTHING to the transport. Every
 * write path trusts whatever id the JSON body claims — `from_id` on
 * /send-message and /kill-peer, `id` on /set-summary /heartbeat /unregister
 * /poll-messages. HMAC (auth.ts) only proves the caller knows the machine-wide
 * shared secret; it cannot tell peer A from peer B (they all hold the same
 * secret). So any local process can forge a message from, keep-alive, evict,
 * or drain the inbox of any peer by claiming its id.
 *
 * The fix is a per-peer credential the broker can bind the claimed id against:
 *   - GBA-9 scope-token: at /register the broker MINTS a per-peer secret token,
 *     stores it, and returns it in RegisterResponse. On every subsequent write
 *     the peer echoes that token (via the {@link PEER_TOKEN_HEADER}). The broker
 *     verifies token↔claimed-id.
 *   - GBA-8 boot_id-echo: server.ts generates a per-process random boot_id at
 *     startup, sends it on /register (stored) and echoes it on every request
 *     (via {@link BOOT_ID_HEADER}). The broker requires an echoed boot_id to
 *     match the stored value — this defeats the PID-spoof /register hijack (an
 *     attacker who knows a victim's live PID does NOT know its boot_id) and
 *     stale-row impersonation.
 *
 * Rollout is the proven two-sided, three-state pattern already shipped in this
 * repo for BROKER_HMAC_MODE (broker.ts) and CLAUDE_PEERS_RELAY_AUDIT_ENABLED
 * (relay-audit.ts):
 *   BROKER_IDENTITY_BIND_MODE = off | warn | enforce   (default: off)
 *     off     — byte-identical to today: no checks, claimed id accepted verbatim.
 *     warn    — perform the check + emit an identity_mismatch audit on a
 *               mismatch, but ACCEPT the request (observe-only).
 *     enforce — reject (401) a mismatch / missing credential for a BOUND peer.
 *
 * Backward tolerance (the `known?`-absent precedent, shared/types.ts): a peer
 * with an empty stored token ('' — an un-upgraded server.ts that never echoed,
 * or a row from before this migration) is "unbound" and is SKIPPED (accepted)
 * in every mode. Enforcement only bites peers that actually minted a token.
 * This is what lets the broker land flag-off first, server.ts populate second,
 * and the operator flip warn→enforce last — no flag flip is done here.
 *
 * This module is pure/stdlib-only (node:crypto) so the classify + policy logic
 * is unit-testable without booting the broker.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THREAT MODEL — what enforce mode DOES and does NOT defend against
 * (audit finding HIGH-2, CONV-10767 — an honest, documented, ACCEPTED residual).
 *
 * DEFENDS AGAINST: a DIFFERENT-USER or sandboxed local process that does NOT
 * have read access to the broker's DB file. Such a process cannot learn a
 * victim peer's scope-token or boot_id, so in enforce mode it cannot forge a
 * bound peer's writes (send-message / set-summary / heartbeat / unregister /
 * poll-messages) and cannot kill a bound peer (kill-peer binds on the TARGET's
 * token) — it holds no valid credential.
 *
 * DOES NOT DEFEND AGAINST: a SAME-USER process that can read ~/.claude-peers.db.
 * The per-peer token is stored in that SQLite file in PLAINTEXT, so any process
 * running as the broker's own user can read a target's token straight out of the
 * DB and present it as a valid credential. This is an ACCEPTED, documented
 * residual: the tokens are bearer credentials over a localhost broker, not a
 * defense against an attacker who already holds the broker's on-disk state. The
 * broker narrows the exposure by creating the DB file mode 0600 / owner-only
 * (broker.ts Fix 3(a)), but a process running AS that owner is by definition
 * inside the trust boundary.
 *
 * Net effect: the credential model raises the bar from "any local process can
 * spoof/evict any peer with ZERO credentials" to "must present the target's
 * token" — a meaningful reduction — WITHOUT claiming to stop a same-user
 * attacker with DB read access. Do not represent it as the latter.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Canonical env-var controlling identity-binding enforcement. */
export const IDENTITY_BIND_FLAG_ENV = "BROKER_IDENTITY_BIND_MODE";

/** Header a peer attaches to echo its minted scope-token (GBA-9). */
export const PEER_TOKEN_HEADER = "X-Claude-Peers-Peer-Token";

/** Header a peer attaches to echo its per-process boot_id (GBA-8). */
export const BOOT_ID_HEADER = "X-Claude-Peers-Boot-Id";

export type IdentityBindMode = "off" | "warn" | "enforce";

/**
 * Resolve the enforcement mode from the environment. Anything other than
 * "warn"/"enforce" (including unset, empty, junk) resolves to "off" — the
 * safe, byte-identical-to-today default.
 */
export function identityBindMode(
  env: Record<string, string | undefined> = process.env,
): IdentityBindMode {
  const raw = (env[IDENTITY_BIND_FLAG_ENV] ?? "off").trim().toLowerCase();
  return raw === "warn" || raw === "enforce" ? raw : "off";
}

/** Mint a per-peer scope-token (GBA-9): 32 random bytes as 64 hex chars. */
export function generatePeerToken(): string {
  return randomBytes(32).toString("hex");
}

/** Generate a per-process boot_id (GBA-8): 16 random bytes as 32 hex chars. */
export function generateBootId(): string {
  return randomBytes(16).toString("hex");
}

export type BindStatus =
  | "match" // credential present and correct
  | "unbound" // peer has no stored token → nothing to bind (pre-upgrade tolerance)
  | "token_missing" // bound peer, but no token echoed
  | "token_mismatch" // bound peer, wrong token echoed
  | "bootid_mismatch"; // a boot_id was echoed but does not match the stored one

export interface BindInput {
  /** Token stored for the claimed peer id ('' = unbound / un-upgraded). */
  storedToken: string;
  /** boot_id stored for the claimed peer id ('' = none recorded). */
  storedBootId: string;
  /** Token echoed by the caller ('' = none presented). */
  presentedToken: string;
  /** boot_id echoed by the caller ('' = none presented). */
  presentedBootId: string;
}

/** Constant-time string compare; false on any length mismatch or empty input. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || a.length !== b.length) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Classify a claimed-id request against the stored credential for that id.
 * Pure — the caller ({@link bindingAccepts}) applies the mode policy.
 *
 * GBA-8 boot_id-echo is evaluated first and unconditionally: if a boot_id is
 * echoed at all it MUST match the stored one — even for an otherwise-unbound
 * peer — so the echo can corroborate identity on the /register-reuse path where
 * no token is presented yet.
 */
export function classifyBinding(input: BindInput): BindStatus {
  if (input.presentedBootId !== "") {
    if (
      input.storedBootId === "" ||
      !constantTimeEqual(input.presentedBootId, input.storedBootId)
    ) {
      return "bootid_mismatch";
    }
  }
  const bound = input.storedToken !== "";
  if (!bound) return "unbound";
  if (input.presentedToken === "") return "token_missing";
  if (!constantTimeEqual(input.presentedToken, input.storedToken)) {
    return "token_mismatch";
  }
  return "match";
}

/**
 * Policy gate: should a request with the given {@link BindStatus} be ACCEPTED
 * under `mode`?
 *   - off      → always accept (byte-identical to today).
 *   - warn     → always accept (observe-only; the caller emits an audit event
 *                on a non-match/non-unbound status).
 *   - enforce  → accept only "match" (correct credential) or "unbound"
 *                (pre-upgrade peer with no token to bind); reject every
 *                mismatch / missing-credential status.
 */
export function bindingAccepts(mode: IdentityBindMode, status: BindStatus): boolean {
  if (mode === "off" || mode === "warn") return true;
  return status === "match" || status === "unbound";
}

/** True when a status is worth emitting an identity_mismatch audit event. */
export function isBindMismatch(status: BindStatus): boolean {
  return status !== "match" && status !== "unbound";
}

/**
 * GBA-9 publish helper: build the header dict a peer attaches to publish/write
 * requests so the broker can bind its claimed id. Backward-tolerant — empty
 * values are omitted so an un-upgraded / token-less caller sends nothing new
 * (the broker treats the absence as "unbound → skip" per the tolerance rule).
 */
export function buildIdentityHeaders(
  token: string,
  bootId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers[PEER_TOKEN_HEADER] = token;
  if (bootId) headers[BOOT_ID_HEADER] = bootId;
  return headers;
}

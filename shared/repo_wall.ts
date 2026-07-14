/**
 * repo_wall.ts — repo-scoped message-delivery walls for the claude-peers broker
 * (CONV-10767).
 *
 * Motivation: the broker is a single machine-wide bus. Today ANY peer can
 * send_message to ANY other peer regardless of which repo each is working in.
 * As the fleet spans multiple repos concurrently, cross-repo chatter is both
 * noise and a small blast-radius risk (a peer in repo A can poke a peer in
 * repo B). "Repo walls" scope delivery so peers only talk within their own
 * repo — with a deliberate exception for orchestrators, who need a cross-repo
 * back-channel to coordinate the fleet.
 *
 * ── TARGET TOPOLOGY (operator-confirmed) ────────────────────────────────────
 * Two kinds of "room":
 *   (a) each repo is a room — the repo's orchestrator + all its peers, FULL
 *       MESH (orch↔peer AND peer↔peer) within the SAME git_root.
 *   (b) an "orchestrators room" — orchestrators across DIFFERENT repos may
 *       message each other.
 *
 * THE WALL RULE for delivering a message from sender S to recipient R:
 *   ALLOW iff  (S.git_root == R.git_root)  OR  (S is orch AND R is orch).
 *   Otherwise REJECT.
 *
 * So: a peer reaches same-repo peers + its own orch; an orchestrator reaches
 * its own repo's peers + ALL other orchestrators; a peer can NEVER reach
 * another repo's peers or orch.
 *
 * ── ROLLOUT — three-state, DEFAULT OFF ──────────────────────────────────────
 * This is an INDEPENDENT feature from the S1 identity-binding work
 * (BROKER_IDENTITY_BIND_MODE, shared/identity_bind.ts): a separate flag and a
 * separate code path (the wall is applied at the SEND path; identity binding is
 * a per-request credential middleware). It intentionally mirrors that module's
 * proven flag/observe/enforce shape:
 *   BROKER_REPO_WALL_MODE = off | shadow | enforce   (default: off)
 *     off     — byte-identical to today: NO wall check at all; every send
 *               delivers. The broker short-circuits before any extra DB read.
 *     shadow  — evaluate the wall; if it WOULD reject, emit a structured log
 *               line (ids + git_roots + is_orch flags — NO message text, NO
 *               secrets), but STILL DELIVER. Observe-only.
 *     enforce — reject a walled send (clear error to the sender; NOT delivered).
 *
 * This module is pure/stdlib-only so the classify + policy logic is
 * unit-testable without booting the broker. The broker wires it into
 * handleSendMessage.
 */

import { profileToChannel } from "./tabtitle.ts";

/** Canonical env-var controlling the repo wall. */
export const REPO_WALL_FLAG_ENV = "BROKER_REPO_WALL_MODE";

/**
 * The summary tag convention that marks an orchestrator session. A session whose
 * summary starts with this prefix (e.g. "🐙 ORCH …" or "🐙 ORCHESTRATOR …") is
 * treated as an orchestrator. This is the just-added tag convention and is the
 * fallback signal when no explicit role/profile signal is present.
 */
export const ORCH_SUMMARY_PREFIX = "🐙 ORCH";

export type RepoWallMode = "off" | "shadow" | "enforce";

/**
 * Resolve the wall mode from the environment. Anything other than
 * "shadow"/"enforce" (including unset, empty, junk) resolves to "off" — the
 * safe, byte-identical-to-today default.
 */
export function repoWallMode(
  env: Record<string, string | undefined> = process.env,
): RepoWallMode {
  const raw = (env[REPO_WALL_FLAG_ENV] ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "enforce" ? raw : "off";
}

/**
 * A peer-shaped record carrying the fields {@link isOrchestrator} inspects.
 * All optional so callers can pass either a full DB row or a synthetic subset.
 *   - summary — the session summary (the "🐙 ORCH" tag convention lives here).
 *   - profile — the iTerm2 dynamic-profile name (e.g. "🐙 Orchestrator"); an
 *               explicit, registration-carried signal via profileToChannel().
 *   - role / is_orch — forward-compat hooks: if a future /register grows an
 *               explicit orchestrator field, it is honoured first with no code
 *               change here.
 */
export interface OrchSignal {
  summary?: string | null;
  profile?: string | null;
  role?: string | null;
  is_orch?: boolean | number | null;
}

/**
 * Identify an orchestrator peer, robustly and back-compat, in priority order:
 *
 *   1. Explicit field (forward-compat / dormant today): a truthy `is_orch`, or
 *      `role === "orchestrator"`. If a future registration carries an explicit
 *      orchestrator signal it wins with no change here.
 *   2. iTerm2 dynamic-profile: profileToChannel(profile) === "orchestrator".
 *      The orchestrator tab runs under the "🐙 Orchestrator" dynamic profile,
 *      which the broker already stores per peer — a reliable, registration-
 *      carried explicit signal (reuses the existing tabtitle helper).
 *   3. Summary tag convention (the live working fallback): summary starts with
 *      {@link ORCH_SUMMARY_PREFIX} ("🐙 ORCH", which also matches
 *      "🐙 ORCHESTRATOR").
 *
 * A row carrying NONE of these signals is a normal (non-orch) peer — so an
 * un-tagged legacy row is simply "not an orchestrator" and the wall still holds.
 */
export function isOrchestrator(peer: OrchSignal): boolean {
  // 1. Explicit forward-compat field.
  if (peer.is_orch === true || peer.is_orch === 1) return true;
  if (typeof peer.role === "string" && peer.role.trim().toLowerCase() === "orchestrator") {
    return true;
  }
  // 2. iTerm2 dynamic-profile signal.
  if (typeof peer.profile === "string" && profileToChannel(peer.profile) === "orchestrator") {
    return true;
  }
  // 3. Summary tag convention.
  const summary = (peer.summary ?? "").trim();
  return summary.startsWith(ORCH_SUMMARY_PREFIX);
}

/** The two sides of a delivery decision, reduced to exactly what the wall needs. */
export interface WallParticipant {
  id: string;
  git_root: string | null;
  is_orch: boolean;
}

export type WallReason =
  | "same_repo" // ALLOW: sender & recipient share a real git_root (full mesh).
  | "orch_room" // ALLOW: both are orchestrators (the cross-repo orchestrators room).
  | "cross_repo"; // REJECT: different repos and not both orchestrators.

export interface WallDecision {
  allow: boolean;
  reason: WallReason;
}

/**
 * True iff two git_roots denote the SAME real repo room.
 *
 * A null / empty git_root means "not in a repo" — it denotes NO room and
 * therefore matches NOTHING, not even another null. This is deliberately
 * stricter than a literal `null == null`: it prevents every repo-less session on
 * the machine from being silently pooled into one shared room, which would be a
 * hole in a wall whose whole purpose is repo isolation. It only affects shadow
 * logging + enforce; in practice GUPPI sessions run inside a repo so git_root is
 * populated.
 */
export function sameRepo(a: string | null, b: string | null): boolean {
  const ra = (a ?? "").trim();
  const rb = (b ?? "").trim();
  if (ra === "" || rb === "") return false;
  return ra === rb;
}

/**
 * Classify a delivery from `sender` to `recipient` against THE WALL RULE.
 * Pure — the caller ({@link wallAllows}) applies the mode policy.
 */
export function classifyWall(
  sender: WallParticipant,
  recipient: WallParticipant,
): WallDecision {
  if (sameRepo(sender.git_root, recipient.git_root)) {
    return { allow: true, reason: "same_repo" };
  }
  if (sender.is_orch && recipient.is_orch) {
    return { allow: true, reason: "orch_room" };
  }
  return { allow: false, reason: "cross_repo" };
}

/**
 * Policy gate: should a send with the given {@link WallDecision} be DELIVERED
 * under `mode`?
 *   - off     → always deliver (byte-identical to today).
 *   - shadow  → always deliver (observe-only; the caller logs a would-reject on
 *               a non-allow decision).
 *   - enforce → deliver only when the decision allows.
 */
export function wallAllows(mode: RepoWallMode, decision: WallDecision): boolean {
  if (mode === "off" || mode === "shadow") return true;
  return decision.allow;
}

/** True when a decision is worth emitting a repo_wall_blocked log/audit line. */
export function isWalled(decision: WallDecision): boolean {
  return !decision.allow;
}

/**
 * Build the structured, secret-free context for a walled-send log/audit line.
 * Contains ONLY ids, git_roots, is_orch flags, the reason, and the mode — NEVER
 * the message text and NEVER a peer token / boot_id.
 */
export function walledSendContext(
  mode: RepoWallMode,
  sender: WallParticipant,
  recipient: WallParticipant,
  decision: WallDecision,
): Record<string, unknown> {
  return {
    event: "repo_wall_blocked",
    mode,
    reason: decision.reason,
    // shadow only observes; enforce actually blocks. Surfaced so a log reader
    // can tell a would-block from a real block at a glance.
    outcome: mode === "enforce" ? "blocked" : "would_block",
    from_id: sender.id,
    from_git_root: sender.git_root,
    from_is_orch: sender.is_orch,
    to_id: recipient.id,
    to_git_root: recipient.git_root,
    to_is_orch: recipient.is_orch,
  };
}

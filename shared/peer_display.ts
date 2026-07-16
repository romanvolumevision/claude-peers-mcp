/**
 * list_peers per-peer render + broker-side readable identity (D-0060, CONV-10767).
 *
 * Extracted out of the inline `peers.map(...)` in server.ts so the exact text —
 * and the D-0060 back-compat invariant (a peer with NO derivable identity renders
 * BYTE-IDENTICALLY to pre-D-0060) — is unit-testable without booting the stdio
 * MCP, matching the repo's existing pattern (tabtitle.ts / reregister.ts).
 *
 * Field order + labels mirror the pre-D-0060 inline renderer VERBATIM; the only
 * addition is the OPTIONAL `Name:` / `Slug:` lines. The `Name:` value is the
 * CANONICAL readable identity: the client-supplied `display_name` when present,
 * otherwise a purely-broker-side DERIVATION from the peer's iTerm profile colour
 * + repo (readableIdentity, below). DISPLAY-ONLY: the opaque `id` on the first
 * line remains the sole routing key — nothing here is ever used to address a peer.
 */

import type { Peer } from "./types.ts";
import { CHANNEL_EMOJI, profileToChannel } from "./tabtitle.ts";

/**
 * D-0060 FROZEN colour → readable name table. A byte-consistent mirror of
 * `_SPAWN_NAME_BY_COLOUR` in the GUPPI repo
 * `infrastructure/tools/iterm/peer_name_producer.py`. Deterministic — NO model
 * in the loop. Every value is a distinct `peer_names.NAME_POOL` entry and never
 * a colour word. Keep in sync with the Python source of truth if it changes.
 */
export const NAME_BY_COLOUR: Record<string, string> = {
  green: "Uma",
  yellow: "Ron",
  red: "Ada",
  blue: "Cleo",
  cyan: "Mina",
  orange: "Odi",
  purple: "Bex",
  pink: "Ivo",
  gray: "Nell",
};

/** The minimal peer facts readableIdentity needs (a full Peer satisfies it). */
export interface IdentityInput {
  profile?: string;
  cwd?: string;
  git_root?: string | null;
  repo_root?: string | null;
  role?: string;
}

/**
 * Short repo name = the last path segment of the peer's repo/cwd. Prefers the
 * normalized main-worktree `repo_root` (so a per-colour worktree and the main
 * checkout resolve to the SAME repo), falling back to `git_root` then `cwd`.
 * Returns "" when nothing is derivable.
 */
export function repoShortName(p: IdentityInput): string {
  const raw = (p.repo_root || p.git_root || p.cwd || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/\/+$/, "");
  const base = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  return base;
}

/**
 * CANONICAL readable peer identity — a PURE function of (profile colour, repo),
 * derived entirely broker-side (deterministic, NO AI). Shape:
 *
 *     "<emoji> <Colour> · <Name> · <repo>"      e.g. "🟡 Yellow · Ron · guppi"
 *
 * where colour comes from the iTerm profile (profileToChannel), Name from the
 * frozen NAME_BY_COLOUR table, and repo from the peer's repo_root/git_root/cwd
 * basename. Fallbacks, in order:
 *   - orchestrator profile / bound role  → "🐙 <repo>-orch"  (or "🐙 orch")
 *   - colour resolves but no repo         → "<emoji> <Colour> · <Name>"
 *   - colour resolves but no name         → "<emoji> <Colour> · <repo>"  (defensive)
 *   - NOTHING resolves (no profile)       → "" (caller keeps the opaque id)
 * Never fabricates and never returns a bare opaque id — an empty result is the
 * signal for the caller to fall back to the id it already holds.
 */
export function readableIdentity(p: IdentityInput): string {
  const repo = repoShortName(p);
  const channel = profileToChannel(p.profile ?? "");
  const isOrch =
    (p.role ?? "").toLowerCase() === "orchestrator" || channel === "orchestrator";
  if (isOrch) {
    return repo ? `🐙 ${repo}-orch` : "🐙 orch";
  }
  if (channel && CHANNEL_EMOJI[channel]) {
    const emoji = CHANNEL_EMOJI[channel];
    const colour = channel.charAt(0).toUpperCase() + channel.slice(1);
    const segments = [`${emoji} ${colour}`];
    const name = NAME_BY_COLOUR[channel];
    if (name) segments.push(name);
    if (repo) segments.push(repo);
    return segments.join(" · ");
  }
  return "";
}

/**
 * The single-line label to show for a peer wherever it is referenced. Prefers a
 * client-supplied `display_name` (which may carry the slot, e.g.
 * "🟢 Green · P1 · Uma — offplan"), else the broker-derived canonical identity.
 * Returns "" when neither resolves (caller falls back to the opaque id).
 */
export function peerLabel(p: Peer): string {
  return p.display_name || readableIdentity(p);
}

export function renderPeerBlock(p: Peer): string {
  const parts = [
    `ID: ${p.id}`,
    `PID: ${p.pid}`,
    `CWD: ${p.cwd}`,
  ];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.profile) parts.push(`Profile: ${p.profile}`);
  if (p.host) parts.push(`Host: ${p.host}`);
  if (p.machine) parts.push(`Machine: ${p.machine}`);
  // D-0060 readable name — display-only, shown next to the opaque id. Prefers a
  // client-supplied display_name, else the broker-derived canonical identity
  // (profile colour + repo). A peer with neither (no profile → derives to "")
  // adds no line → byte-identical to the pre-D-0060 renderer.
  const identity = peerLabel(p);
  if (identity) parts.push(`Name: ${identity}`);
  if (p.slug) parts.push(`Slug: ${p.slug}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

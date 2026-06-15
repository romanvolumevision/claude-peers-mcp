/**
 * Resolve this session's channel/profile identity from the environment.
 *
 * Precedence:
 *   1. ITERM_PROFILE — set automatically by iTerm2 to the dynamic-profile name
 *      (e.g. "🟢 Green — GUPPI") on the Mac control plane.
 *   2. TMUX_PROFILE  — set explicitly at spawn (`tmux new-window -e
 *      TMUX_PROFILE=…`) on the Forge tmux remote-control path, where there is
 *      no iTerm2 and therefore no ITERM_PROFILE.
 *   3. ""            — plain Terminal.app / SSH / CI callers with neither.
 *
 * ITERM_PROFILE wins so a Mac iTerm session never picks up a stray inherited
 * TMUX_PROFILE. Truthiness (not `??`) is used deliberately: an exported-but-
 * empty ITERM_PROFILE still falls through to TMUX_PROFILE, which matters on the
 * Forge side where the env may carry an empty iTerm var.
 *
 * Upstreamed 2026-06-15 from the fragile `scripts/forge/setup_broker.sh` sed
 * patch, which rewrote only ONE of the seven `process.env.ITERM_PROFILE ?? ""`
 * call sites on a stale detached-HEAD Forge checkout (b39f048) and was wiped by
 * any `git pull`. Routing every site through this helper makes the tmux
 * fallback native and pull-safe. See tmux-migration-plan §5 step 1.
 */
export function resolveProfileEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.ITERM_PROFILE || env.TMUX_PROFILE || "";
}

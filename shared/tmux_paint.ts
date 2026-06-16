/**
 * tmux window-title paint leg (tmux-migration §5 step 5).
 *
 * Mirrors the iTerm2 AppleScript `set name` leg in server.ts#refreshTabTitle,
 * but for sessions running inside a tmux server (the Forge remote-control path,
 * where there is no iTerm2 and therefore no $ITERM_SESSION_ID — so the iTerm
 * leg no-ops). When $TMUX is set we instead drive the COMPACT composed title
 * onto the session's tmux window name via `tmux rename-window`, and disable
 * tmux's own automatic-rename so it cannot overwrite our title.
 *
 * Both legs are additive and independently gated: the iTerm leg keys on
 * $ITERM_SESSION_ID, this leg keys on $TMUX. On a Mac iTerm session $TMUX is
 * unset so this is a no-op; over SSH/tmux $ITERM_SESSION_ID is empty so the
 * iTerm leg is the no-op. Neither blocks the other.
 *
 * The window is targeted via $TMUX_PANE (a pane id like "%3"); tmux resolves a
 * pane id to its containing window, so a window-scoped command (rename-window /
 * set-window-option) hits the right window even when several windows exist.
 *
 * Best-effort by contract: every failure is caught and swallowed via the
 * injected logger; this leg must never throw and never block set_summary.
 */

// Namespace import (not a named `execFile`) so the binding is resolved at CALL
// time off the module namespace — this lets a unit test `mock.module(
// "child_process", …)` swap execFile in without a fresh re-import dance.
import * as childProcess from "child_process";

/**
 * A runnable tmux command: argv (without the leading "tmux") → resolves when
 * the command finishes (success OR failure). Injectable so the unit test can
 * mock child_process and assert the argv without spawning a real tmux.
 */
export type TmuxRunner = (args: string[]) => Promise<void>;

/** Default runner: shell out to the real `tmux` binary via execFile (no shell,
 * so the title — which carries spaces, emoji and "·" — is passed as a single
 * argv element; no word-splitting, no shell-injection surface). */
export const defaultTmuxRunner: TmuxRunner = (args: string[]) =>
  new Promise<void>((resolve) => {
    childProcess.execFile("tmux", args, () => {
      // Resolve regardless of err: best-effort; the caller logs on failure.
      resolve();
    });
  });

/**
 * Paint `title` onto the current tmux window when running inside tmux.
 *
 * No-ops (returns false) when $TMUX is unset — i.e. not inside a tmux server.
 * When inside tmux, targets the window owning $TMUX_PANE; if $TMUX_PANE is
 * absent it falls back to tmux's own current-window default (no -t target).
 *
 * @returns true when a tmux paint was attempted, false when skipped (no $TMUX).
 */
export async function paintTmuxWindowTitle(
  title: string,
  opts: {
    env?: Record<string, string | undefined>;
    runner?: TmuxRunner;
    log?: (msg: string) => void;
  } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? defaultTmuxRunner;
  const log = opts.log ?? (() => {});

  // Gate: $TMUX is set iff this process runs inside a tmux server.
  if (!env.TMUX) return false;

  try {
    const pane = env.TMUX_PANE; // e.g. "%3" — resolves to its window.
    // Target the window via the pane id when we have one; otherwise let tmux
    // default to the current window.
    const target = pane ? ["-t", pane] : [];
    // Stop tmux's automatic-rename from clobbering the title we set. Done first
    // so the rename below is the last writer and therefore sticks.
    await runner(["set-window-option", ...target, "automatic-rename", "off"]);
    await runner(["rename-window", ...target, title]);
    return true;
  } catch (e) {
    // Defence-in-depth: the default runner already swallows, but a custom
    // runner might throw — never let it escape.
    log(`paintTmuxWindowTitle failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

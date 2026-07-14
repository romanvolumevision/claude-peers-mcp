/**
 * repo_root.ts — normalize a repo + ALL its linked worktrees to ONE logical
 * repo (CONV-10767, wall-worktree-normalize).
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
 * The repo wall's "same repo" test compares raw `git_root`. But GUPPI peers run
 * in per-colour git WORKTREES, and a worktree's `git rev-parse --show-toplevel`
 * returns the WORKTREE path, NOT the main repo. So a guppi orchestrator
 * (git_root=/…/guppi) and a guppi peer in a worktree
 * (git_root=/…/guppi-worktrees/red) have DIFFERENT git_roots → under enforce
 * they'd be walled apart → orch→peer dispatch BREAKS.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 * At registration the peer ALSO computes a normalized `repo_root` — the MAIN
 * working tree of the repo — so a repo and all its linked worktrees resolve to
 * the SAME value. Deterministic git resolution, uniform across both shapes:
 *   `git rev-parse --path-format=absolute --git-common-dir` returns the repo's
 *   COMMON git dir. For a NORMAL checkout that is `<root>/.git`; for a LINKED
 *   WORKTREE it is the MAIN repo's `<root>/.git`. Stripping the trailing `/.git`
 *   yields the main working tree root in BOTH cases — so the main checkout and
 *   every worktree collapse onto one repo_root.
 *
 * Pure/stdlib-only string logic lives in {@link mainRootFromCommonDir} so it is
 * unit-testable without git; {@link resolveRepoRoot} runs the real git probe.
 */

const GIT_SUFFIX = "/.git";

/**
 * Derive the MAIN working-tree root from the output of
 * `git rev-parse --path-format=absolute --git-common-dir`.
 *
 * The common dir is the parent repo's `.git` directory for BOTH a normal
 * checkout and a linked worktree, so stripping a trailing `/.git` gives the
 * canonical main working tree in both cases. Returns `fallback` when the common
 * dir is NOT the conventional `<root>/.git` shape (a bare repo, a custom
 * GIT_DIR, or a submodule `.git` file) — we never guess a root we can't derive
 * cleanly.
 */
export function mainRootFromCommonDir(
  commonDir: string,
  fallback: string | null,
): string | null {
  // Trim whitespace, then strip any trailing slashes.
  const dir = commonDir.trim().replace(/\/+$/, "");
  if (dir === "") return fallback;
  if (dir.endsWith(GIT_SUFFIX)) {
    const parent = dir.slice(0, -GIT_SUFFIX.length);
    return parent === "" ? fallback : parent;
  }
  return fallback;
}

/**
 * Resolve the normalized `repo_root` for `cwd`: the MAIN working tree of the
 * repo, so a repo and ALL its linked worktrees resolve to the SAME value.
 *
 * Falls back to `gitRoot` (the raw toplevel) whenever the common-dir probe
 * fails or is unconventional — so a NORMAL checkout yields repo_root === gitRoot
 * and a non-git dir yields the (typically null) fallback. Best-effort + never
 * throws (mirrors getGitRoot in server.ts).
 */
export async function resolveRepoRoot(
  cwd: string,
  gitRoot: string | null,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return mainRootFromCommonDir(text, gitRoot);
    }
  } catch {
    // not a git repo / git unavailable — fall through to the fallback.
  }
  return gitRoot;
}

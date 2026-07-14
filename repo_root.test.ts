/**
 * Tests for repo_root normalization (CONV-10767, wall-worktree-normalize).
 *
 * THE CRITICAL BUG this guards: GUPPI peers run in per-colour git WORKTREES, and
 * a worktree's `git rev-parse --show-toplevel` returns the WORKTREE path, NOT the
 * main repo. So an orchestrator in the main checkout (git_root=/…/guppi) and a
 * peer in a worktree (git_root=/…/guppi-worktrees/red) have DIFFERENT git_roots
 * and would be walled apart under enforce. `resolveRepoRoot` normalizes a repo +
 * ALL its linked worktrees to ONE logical repo_root (the MAIN working tree), so
 * the wall can treat them as the same room.
 *
 * Two layers:
 *   - mainRootFromCommonDir(): pure string logic (strip trailing /.git), no git.
 *   - resolveRepoRoot():       exercised against a REAL git repo + REAL linked
 *                              worktree created in a tmp dir — the acceptance
 *                              proof that a worktree resolves to the main root.
 *
 * Run: bun test repo_root.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainRootFromCommonDir, resolveRepoRoot } from "./shared/repo_root.ts";

describe("mainRootFromCommonDir() — pure strip-of-/.git", () => {
  test("a conventional <root>/.git yields <root>", () => {
    expect(mainRootFromCommonDir("/repo/guppi/.git", null)).toBe("/repo/guppi");
  });

  test("trailing slashes + surrounding whitespace are tolerated", () => {
    expect(mainRootFromCommonDir("  /repo/guppi/.git/  \n", null)).toBe("/repo/guppi");
    expect(mainRootFromCommonDir("/repo/guppi/.git\n", null)).toBe("/repo/guppi");
  });

  test("a linked-worktree common-dir (the MAIN repo's .git) yields the MAIN root", () => {
    // This is the whole point: a worktree's --git-common-dir points at the MAIN
    // repo's .git, so the normalized root is the main working tree, NOT the
    // worktree path.
    expect(mainRootFromCommonDir("/repo/guppi/.git", "/repo/guppi-worktrees/red")).toBe(
      "/repo/guppi",
    );
  });

  test("an unconventional common-dir (not <root>/.git) falls back", () => {
    // Bare repo / custom GIT_DIR / submodule .git file — don't guess, use fallback.
    expect(mainRootFromCommonDir("/some/bare-repo.git", "/fallback")).toBe("/fallback");
    expect(mainRootFromCommonDir("", "/fallback")).toBe("/fallback");
    expect(mainRootFromCommonDir("   ", null)).toBe(null);
  });

  test("a common-dir that is exactly '/.git' falls back (no empty root)", () => {
    expect(mainRootFromCommonDir("/.git", "/fallback")).toBe("/fallback");
  });
});

// ── REAL git repo + REAL linked worktree ─────────────────────────────────────
describe("resolveRepoRoot() — against a REAL git worktree", () => {
  let tmp: string;
  let mainRepo: string;
  let worktree: string;
  let nonGit: string;

  function git(cwd: string, ...args: string[]): string {
    const p = Bun.spawnSync(["git", ...args], { cwd });
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
    }
    return new TextDecoder().decode(p.stdout).trim();
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "repo-root-real-"));
    mainRepo = join(tmp, "guppi");
    worktree = join(tmp, "guppi-worktrees", "red");
    nonGit = join(tmp, "plain-dir");
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(nonGit, { recursive: true });
    git(mainRepo, "init", "-q");
    git(mainRepo, "config", "user.email", "t@t.co");
    git(mainRepo, "config", "user.name", "t");
    git(mainRepo, "commit", "-q", "--allow-empty", "-m", "init");
    // A REAL linked worktree — the exact shape a GUPPI per-colour peer runs in.
    git(mainRepo, "worktree", "add", "-q", worktree, "-b", "red");
  });

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("a NORMAL checkout resolves repo_root === its own toplevel (== git_root)", async () => {
    const toplevel = git(mainRepo, "rev-parse", "--show-toplevel");
    const repoRoot = await resolveRepoRoot(mainRepo, toplevel);
    expect(repoRoot).toBe(toplevel);
  });

  test("a LINKED WORKTREE resolves repo_root === the MAIN toplevel (NOT the worktree path)", async () => {
    const mainToplevel = git(mainRepo, "rev-parse", "--show-toplevel");
    const worktreeToplevel = git(worktree, "rev-parse", "--show-toplevel");
    // Sanity: the worktree's OWN toplevel differs from the main repo — this is
    // exactly the bug (git_root would wall them apart).
    expect(worktreeToplevel).not.toBe(mainToplevel);
    // The fix: normalized repo_root collapses the worktree onto the main repo.
    const repoRoot = await resolveRepoRoot(worktree, worktreeToplevel);
    expect(repoRoot).toBe(mainToplevel);
  });

  test("a non-git directory resolves to the (null) fallback", async () => {
    expect(await resolveRepoRoot(nonGit, null)).toBe(null);
  });
});

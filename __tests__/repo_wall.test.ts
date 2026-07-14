/**
 * Unit tests for the repo-scoped message-wall primitives (CONV-10767).
 *
 * Pure predicate coverage — the flag resolver, the orchestrator classifier, and
 * the classify + policy logic the broker's send path relies on, exercised
 * without booting the broker. The live-broker enforcement (off/shadow/enforce
 * over a real 2-repo + 2-orch fleet) is covered end-to-end in
 * repo_wall_integration.test.ts.
 *
 * Run: bun test __tests__/repo_wall.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  ORCH_SUMMARY_PREFIX,
  REPO_WALL_FLAG_ENV,
  type WallParticipant,
  classifyWall,
  effectiveRepoRoot,
  isOrchestrator,
  isWalled,
  repoWallMode,
  sameRepo,
  unknownParticipantContext,
  wallAllows,
  walledSendContext,
} from "../shared/repo_wall.ts";

describe("repoWallMode() — default-off three-state flag", () => {
  test("defaults to off when unset (byte-identical-to-today)", () => {
    expect(repoWallMode({})).toBe("off");
  });

  test("parses shadow / enforce case-insensitively with trimming", () => {
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: "shadow" })).toBe("shadow");
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: "  ENFORCE " })).toBe("enforce");
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: "Shadow" })).toBe("shadow");
  });

  test("unset / empty / whitespace resolves to off (back-compat default)", () => {
    // Fix 3 (Sol #11): unset & empty MUST stay back-compat (off) so an existing
    // deployment that never set the flag is byte-identical to today.
    expect(repoWallMode({})).toBe("off");
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: "" })).toBe("off");
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: "   " })).toBe("off");
  });

  test("off is an EXPLICITLY recognized value (not just the fall-through)", () => {
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: "off" })).toBe("off");
    expect(repoWallMode({ [REPO_WALL_FLAG_ENV]: " OFF " })).toBe("off");
  });

  test("an UNRECOGNIZED non-empty value FAILS FAST (never silently falls back to off)", () => {
    // Fix 3 (Sol #11): silently mapping junk → off would DISABLE isolation on a
    // typo (e.g. "enfroce"). The parser must throw so the broker refuses to start.
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "enfroce" })).toThrow();
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "1" })).toThrow();
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "yes" })).toThrow();
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "on" })).toThrow();
    // "warn" is the identity-bind vocabulary, NOT the wall's — a mistake, so throw.
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "warn" })).toThrow();
    // The message names the offending value + the allowed set (no secrets).
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "enfroce" })).toThrow(/enfroce/);
    expect(() => repoWallMode({ [REPO_WALL_FLAG_ENV]: "enfroce" })).toThrow(/enforce/);
  });
});

describe("isOrchestrator() — robust, back-compat signal", () => {
  test("explicit forward-compat field wins (is_orch / role)", () => {
    expect(isOrchestrator({ is_orch: true })).toBe(true);
    expect(isOrchestrator({ is_orch: 1 })).toBe(true);
    expect(isOrchestrator({ role: "orchestrator" })).toBe(true);
    expect(isOrchestrator({ role: "  ORCHESTRATOR " })).toBe(true);
    expect(isOrchestrator({ is_orch: false, role: "worker" })).toBe(false);
    expect(isOrchestrator({ is_orch: 0 })).toBe(false);
  });

  test("iTerm2 dynamic-profile signal: profile names the orchestrator profile", () => {
    expect(isOrchestrator({ profile: "🐙 Orchestrator" })).toBe(true);
    expect(isOrchestrator({ profile: "orchestrator" })).toBe(true);
    // A colour worker profile is NOT an orchestrator.
    expect(isOrchestrator({ profile: "🟢 Green — GUPPI" })).toBe(false);
    expect(isOrchestrator({ profile: "" })).toBe(false);
  });

  test("summary tag convention fallback: starts with 🐙 ORCH / 🐙 ORCHESTRATOR", () => {
    expect(isOrchestrator({ summary: `${ORCH_SUMMARY_PREFIX} (CONV-10767) — fleet` })).toBe(true);
    expect(isOrchestrator({ summary: "🐙 ORCHESTRATOR (CONV-10613) — fleet at rest" })).toBe(true);
    // Must be a prefix, not merely contain the tag.
    expect(isOrchestrator({ summary: "working with the 🐙 ORCH on X" })).toBe(false);
  });

  test("a row with NO orch signal is a normal peer", () => {
    expect(isOrchestrator({})).toBe(false);
    expect(isOrchestrator({ summary: "🟢 green legwork", profile: "🟢 Green — GUPPI" })).toBe(false);
    expect(isOrchestrator({ summary: null, profile: null })).toBe(false);
  });
});

describe("sameRepo() — real-repo room equality", () => {
  test("equal non-empty git_roots are the same room", () => {
    expect(sameRepo("/repo/a", "/repo/a")).toBe(true);
    expect(sameRepo("  /repo/a  ", "/repo/a")).toBe(true); // trimmed
  });

  test("different git_roots are different rooms", () => {
    expect(sameRepo("/repo/a", "/repo/b")).toBe(false);
  });

  test("a null / empty git_root matches NOTHING — not even another null", () => {
    // Security-conservative: repo-less peers are NOT pooled into one shared room.
    expect(sameRepo(null, null)).toBe(false);
    expect(sameRepo("", "")).toBe(false);
    expect(sameRepo(null, "/repo/a")).toBe(false);
    expect(sameRepo("/repo/a", null)).toBe(false);
    expect(sameRepo("", "/repo/a")).toBe(false);
  });
});

describe("effectiveRepoRoot() — normalized repo_root wins, git_root is the fallback", () => {
  test("a populated repo_root is the effective key (worktree normalization)", () => {
    // A worktree peer: git_root is the WORKTREE path, repo_root is the MAIN repo.
    const wt: WallParticipant = {
      id: "wt",
      git_root: "/repo/guppi-worktrees/red",
      repo_root: "/repo/guppi",
      is_orch: false,
    };
    expect(effectiveRepoRoot(wt)).toBe("/repo/guppi");
  });

  test("an empty / missing repo_root falls back to git_root (legacy rows)", () => {
    expect(effectiveRepoRoot({ id: "x", git_root: "/repo/g", is_orch: false })).toBe("/repo/g");
    expect(
      effectiveRepoRoot({ id: "x", git_root: "/repo/g", repo_root: "", is_orch: false }),
    ).toBe("/repo/g");
    expect(
      effectiveRepoRoot({ id: "x", git_root: "/repo/g", repo_root: "   ", is_orch: false }),
    ).toBe("/repo/g");
    expect(
      effectiveRepoRoot({ id: "x", git_root: "/repo/g", repo_root: null, is_orch: false }),
    ).toBe("/repo/g");
  });
});

describe("classifyWall() — WORKTREE NORMALIZATION (the cell that was broken)", () => {
  const REPO = "/repo/guppi";
  const WT = "/repo/guppi-worktrees/red";
  const OTHER = "/repo/offplan";

  // A main-checkout orchestrator: git_root == repo_root == the repo.
  const orchMain: WallParticipant = { id: "o", git_root: REPO, repo_root: REPO, is_orch: true };
  // A peer in a per-colour WORKTREE: git_root is the worktree, repo_root is main.
  const wtPeer: WallParticipant = { id: "wt", git_root: WT, repo_root: REPO, is_orch: false };
  // A same-repo main peer.
  const mainPeer: WallParticipant = { id: "p", git_root: REPO, repo_root: REPO, is_orch: false };
  // A peer in a DIFFERENT repo.
  const otherPeer: WallParticipant = {
    id: "z",
    git_root: OTHER,
    repo_root: OTHER,
    is_orch: false,
  };

  test("main-checkout orch ↔ WORKTREE peer: ALLOW (same logical repo via repo_root)", () => {
    // Under raw git_root this would REJECT (different toplevels). Normalization
    // collapses them to the same room.
    expect(classifyWall(orchMain, wtPeer)).toEqual({ allow: true, reason: "same_repo" });
    expect(classifyWall(wtPeer, orchMain)).toEqual({ allow: true, reason: "same_repo" });
  });

  test("main peer ↔ WORKTREE peer of the same repo: ALLOW", () => {
    expect(classifyWall(mainPeer, wtPeer).allow).toBe(true);
    expect(classifyWall(wtPeer, mainPeer).allow).toBe(true);
  });

  test("WORKTREE peer ↔ a genuinely different repo: still REJECT", () => {
    expect(classifyWall(wtPeer, otherPeer)).toEqual({ allow: false, reason: "cross_repo" });
    expect(classifyWall(otherPeer, wtPeer).allow).toBe(false);
  });

  test("legacy main orch (repo_root='') ↔ worktree peer still ALLOW via git_root fallback", () => {
    // During the mixed-deploy window the orch row may predate repo_root: it
    // falls back to git_root (== REPO, since the orch runs in the main checkout),
    // which still matches the worktree peer's normalized repo_root.
    const legacyOrch: WallParticipant = { id: "lo", git_root: REPO, repo_root: "", is_orch: true };
    expect(classifyWall(legacyOrch, wtPeer).allow).toBe(true);
  });
});

// --- The reachability matrix, at the pure-classify level ---
//
// Two repos (A, B) × two roles (peer, orch). classifyWall is symmetric-agnostic
// (it takes an ordered sender→recipient pair) so we assert BOTH directions where
// they matter.
const A = "/repo/a";
const B = "/repo/b";
function peer(id: string, repo: string | null): WallParticipant {
  return { id, git_root: repo, is_orch: false };
}
function orch(id: string, repo: string | null): WallParticipant {
  return { id, git_root: repo, is_orch: true };
}

describe("classifyWall() — THE WALL RULE", () => {
  test("same-repo peer→peer: ALLOW (full mesh)", () => {
    expect(classifyWall(peer("a1", A), peer("a2", A))).toEqual({
      allow: true,
      reason: "same_repo",
    });
  });

  test("same-repo peer→orch AND orch→peer: ALLOW (a peer reaches its own orch)", () => {
    expect(classifyWall(peer("a1", A), orch("oa", A)).allow).toBe(true);
    expect(classifyWall(orch("oa", A), peer("a1", A)).allow).toBe(true);
  });

  test("orch(A)→orch(B): ALLOW (the orchestrators room)", () => {
    expect(classifyWall(orch("oa", A), orch("ob", B))).toEqual({
      allow: true,
      reason: "orch_room",
    });
    expect(classifyWall(orch("ob", B), orch("oa", A)).allow).toBe(true);
  });

  test("cross-repo peer→peer: REJECT", () => {
    expect(classifyWall(peer("a1", A), peer("b1", B))).toEqual({
      allow: false,
      reason: "cross_repo",
    });
  });

  test("peer(A)→orch(B): REJECT (a peer can never reach another repo's orch)", () => {
    expect(classifyWall(peer("a1", A), orch("ob", B)).allow).toBe(false);
  });

  test("orch(A)→peer(B): REJECT (an orch can never reach another repo's peer)", () => {
    expect(classifyWall(orch("oa", A), peer("b1", B)).allow).toBe(false);
  });

  test("full 4×4 reachability matrix is exactly as specified", () => {
    // Rows = sender, cols = recipient. p=peer, o=orch; A/B = repo.
    const nodes: Record<string, WallParticipant> = {
      pA: peer("pA", A),
      pB: peer("pB", B),
      oA: orch("oA", A),
      oB: orch("oB", B),
    };
    // Expected ALLOW for every ordered (sender→recipient) pair, sender != recipient.
    const expected: Record<string, Record<string, boolean>> = {
      pA: { pB: false, oA: true, oB: false },
      pB: { pA: false, oA: false, oB: true },
      oA: { pB: false, pA: true, oB: true },
      oB: { pA: false, pB: true, oA: true },
    };
    for (const [s, cols] of Object.entries(expected)) {
      for (const [r, allow] of Object.entries(cols)) {
        expect({ pair: `${s}->${r}`, allow: classifyWall(nodes[s]!, nodes[r]!).allow }).toEqual({
          pair: `${s}->${r}`,
          allow,
        });
      }
    }
  });
});

describe("wallAllows() — mode policy", () => {
  const walled = { allow: false, reason: "cross_repo" } as const;
  const allowed = { allow: true, reason: "same_repo" } as const;

  test("off delivers everything (byte-identical to today)", () => {
    expect(wallAllows("off", walled)).toBe(true);
    expect(wallAllows("off", allowed)).toBe(true);
  });

  test("shadow delivers everything (observe-only)", () => {
    expect(wallAllows("shadow", walled)).toBe(true);
    expect(wallAllows("shadow", allowed)).toBe(true);
  });

  test("enforce delivers only allowed decisions", () => {
    expect(wallAllows("enforce", allowed)).toBe(true);
    expect(wallAllows("enforce", walled)).toBe(false);
  });
});

describe("isWalled() + walledSendContext() — the log/audit line", () => {
  test("isWalled is true iff the decision rejects", () => {
    expect(isWalled({ allow: false, reason: "cross_repo" })).toBe(true);
    expect(isWalled({ allow: true, reason: "same_repo" })).toBe(false);
    expect(isWalled({ allow: true, reason: "orch_room" })).toBe(false);
  });

  test("context carries ids/git_roots/repo_roots/is_orch/reason/mode — and NO secrets", () => {
    const sender: WallParticipant = { id: "pA", git_root: A, repo_root: A, is_orch: false };
    const recipient: WallParticipant = { id: "pB", git_root: B, repo_root: B, is_orch: false };
    const decision = classifyWall(sender, recipient);
    const shadowCtx = walledSendContext("shadow", sender, recipient, decision);
    expect(shadowCtx).toEqual({
      event: "repo_wall_blocked",
      mode: "shadow",
      reason: "cross_repo",
      outcome: "would_block",
      from_id: "pA",
      from_git_root: A,
      from_repo_root: A,
      from_is_orch: false,
      to_id: "pB",
      to_git_root: B,
      to_repo_root: B,
      to_is_orch: false,
    });
    // enforce flips only the outcome label.
    expect(walledSendContext("enforce", sender, recipient, decision).outcome).toBe("blocked");
    // Guard: the serialized line must never carry a token / boot_id / message text.
    const serialized = JSON.stringify(shadowCtx);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("boot_id");
    expect(serialized).not.toContain("text");
  });
});

describe("unknownParticipantContext() — the deny-unknown-in-enforce log line", () => {
  test("carries ids + known-flags, outcome=blocked in enforce / would_block in shadow", () => {
    const enforceCtx = unknownParticipantContext("enforce", "ghost", "pB", false, true);
    expect(enforceCtx).toEqual({
      event: "repo_wall_blocked",
      mode: "enforce",
      reason: "unknown_participant",
      outcome: "blocked",
      from_id: "ghost",
      from_known: false,
      to_id: "pB",
      to_known: true,
    });
    expect(unknownParticipantContext("shadow", "ghost", "pB", false, true).outcome).toBe(
      "would_block",
    );
    // No secrets / message text ever.
    const serialized = JSON.stringify(enforceCtx);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("boot_id");
    expect(serialized).not.toContain("text");
  });
});

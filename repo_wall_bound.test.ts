/**
 * repo_wall_bound.test.ts — the repo wall trusts the BOUND `role` column, NOT the
 * spoofable `summary` tag (CONV-10767).
 *
 * PR #16 added `bind_orchestrator`, a server-owned self-op that stamps an
 * authoritative role='orchestrator' on the caller's OWN peer row. Before this
 * change the wall still decided "is this peer an orchestrator?" from the summary
 * prefix "🐙 ORCH" — which any peer can set on itself via set_summary. That made
 * the cross-repo "orchestrators room" exception spoofable: set the summary, gain
 * cross-repo reach.
 *
 * These pure unit tests pin the fix: {@link isBoundOrchestrator} — the
 * enforcement-grade predicate the wall uses — trusts ONLY the bound role column.
 * The display-grade {@link isOrchestrator} keeps its summary/profile fallback for
 * un-bound legacy rows, but the wall does not consult it.
 */

import { describe, test, expect } from "bun:test";
import {
  isBoundOrchestrator,
  isOrchestrator,
  classifyWall,
  ORCH_SUMMARY_PREFIX,
  type WallParticipant,
} from "./shared/repo_wall";

describe("isBoundOrchestrator — trusts the BOUND role column only", () => {
  test("a bound row (role='orchestrator') IS a bound orchestrator", () => {
    expect(isBoundOrchestrator({ role: "orchestrator" })).toBe(true);
  });

  test("role match is case/space-insensitive (server writes 'orchestrator', be lenient)", () => {
    expect(isBoundOrchestrator({ role: "  Orchestrator " })).toBe(true);
  });

  test("SPOOF REJECTED: summary='🐙 ORCH …' but role='' is NOT a bound orchestrator", () => {
    expect(
      isBoundOrchestrator({ role: "", summary: `${ORCH_SUMMARY_PREFIX} (CONV-10767) — faker` }),
    ).toBe(false);
  });

  test("SPOOF REJECTED: even a '🐙 Orchestrator' iTerm profile does NOT bind role", () => {
    expect(isBoundOrchestrator({ role: "", profile: "🐙 Orchestrator" })).toBe(false);
  });

  test("un-bound row (no role field at all) is NOT a bound orchestrator", () => {
    expect(isBoundOrchestrator({ summary: `${ORCH_SUMMARY_PREFIX} legacy` })).toBe(false);
    expect(isBoundOrchestrator({})).toBe(false);
  });

  test("a non-orchestrator bound role (e.g. role='peer') is NOT an orchestrator", () => {
    expect(isBoundOrchestrator({ role: "peer" })).toBe(false);
  });
});

describe("isOrchestrator — display fallback still honours summary/profile (un-bound legacy)", () => {
  test("bound role is honoured (parity with the enforcement predicate)", () => {
    expect(isOrchestrator({ role: "orchestrator" })).toBe(true);
  });

  test("summary tag still counts for DISPLAY of an un-bound legacy row", () => {
    // This is the KEY divergence: the same row the wall would REJECT
    // (isBoundOrchestrator === false) is still shown as an orchestrator by the
    // display-grade predicate. Enforcement and display are deliberately split.
    const spoof = { role: "", summary: `${ORCH_SUMMARY_PREFIX} — legacy un-bound` };
    expect(isOrchestrator(spoof)).toBe(true);
    expect(isBoundOrchestrator(spoof)).toBe(false);
  });
});

describe("classifyWall — the orchestrators-room exception keys off the bound flag", () => {
  const boundOrch = (id: string, git_root: string | null): WallParticipant => ({
    id,
    git_root,
    is_orch: true, // as loadWallParticipant would set it from isBoundOrchestrator
  });
  const spoofPeer = (id: string, git_root: string | null): WallParticipant => ({
    id,
    git_root,
    is_orch: false, // summary-only spoofer resolves to is_orch=false at load time
  });

  test("two BOUND orchestrators in different repos ALLOW (orchestrators room)", () => {
    const d = classifyWall(boundOrch("oA", "/repo/A"), boundOrch("oB", "/repo/B"));
    expect(d).toEqual({ allow: true, reason: "orch_room" });
  });

  test("SPOOF REJECTED end-to-end: a summary-only spoofer (is_orch=false) cross-repo to a bound orch is REJECTED", () => {
    const d = classifyWall(spoofPeer("spoof", "/repo/A"), boundOrch("oB", "/repo/B"));
    expect(d).toEqual({ allow: false, reason: "cross_repo" });
  });

  test("two spoofers cross-repo are REJECTED (neither bound → no orch-room)", () => {
    const d = classifyWall(spoofPeer("sA", "/repo/A"), spoofPeer("sB", "/repo/B"));
    expect(d).toEqual({ allow: false, reason: "cross_repo" });
  });

  test("same-repo still ALLOWS regardless of orch status (back-compat)", () => {
    const d = classifyWall(spoofPeer("sA", "/repo/A"), spoofPeer("sA2", "/repo/A"));
    expect(d).toEqual({ allow: true, reason: "same_repo" });
  });
});

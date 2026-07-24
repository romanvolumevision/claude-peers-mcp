/**
 * Unit tests for board-272 / #2041 harness-pid resolution.
 *
 * RED-first: replays the TWO real specimens the orch recorded (former-Orange
 * o0wovk3e and former-orch 5mqw87z0) as fixtured process topologies, plus the
 * degrade paths. Against a broker that signals the REGISTERED pid these prove
 * why the session survived; against the fix they prove the harness is resolved.
 *
 * Run: bun test harness_resolve.test.ts
 */
import { describe, test, expect } from "bun:test";
import {
  isHarnessComm,
  resolveHarnessPid,
  MAX_PPID_DEPTH,
  type ProcNode,
  type ProcLookup,
} from "./shared/harness_resolve";

/** Build a ProcLookup from a fixtured {pid → node} topology. */
function fixtureLookup(tree: Record<number, ProcNode>): ProcLookup {
  return (pid: number) => tree[pid] ?? null;
}

describe("isHarnessComm", () => {
  test("matches a bare `claude` (terminal launch)", () => {
    expect(isHarnessComm("claude")).toBe(true);
  });
  test("matches an absolute path ending in /claude (desktop launch)", () => {
    expect(
      isHarnessComm(
        "/Users/x/Library/Application Support/Claude/claude-code/2.1.217/claude.app/Contents/MacOS/claude",
      ),
    ).toBe(true);
  });
  test("does NOT match the adapter sibling `bun`", () => {
    expect(isHarnessComm("bun")).toBe(false);
  });
  test("does NOT match look-alike siblings", () => {
    expect(isHarnessComm("claude-peers")).toBe(false);
    expect(isHarnessComm("claude-foo")).toBe(false);
    expect(isHarnessComm("/opt/bin/claudex")).toBe(false);
    expect(isHarnessComm("")).toBe(false);
  });
});

describe("resolveHarnessPid — the two board-272 specimens", () => {
  // Specimen 1: former-Orange o0wovk3e. kill_peer reported ok pid 50962, but
  // 50962 was the adapter sibling; claude 50864 (ttys002) survived ~11h.
  test("specimen 1 (o0wovk3e): adapter 50962 → harness claude 50864", () => {
    const tree: Record<number, ProcNode> = {
      50962: { ppid: 50864, comm: "bun" }, // registered adapter
      50864: { ppid: 50820, comm: "claude" }, // harness that survived
      50820: { ppid: 1, comm: "login" }, // tty session leader
    };
    const r = resolveHarnessPid(50962, fixtureLookup(tree));
    expect(r).not.toBeNull();
    expect(r!.pid).toBe(50864);
    expect(r!.comm).toBe("claude");
    expect(r!.depth).toBe(1); // one hop up from the adapter
  });

  // Specimen 2: former-orch 5mqw87z0. kill_peer ok pid 17946 (sibling);
  // claude 17729 (ttys010) survived identically.
  test("specimen 2 (5mqw87z0): adapter 17946 → harness claude 17729", () => {
    const tree: Record<number, ProcNode> = {
      17946: { ppid: 17729, comm: "bun" },
      17729: { ppid: 17700, comm: "claude" },
      17700: { ppid: 1, comm: "zsh" },
    };
    const r = resolveHarnessPid(17946, fixtureLookup(tree));
    expect(r!.pid).toBe(17729);
  });

  // Desktop-app topology: harness's pgid is the Electron app — proves why a
  // process-group kill would be catastrophic and PPID resolution is used.
  test("desktop-app topology resolves the harness, not the Electron app", () => {
    const tree: Record<number, ProcNode> = {
      39180: { ppid: 39152, comm: "bun" }, // adapter
      39152: { ppid: 39151, comm: "/Applications/Claude.app/Contents/MacOS/claude" },
      39151: { ppid: 24109, comm: "disclaimer" },
      24109: { ppid: 1, comm: "Claude" }, // the Electron app — must NOT be the target
    };
    const r = resolveHarnessPid(39180, fixtureLookup(tree));
    expect(r!.pid).toBe(39152);
    expect(r!.comm.endsWith("/claude")).toBe(true);
  });
});

describe("resolveHarnessPid — degrade paths (→ sibling-only)", () => {
  test("no claude ancestor (bare test process) → null", () => {
    const tree: Record<number, ProcNode> = {
      777: { ppid: 700, comm: "sleep" },
      700: { ppid: 1, comm: "bun" }, // a test runner, not claude
    };
    expect(resolveHarnessPid(777, fixtureLookup(tree))).toBeNull();
  });

  test("chain reaches init (ppid 1) without claude → null", () => {
    const tree: Record<number, ProcNode> = {
      500: { ppid: 1, comm: "bun" },
    };
    expect(resolveHarnessPid(500, fixtureLookup(tree))).toBeNull();
  });

  test("pid unreadable / already gone → null", () => {
    expect(resolveHarnessPid(999999, fixtureLookup({}))).toBeNull();
  });

  test("invalid start pid → null", () => {
    expect(resolveHarnessPid(0, fixtureLookup({}))).toBeNull();
    expect(resolveHarnessPid(-3, fixtureLookup({}))).toBeNull();
  });

  test("a PPID cycle can never spin (cycle guard)", () => {
    const tree: Record<number, ProcNode> = {
      10: { ppid: 20, comm: "bun" },
      20: { ppid: 10, comm: "bun" }, // 10 ↔ 20 loop
    };
    expect(resolveHarnessPid(10, fixtureLookup(tree))).toBeNull();
  });

  test("a chain longer than MAX_PPID_DEPTH with no claude → null (bounded walk)", () => {
    const tree: Record<number, ProcNode> = {};
    // Build a straight chain pid n → n-1, all `bun`, longer than the bound; the
    // `claude` sits BEYOND the depth limit and must not be reached.
    const chainLen = MAX_PPID_DEPTH + 5;
    for (let i = chainLen; i >= 2; i--) tree[i] = { ppid: i - 1, comm: "bun" };
    tree[1] = { ppid: 0, comm: "claude" }; // beyond the bound
    expect(resolveHarnessPid(chainLen, fixtureLookup(tree))).toBeNull();
  });

  test("harness exactly at the depth bound IS resolved", () => {
    const tree: Record<number, ProcNode> = {};
    for (let i = MAX_PPID_DEPTH + 1; i >= 2; i--) tree[i] = { ppid: i - 1, comm: "bun" };
    // Put claude exactly MAX_PPID_DEPTH hops from the start.
    const start = MAX_PPID_DEPTH + 1;
    const harnessPid = start - MAX_PPID_DEPTH; // == 1... adjust to keep >1
    // Rebuild so the harness sits at depth == MAX_PPID_DEPTH and pid > 1.
    const tree2: Record<number, ProcNode> = {};
    for (let d = 0; d < MAX_PPID_DEPTH; d++) {
      tree2[100 + d] = { ppid: 100 + d + 1, comm: "bun" };
    }
    tree2[100 + MAX_PPID_DEPTH] = { ppid: 1, comm: "claude" };
    const r = resolveHarnessPid(100, fixtureLookup(tree2));
    expect(r).not.toBeNull();
    expect(r!.depth).toBe(MAX_PPID_DEPTH);
    void harnessPid;
  });
});

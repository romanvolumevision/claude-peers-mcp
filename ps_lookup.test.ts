/**
 * Tests for the real `ps`-backed ProcLookup (board-272 / #2041). This is the
 * production leg that `resolveHarnessPid` composes with in the broker; the
 * resolution LOGIC is covered by harness_resolve.test.ts against fixtured
 * topologies, and this file proves the real `ps` reader returns the correct
 * {ppid, comm} for a genuine parent→child pair.
 *
 * Run: bun test ps_lookup.test.ts
 */
import { describe, test, expect } from "bun:test";
import { psProcLookup } from "./shared/ps_lookup";
import { resolveHarnessPid } from "./shared/harness_resolve";

describe("psProcLookup (real ps)", () => {
  test("returns the true parent pid + comm of a real child", async () => {
    // The test process spawns `sleep`; its parent is therefore THIS process.
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      const node = psProcLookup(child.pid);
      expect(node).not.toBeNull();
      expect(node!.ppid).toBe(process.pid); // real ppid, straight from ps
      expect(node!.comm.endsWith("sleep")).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("a dead / unknown pid → null (degrade signal for the caller)", () => {
    expect(psProcLookup(2 ** 31 - 1)).toBeNull(); // no such pid
    expect(psProcLookup(0)).toBeNull();
    expect(psProcLookup(-1)).toBeNull();
  });

  test("composition: resolveHarnessPid over the REAL lookup finds no harness for a bare tree", async () => {
    // A bare `sleep` under the bun test runner has no `claude` parent at
    // depth-1 → null (the broker then degrades to sibling_only). Proves the
    // real lookup + resolver compose without a fixtured topology.
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      expect(resolveHarnessPid(child.pid, psProcLookup, 1)).toBeNull();
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

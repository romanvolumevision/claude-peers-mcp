/**
 * Open-016 Phase 3d (CONV-10639) — wait-for-broker-healthy (retires the
 * adapter self-spawn; launchd is the sole broker owner).
 *
 * Run: bun test wait-broker.test.ts
 */

import { describe, test, expect } from "bun:test";
import { waitForBrokerHealthy } from "./shared/wait_broker.ts";

const noSleep = async () => {};

describe("Open-016 waitForBrokerHealthy()", () => {
  test("returns true immediately when the broker is already healthy", async () => {
    let calls = 0;
    const ok = await waitForBrokerHealthy(
      async () => {
        calls++;
        return true;
      },
      { attempts: 30, intervalMs: 200, sleep: noSleep },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(1); // no extra polling once healthy
  });

  test("polls until the broker becomes healthy, then returns true", async () => {
    let calls = 0;
    const ok = await waitForBrokerHealthy(
      async () => {
        calls++;
        return calls >= 3; // healthy on the 3rd probe
      },
      { attempts: 30, intervalMs: 200, sleep: noSleep },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("returns false after exhausting attempts (never spawns a broker)", async () => {
    let calls = 0;
    const ok = await waitForBrokerHealthy(
      async () => {
        calls++;
        return false; // never healthy
      },
      { attempts: 5, intervalMs: 200, sleep: noSleep },
    );
    expect(ok).toBe(false);
    expect(calls).toBe(5); // exactly `attempts` probes, no spawn fallback
  });
});

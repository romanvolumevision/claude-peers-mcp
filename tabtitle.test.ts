/**
 * Tests for shared/tabtitle.ts (CONV-10613) — the broker/server-side tab-title
 * composer that the in-MCP set_summary hook drives onto the iTerm2 tab.
 *
 * Run: bun test tabtitle.test.ts
 */

import { describe, test, expect } from "bun:test";
import { composeTabTitle, profileToChannel, normaliseConv, CHANNEL_EMOJI } from "./shared/tabtitle";

describe("composeTabTitle", () => {
  test("full 4-segment string", () => {
    expect(composeTabTitle("green", "u60ssaqv", "CONV-10560", "Dispatch state dual-write fix")).toBe(
      "🟢 Green · u60ssaqv · CONV-10560 · Dispatch state dual-write fix",
    );
  });

  test("placeholder when peer_id absent (daemon paint time)", () => {
    expect(composeTabTitle("green", undefined, "CONV-10560", undefined)).toBe("🟢 Green · CONV-10560");
  });

  test("orchestrator special-case", () => {
    expect(composeTabTitle("orchestrator", "abc", "10560", "fleet")).toBe(
      "🐙 Orchestrator · abc · CONV-10560 · fleet",
    );
  });

  test("drops empty label", () => {
    expect(composeTabTitle("blue", "zzz", "CONV-1", "")).toBe("🔵 Blue · zzz · CONV-1");
    expect(composeTabTitle("blue", "zzz", "CONV-1", "   ")).toBe("🔵 Blue · zzz · CONV-1");
  });

  test("unknown colour → no emoji, capitalised slug", () => {
    expect(composeTabTitle("teal", "p", "CONV-9", undefined)).toBe("Teal · p · CONV-9");
  });

  test("bare numeric conv normalised; prefixed conv not doubled", () => {
    expect(composeTabTitle("red", undefined, "10560", undefined)).toBe("🔴 Red · CONV-10560");
    expect(composeTabTitle("red", undefined, "CONV-10560", undefined)).toBe("🔴 Red · CONV-10560");
  });

  test("all-empty falls back to Claude", () => {
    expect(composeTabTitle(undefined, undefined, undefined, undefined)).toBe("Claude");
    expect(composeTabTitle("", "", "", "")).toBe("Claude");
  });
});

describe("profileToChannel", () => {
  test("maps an ITERM_PROFILE string to its slug", () => {
    expect(profileToChannel("🟢 Green — GUPPI")).toBe("green");
    expect(profileToChannel("Blue Shadow")).toBe("blue");
    expect(profileToChannel("🐙 Orchestrator")).toBe("orchestrator");
  });

  test("returns undefined for a non-channel profile", () => {
    expect(profileToChannel("Plain Shell")).toBeUndefined();
    expect(profileToChannel("")).toBeUndefined();
  });
});

describe("normaliseConv", () => {
  test("normalises and tolerates absence", () => {
    expect(normaliseConv("10560")).toBe("CONV-10560");
    expect(normaliseConv("CONV-10560")).toBe("CONV-10560");
    expect(normaliseConv(undefined)).toBe("");
    expect(normaliseConv("")).toBe("");
  });
});

describe("CHANNEL_EMOJI parity", () => {
  test("carries all 9 colours + orchestrator", () => {
    for (const slug of [
      "pink",
      "blue",
      "cyan",
      "green",
      "yellow",
      "orange",
      "red",
      "gray",
      "purple",
      "orchestrator",
    ]) {
      expect(CHANNEL_EMOJI[slug]).toBeTruthy();
    }
  });
});

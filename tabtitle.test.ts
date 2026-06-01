/**
 * Tests for shared/tabtitle.ts (CONV-10613) — the broker/server-side tab-title
 * composer that the in-MCP set_summary hook drives onto the iTerm2 tab.
 *
 * Run: bun test tabtitle.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  composeTabTitle,
  profileToChannel,
  normaliseConv,
  CHANNEL_EMOJI,
  stripSummaryPrefix,
  topicWords,
  composeCompactTitle,
  composeSessionName,
  composeBadge,
} from "./shared/tabtitle";

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

// ---------------------------------------------------------------------------
// CONV-10613 three-field rename — PARITY with tests/iterm/test_tab_title.py.
// Every assertion here mirrors the Python suite verbatim (same inputs → same
// expected strings). This is the gate-4 parity proof: keep both in lockstep.
// ---------------------------------------------------------------------------

describe("stripSummaryPrefix", () => {
  test("kills the doubling", () => {
    expect(stripSummaryPrefix("🟠 Orange CONV-10655 — fleet_live conv_id cleanup DONE")).toBe(
      "fleet_live conv_id cleanup DONE",
    );
  });
  test("parenthesised CONV (orchestrator banner)", () => {
    expect(stripSummaryPrefix("🐙 ORCHESTRATOR (CONV-10613) — fleet at rest")).toBe("fleet at rest");
  });
  test("idempotent on a clean topic", () => {
    expect(stripSummaryPrefix("Dispatch state dual-write fix")).toBe("Dispatch state dual-write fix");
  });
  test("null / empty / whitespace", () => {
    expect(stripSummaryPrefix(null)).toBe("");
    expect(stripSummaryPrefix(undefined)).toBe("");
    expect(stripSummaryPrefix("")).toBe("");
    expect(stripSummaryPrefix("   ")).toBe("");
  });
  test("separator variants", () => {
    expect(stripSummaryPrefix("🟣 Purple — adopting pre-bind")).toBe("adopting pre-bind");
    expect(stripSummaryPrefix("🟣 Purple: adopting pre-bind")).toBe("adopting pre-bind");
    expect(stripSummaryPrefix("Green CONV-1 work item")).toBe("work item");
  });
});

describe("topicWords", () => {
  test("truncates to limit", () => {
    expect(topicWords("one two three four five")).toBe("one two three");
    expect(topicWords("one two three four five", 2)).toBe("one two");
    expect(topicWords("")).toBe("");
    expect(topicWords(null)).toBe("");
    expect(topicWords("solo")).toBe("solo");
  });
});

describe("composeCompactTitle (gate 1)", () => {
  test("emoji-only, <=3 words, de-doubled", () => {
    expect(
      composeCompactTitle(
        "orange",
        "1frhehsa",
        "CONV-10655",
        "🟠 Orange CONV-10655 — fleet_live conv_id cleanup DONE",
      ),
    ).toBe("🟠 · 1frhehsa · CONV-10655 · fleet_live conv_id cleanup");
  });
  test("orchestrator", () => {
    expect(
      composeCompactTitle(
        "orchestrator",
        "tx7jhaav",
        "CONV-10613",
        "🐙 ORCHESTRATOR (CONV-10613) — fleet at rest",
      ),
    ).toBe("🐙 · tx7jhaav · CONV-10613 · fleet at rest");
  });
  test("placeholder when peer_id + summary absent", () => {
    expect(composeCompactTitle("orange", undefined, "CONV-10655", undefined)).toBe("🟠 · CONV-10655");
  });
  test("unknown colour", () => {
    expect(composeCompactTitle("teal", "p", "CONV-9", "do a thing now")).toBe("Teal · p · CONV-9 · do a thing");
  });
});

describe("composeSessionName (gate 2)", () => {
  test("long: keeps colour word + full topic", () => {
    expect(
      composeSessionName(
        "orange",
        "1frhehsa",
        "CONV-10655",
        "🟠 Orange CONV-10655 — fleet_live conv_id cleanup DONE",
      ),
    ).toBe("🟠 Orange · 1frhehsa · CONV-10655 · fleet_live conv_id cleanup DONE");
  });
  test("distinct from compact", () => {
    const summary = "🟢 Green CONV-10560 — Dispatch state dual-write fix";
    const compact = composeCompactTitle("green", "u60ssaqv", "CONV-10560", summary);
    const session = composeSessionName("green", "u60ssaqv", "CONV-10560", summary);
    expect(compact).toBe("🟢 · u60ssaqv · CONV-10560 · Dispatch state dual-write");
    expect(session).toBe("🟢 Green · u60ssaqv · CONV-10560 · Dispatch state dual-write fix");
    expect(compact).not.toBe(session);
  });
});

describe("composeBadge (gate 3)", () => {
  test("colour worker", () => {
    expect(composeBadge("orange")).toBe("🟠 ORANGE");
    expect(composeBadge("purple")).toBe("🟣 PURPLE");
  });
  test("orchestrator", () => {
    expect(composeBadge("orchestrator")).toBe("🐙 ORCH");
  });
  test("channel-less role from summary", () => {
    expect(composeBadge("", "deploy worker running batch jobs")).toBe("DEPLOY WORKER");
    expect(composeBadge("", "")).toBe("CLAUDE");
    expect(composeBadge("unknownslug")).toBe("CLAUDE");
  });
});

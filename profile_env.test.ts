/**
 * Unit tests for resolveProfileEnv() — the ITERM_PROFILE → TMUX_PROFILE
 * fallback that lets a Forge tmux-spawned peer (no iTerm2) carry the same
 * channel identity the Mac iTerm fleet gets from ITERM_PROFILE.
 *
 * Run: bun test profile_env.test.ts
 */

import { describe, test, expect } from "bun:test";
import { resolveProfileEnv } from "./shared/profile_env";

describe("resolveProfileEnv", () => {
  test("returns ITERM_PROFILE when set (Mac iTerm path)", () => {
    expect(resolveProfileEnv({ ITERM_PROFILE: "🟢 Green — GUPPI" })).toBe(
      "🟢 Green — GUPPI",
    );
  });

  test("ITERM_PROFILE wins over TMUX_PROFILE when both set", () => {
    expect(
      resolveProfileEnv({
        ITERM_PROFILE: "🟢 Green — GUPPI",
        TMUX_PROFILE: "🔴 Red — GUPPI",
      }),
    ).toBe("🟢 Green — GUPPI");
  });

  test("falls back to TMUX_PROFILE when ITERM_PROFILE is unset (Forge tmux path)", () => {
    expect(resolveProfileEnv({ TMUX_PROFILE: "🟠 Orange — GUPPI" })).toBe(
      "🟠 Orange — GUPPI",
    );
  });

  test("falls back to TMUX_PROFILE when ITERM_PROFILE is empty string", () => {
    expect(
      resolveProfileEnv({ ITERM_PROFILE: "", TMUX_PROFILE: "🟣 Purple — GUPPI" }),
    ).toBe("🟣 Purple — GUPPI");
  });

  test("returns empty string when neither is set (Terminal/SSH/CI)", () => {
    expect(resolveProfileEnv({})).toBe("");
  });

  test("returns empty string when both are empty", () => {
    expect(resolveProfileEnv({ ITERM_PROFILE: "", TMUX_PROFILE: "" })).toBe("");
  });

  test("defaults to process.env when no arg passed", () => {
    const saved = { iterm: process.env.ITERM_PROFILE, tmux: process.env.TMUX_PROFILE };
    try {
      delete process.env.ITERM_PROFILE;
      process.env.TMUX_PROFILE = "🩵 Cyan — GUPPI";
      expect(resolveProfileEnv()).toBe("🩵 Cyan — GUPPI");
    } finally {
      if (saved.iterm === undefined) delete process.env.ITERM_PROFILE;
      else process.env.ITERM_PROFILE = saved.iterm;
      if (saved.tmux === undefined) delete process.env.TMUX_PROFILE;
      else process.env.TMUX_PROFILE = saved.tmux;
    }
  });
});

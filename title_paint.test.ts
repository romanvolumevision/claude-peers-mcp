/**
 * Tests for the tmux window-title paint leg (tmux-migration §5 step 5).
 *
 * Covers shared/tmux_paint.ts:
 *   • POSITIVE — when $TMUX is set (and $ITERM_SESSION_ID unset), the tmux
 *     rename path is taken with the correctly-composed COMPACT title, and
 *     automatic-rename is turned off first. No real tmux is spawned (the
 *     runner is mocked).
 *   • NEGATIVE — when $TMUX is unset, no tmux command is issued at all.
 *   • DEFAULT runner — proves the production path shells `child_process.execFile`
 *     with `tmux` + the argv (mocked, so no real tmux call happens), confirming
 *     the title travels as a SINGLE argv element (spaces / emoji / "·" intact —
 *     no shell, no word-splitting).
 *
 * Run: bun test title_paint.test.ts
 */

import { describe, test, expect, mock } from "bun:test";
import { composeCompactTitle } from "./shared/tabtitle";
import { paintTmuxWindowTitle } from "./shared/tmux_paint";

describe("paintTmuxWindowTitle — gate on $TMUX", () => {
  test("POSITIVE: $TMUX set → rename path taken with the composed compact title", async () => {
    // The exact compact title the iTerm `set name` leg would also use.
    const title = composeCompactTitle(
      "orange",
      "1frhehsa",
      "CONV-10655",
      "🟠 Orange CONV-10655 — fleet_live conv_id cleanup DONE",
    );
    expect(title).toBe("🟠 · 1frhehsa · CONV-10655 · fleet_live conv_id cleanup");

    const calls: string[][] = [];
    const runner = mock(async (args: string[]) => {
      calls.push(args);
    });

    const attempted = await paintTmuxWindowTitle(title, {
      env: { TMUX: "/tmp/tmux-501/default,1234,0", TMUX_PANE: "%3" },
      runner,
    });

    expect(attempted).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    // automatic-rename is turned off FIRST so the rename is the last writer.
    expect(calls[0]).toEqual(["set-window-option", "-t", "%3", "automatic-rename", "off"]);
    // The composed title is passed as a SINGLE argv element (spaces/emoji/"·"
    // survive — no shell word-splitting).
    expect(calls[1]).toEqual(["rename-window", "-t", "%3", title]);
  });

  test("POSITIVE: ITERM_SESSION_ID unset does not affect the tmux leg", async () => {
    const calls: string[][] = [];
    const runner = mock(async (args: string[]) => {
      calls.push(args);
    });
    const attempted = await paintTmuxWindowTitle("🟢 · abc · CONV-1 · do a thing", {
      env: { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%0", ITERM_SESSION_ID: "" },
      runner,
    });
    expect(attempted).toBe(true);
    expect(calls[1]).toEqual(["rename-window", "-t", "%0", "🟢 · abc · CONV-1 · do a thing"]);
  });

  test("falls back to current-window (no -t) when $TMUX_PANE is absent", async () => {
    const calls: string[][] = [];
    const runner = mock(async (args: string[]) => {
      calls.push(args);
    });
    const attempted = await paintTmuxWindowTitle("title-no-pane", {
      env: { TMUX: "/tmp/tmux-501/default,1,0" },
      runner,
    });
    expect(attempted).toBe(true);
    expect(calls[0]).toEqual(["set-window-option", "automatic-rename", "off"]);
    expect(calls[1]).toEqual(["rename-window", "title-no-pane"]);
  });

  test("NEGATIVE: $TMUX unset → no tmux command issued", async () => {
    const runner = mock(async () => {});
    const attempted = await paintTmuxWindowTitle("anything", {
      env: { ITERM_SESSION_ID: "w0t0p0:UUID-ABC" }, // iTerm, not tmux.
      runner,
    });
    expect(attempted).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  test("NEGATIVE: empty env → no tmux command issued", async () => {
    const runner = mock(async () => {});
    const attempted = await paintTmuxWindowTitle("anything", { env: {}, runner });
    expect(attempted).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  test("best-effort: a throwing runner is swallowed, never rejects", async () => {
    const logs: string[] = [];
    const runner = mock(async () => {
      throw new Error("tmux exploded");
    });
    const attempted = await paintTmuxWindowTitle("boom", {
      env: { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%1" },
      runner,
      log: (m) => logs.push(m),
    });
    // Attempted (we were inside tmux), but the throw was caught + logged.
    expect(attempted).toBe(true);
    expect(logs.some((m) => m.includes("paintTmuxWindowTitle failed"))).toBe(true);
  });
});

describe("default runner shells child_process.execFile (mocked)", () => {
  test("DEFAULT: drives `tmux rename-window` via execFile with the title as one argv element", async () => {
    // Mock child_process so the default runner does NOT spawn a real tmux. The
    // tmux_paint module resolves execFile off the child_process NAMESPACE at
    // call time, so this swap is seen by the already-imported default runner.
    const execFileCalls: Array<{ file: string; args: string[] }> = [];
    mock.module("child_process", () => ({
      execFile: (file: string, args: string[], cb: (err: Error | null) => void) => {
        execFileCalls.push({ file, args });
        cb(null); // simulate success
        return undefined as unknown;
      },
    }));

    const title = "🟣 · zzz · CONV-9 · plan #34 hardening";
    const attempted = await paintTmuxWindowTitle(title, {
      env: { TMUX: "/tmp/tmux-501/default,9,0", TMUX_PANE: "%9" },
      // no runner → exercise defaultTmuxRunner → execFile
    });

    expect(attempted).toBe(true);
    expect(execFileCalls).toHaveLength(2);
    for (const c of execFileCalls) expect(c.file).toBe("tmux");
    expect(execFileCalls[0]!.args).toEqual(["set-window-option", "-t", "%9", "automatic-rename", "off"]);
    // The whole title (spaces, emoji, "·", "#") is ONE argv element — no shell.
    expect(execFileCalls[1]!.args).toEqual(["rename-window", "-t", "%9", title]);

    // Restore the real module so other test files are unaffected.
    mock.restore();
  });
});

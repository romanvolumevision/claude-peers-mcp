/**
 * Open-016 Phase 3a (CONV-10639) — stdio transport close/error handling.
 *
 * PROBE RESULT: the CLI does NOT auto-respawn a non-zero-exit stdio MCP, so
 * the handler must emit a LOUD, actionable message (with the `/mcp` recovery
 * nudge) before exiting non-zero — never a silent exit.
 *
 * Run: bun test transport-close.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  transportCloseMessage,
  makeTransportCloseHandler,
  TRANSPORT_CLOSE_RECOVERY_NUDGE,
} from "./shared/transport_close.ts";

describe("Open-016 transportCloseMessage()", () => {
  test("close message is loud and carries the /mcp recovery nudge", () => {
    const msg = transportCloseMessage("close");
    expect(msg).toContain("ERROR");
    expect(msg).toContain("closed");
    expect(msg).toContain(TRANSPORT_CLOSE_RECOVERY_NUDGE);
    expect(msg).toContain("/mcp");
  });

  test("error message reflects the error kind and includes the detail", () => {
    const msg = transportCloseMessage("error", "EPIPE on stdout");
    expect(msg).toContain("ERROR");
    expect(msg).toContain("errored");
    expect(msg).toContain("EPIPE on stdout");
    expect(msg).toContain("/mcp");
  });
});

describe("Open-016 makeTransportCloseHandler()", () => {
  test("logs the loud message and exits NON-ZERO (never silent)", () => {
    const logged: string[] = [];
    const exits: number[] = [];
    const handler = makeTransportCloseHandler(
      { log: (m) => logged.push(m), exit: (c) => exits.push(c) },
      "close",
    );

    handler();

    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("ERROR");
    expect(logged[0]).toContain("/mcp");
    expect(exits).toEqual([1]); // non-zero, and exactly one exit
  });

  test("error handler surfaces an Error's message in the loud line", () => {
    const logged: string[] = [];
    const exits: number[] = [];
    const handler = makeTransportCloseHandler(
      { log: (m) => logged.push(m), exit: (c) => exits.push(c) },
      "error",
    );

    handler(new Error("stdin closed unexpectedly"));

    expect(logged[0]).toContain("stdin closed unexpectedly");
    expect(logged[0]).toContain("errored");
    expect(exits).toEqual([1]);
  });
});

/**
 * Open-016 Phase 3a (CONV-10639) — stdio transport close/error handling.
 *
 * PROBE RESULT (recorded in plans/mcp-role-split-open-016.md §6 Q1): the
 * running Claude Code CLI does NOT auto-respawn a stdio MCP that exits
 * non-zero. Stdio servers are local child processes and are treated as
 * terminal on exit — only HTTP/SSE servers auto-reconnect. So a silent
 * `process.exit(1)` would strand the user waiting for a respawn that never
 * comes (the exact CONV-10639 failure mode this whole phase fixes).
 *
 * Decision: on transport close/error, emit a LOUD, actionable message to
 * stderr (the broker log surface) with the `/mcp` recovery nudge BEFORE
 * exiting non-zero. Non-zero still signals failure cleanly (and lets a future
 * CLI that DOES respawn pick it up), but the recovery path today is the user
 * running `/mcp` and reconnecting.
 *
 * This module holds the message composer + a handler factory with injected
 * effects so the behaviour is unit-testable without booting the stdio MCP or
 * actually exiting the process.
 */

export const TRANSPORT_CLOSE_RECOVERY_NUDGE =
  "RECOVERY: run '/mcp' in your Claude Code session and reconnect the claude-peers server.";

/** Compose the loud stderr line for a transport close/error event. */
export function transportCloseMessage(kind: "close" | "error", detail?: string): string {
  const head =
    kind === "error"
      ? "ERROR: claude-peers MCP stdio transport errored"
      : "ERROR: claude-peers MCP stdio transport closed (server is exiting)";
  const tail = detail ? ` — ${detail}` : "";
  return `${head}${tail}. ${TRANSPORT_CLOSE_RECOVERY_NUDGE}`;
}

export interface TransportCloseEffects {
  /** Emit a loud line (stderr in production). */
  log: (msg: string) => void;
  /** Exit the process with the given code (process.exit in production). */
  exit: (code: number) => void;
}

/**
 * Build a transport close/error handler. It logs the loud recovery message
 * then exits non-zero. Effects are injected so a test can assert the message +
 * exit code without terminating the test runner.
 *
 * NOTE: we do NOT rely on auto-respawn (the probe says the CLI won't), so the
 * exit is a clean failure signal, not a "the supervisor will bring me back"
 * assumption.
 */
export function makeTransportCloseHandler(
  effects: TransportCloseEffects,
  kind: "close" | "error" = "close",
): (detail?: unknown) => void {
  return (detail?: unknown) => {
    const detailStr =
      detail instanceof Error ? detail.message : detail != null ? String(detail) : undefined;
    effects.log(transportCloseMessage(kind, detailStr));
    effects.exit(1);
  };
}

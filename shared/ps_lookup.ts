/**
 * Real {@link ProcLookup} backed by `ps` — the production process-tree reader
 * for board-272 harness resolution. Kept out of `harness_resolve.ts` so that
 * module stays pure (no Bun dependency) and unit-testable with injected lookups.
 *
 * `ps -o ppid=,comm= -p <pid>` is the same primitive the Python guppi-mcp caller
 * binding already relies on (`server.py::_process_parent_pid`); a matching
 * mechanism keeps the two tiers' pid reasoning identical. Fixed argv + an
 * int-validated pid + no shell → no injection surface. Any failure (pid gone,
 * `ps` missing, unpardseable line) collapses to null so the caller degrades to a
 * sibling-only kill rather than signalling a mis-resolved pid.
 */
import type { ProcNode, ProcLookup } from "./harness_resolve";

export function psProcLookup(pid: number): ProcNode | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const proc = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!proc.success) return null; // no such pid → ps exits non-zero
    const line = new TextDecoder().decode(proc.stdout).trim();
    if (!line) return null;
    // "  49373 claude"  or  "39152 /Applications/.../MacOS/claude"
    // ppid is the first whitespace-delimited token; comm is the rest (a path may
    // contain spaces on some platforms, so take everything after the first gap).
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    const ppidStr = m?.[1];
    const commStr = m?.[2];
    if (!ppidStr || !commStr) return null;
    const ppid = Number.parseInt(ppidStr, 10);
    const comm = commStr.trim();
    if (!Number.isInteger(ppid) || !comm) return null;
    return { ppid, comm };
  } catch {
    return null;
  }
}

export const _defaultProcLookup: ProcLookup = psProcLookup;

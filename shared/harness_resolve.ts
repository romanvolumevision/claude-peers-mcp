/**
 * Harness-pid resolution for /kill-peer (board-272 / #2041).
 *
 * The pid stored on a peer row is the pid the MCP adapter registered with —
 * `process.pid` inside `server.ts`, i.e. the `bun server.ts` process. That
 * process is a CHILD of the Claude Code harness (`claude`), NOT the harness
 * itself. Signalling the registered pid therefore kills the adapter sibling and
 * leaves the session tab alive — the board-272 zombie class (two specimens on
 * 2026-07-23/24 survived ~11h with dead registrations after a kill_peer that
 * reported ok).
 *
 * Ground truth (live `ps`, 2026-07-24):
 *   claude  49373  ppid 49321  pgid 49373   (harness — its own group leader)
 *   └─ bun  49397  ppid 49373  pgid 49373   (adapter — the REGISTERED pid)
 * Desktop-app-hosted sessions differ only in the harness's parent/group:
 *   claude  39152  ppid 39151  pgid 24109   (harness; pgid == the Electron app)
 *   └─ bun  39180  ppid 39152  pgid 24109   (adapter)
 *
 * Two consequences drive the design:
 *   1. The harness is reachable by walking the adapter's PPID chain up to the
 *      first `claude` process — one hop in the common case.
 *   2. Process-group kill is UNSAFE: a desktop-hosted harness shares its pgid
 *      with the whole Claude.app Electron tree, so `kill(-pgid)` would nuke the
 *      app. PPID-chain resolution targets exactly the harness pid instead.
 */

/** One node of the process tree: the parent pid + the process's `comm`. */
export interface ProcNode {
  ppid: number;
  /** `ps -o comm=` value — an executable path or bare name (e.g. `claude`). */
  comm: string;
}

/** Resolve a pid to its {ppid, comm}, or null if the pid is gone / unreadable. */
export type ProcLookup = (pid: number) => ProcNode | null;

/**
 * Is `comm` the Claude Code harness? `ps -o comm=` yields either a bare
 * `claude` (terminal launch) or an absolute path ending in `/claude`
 * (desktop-app launch). Match the basename exactly so siblings like
 * `claude-peers` / `bun` / a user binary named `claude-foo` never match.
 */
export function isHarnessComm(comm: string): boolean {
  if (!comm) return false;
  const trimmed = comm.trim();
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base === "claude";
}

/** Bounds the PPID walk so a cyclic / garbage `ps` view can never spin. */
export const MAX_PPID_DEPTH = 12;

export interface HarnessResolution {
  /** The resolved harness pid. */
  pid: number;
  /** Its `comm` (for audit/observability). */
  comm: string;
  /** Hops from the registered pid to the harness (0 == the registered pid itself). */
  depth: number;
}

/**
 * Walk the PPID chain up from `startPid` (the registered adapter pid) until a
 * `claude` harness process is found. Returns the harness pid, or null when no
 * `claude` ancestor exists within {@link MAX_PPID_DEPTH} hops (the caller then
 * degrades to a LOUD sibling-only kill rather than silently reporting a session
 * death that did not happen).
 *
 * The start pid itself is checked first: harmless (an adapter's comm is `bun`,
 * never `claude`, so depth-0 never matches in production) and makes the helper
 * total.
 */
export function resolveHarnessPid(
  startPid: number,
  lookup: ProcLookup,
  maxDepth: number = MAX_PPID_DEPTH,
): HarnessResolution | null {
  if (!Number.isInteger(startPid) || startPid <= 0) return null;
  let pid = startPid;
  const seen = new Set<number>();
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (seen.has(pid)) return null; // cycle guard (recycled-pid `ps` view)
    seen.add(pid);
    const node = lookup(pid);
    if (!node) return null; // pid gone / unreadable → cannot prove a harness
    if (isHarnessComm(node.comm)) return { pid, comm: node.comm, depth };
    if (!Number.isInteger(node.ppid) || node.ppid <= 1) return null; // hit init
    pid = node.ppid;
  }
  return null;
}

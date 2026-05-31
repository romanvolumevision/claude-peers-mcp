/**
 * Pid-keyed peer-id marker writer (CONV-10613).
 *
 * Shared by server.ts (self-register stamp) and broker.ts (register backstop)
 * so the two writers agree on the exact filename + format. The marker is how a
 * session reads back its own broker-assigned peer_id — the root gap this
 * feature closes, since the broker excludes self from list_peers and never
 * echoes own from_id.
 *
 * Keyed by **pid** rather than a claude_session_id: no session-id source exists
 * in this MCP, but process.pid (server self) and body.pid (broker) are always
 * available and agree for a given session.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Directory holding the pid-keyed markers: ~/.guppi/sessions/.
 *
 * Prefers $HOME (live) over os.homedir() so a test that redirects HOME in-process
 * resolves the same dir the marker is written to, and so the path matches the
 * Python reader's os.path.expanduser("~"). Falls back to os.homedir() when HOME
 * is unset.
 */
export function sessionsDir(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".guppi", "sessions");
}

/** Path of the pid-keyed marker for `pid`. */
export function markerPath(pid: number): string {
  return path.join(sessionsDir(), `${pid}.peerid`);
}

/**
 * Atomically write the pid-keyed marker (.tmp + rename). Best-effort: returns
 * true on success, false on any error (never throws — must not block
 * registration). `profile` and `extra` round-trip as additional KEY=value
 * lines so the tab-title refresh can read the current label/profile back.
 */
export function stampPeerIdFile(
  pid: number,
  id: string,
  profile = "",
  extra: Record<string, string> = {},
): boolean {
  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      `GUPPI_PEER_ID=${id}`,
      `ITERM_PROFILE=${profile}`,
      `PID=${pid}`,
      ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    ];
    const body = lines.join("\n") + "\n";
    const target = markerPath(pid);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

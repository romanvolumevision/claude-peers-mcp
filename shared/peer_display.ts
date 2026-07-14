/**
 * list_peers per-peer render (D-0060, CONV-10767).
 *
 * Extracted out of the inline `peers.map(...)` in server.ts so the exact text —
 * and the D-0060 back-compat invariant (a peer with NO display_name/slug renders
 * BYTE-IDENTICALLY to pre-D-0060) — is unit-testable without booting the stdio
 * MCP, matching the repo's existing pattern (tabtitle.ts / reregister.ts).
 *
 * Field order + labels mirror the pre-D-0060 inline renderer VERBATIM; the only
 * additions are the OPTIONAL `Name:` / `Slug:` lines, emitted ONLY when the peer
 * carries a non-empty value (grouped with the other identity metadata, after
 * Host/Machine, before Summary). DISPLAY-ONLY: the opaque `id` on the first line
 * remains the sole routing key — nothing here is ever used to address a peer.
 */

import type { Peer } from "./types.ts";

export function renderPeerBlock(p: Peer): string {
  const parts = [
    `ID: ${p.id}`,
    `PID: ${p.pid}`,
    `CWD: ${p.cwd}`,
  ];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.profile) parts.push(`Profile: ${p.profile}`);
  if (p.host) parts.push(`Host: ${p.host}`);
  if (p.machine) parts.push(`Machine: ${p.machine}`);
  // D-0060 readable name — display-only, shown next to the opaque id. Guarded on
  // a truthy value so an unlabeled peer (display_name '' or, from an un-upgraded
  // broker, undefined) adds no line → byte-identical to pre-D-0060.
  if (p.display_name) parts.push(`Name: ${p.display_name}`);
  if (p.slug) parts.push(`Slug: ${p.slug}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

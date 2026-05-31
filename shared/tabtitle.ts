/**
 * Tab-title composer (CONV-10613) — broker/server side.
 *
 * Mirrors scripts/iterm/tab_title.py in the GUPPI repo. Kept here (rather than
 * inline in server.ts) so it is unit-testable without booting the stdio MCP.
 * The composed string is what the in-MCP set_summary hook drives onto the tab
 * via the AppleScript `set name` leg.
 */

/** Canonical colour → emoji map (mirrors scripts/iterm/tab_title.py). */
export const CHANNEL_EMOJI: Record<string, string> = {
  pink: "🩷",
  blue: "🔵",
  cyan: "🩵",
  green: "🟢",
  yellow: "🟡",
  orange: "🟠",
  red: "🔴",
  gray: "⚪",
  purple: "🟣",
  orchestrator: "🐙",
};

/** Best-effort channel slug from an ITERM_PROFILE string (e.g. "🟢 Green — GUPPI"). */
export function profileToChannel(profile: string): string | undefined {
  const low = (profile ?? "").toLowerCase();
  for (const slug of Object.keys(CHANNEL_EMOJI)) {
    if (low.includes(slug)) return slug;
  }
  return undefined;
}

/** Normalise a CONV value to "CONV-<n>" form, or "" when absent. */
export function normaliseConv(conv: string | undefined): string {
  const c = (conv ?? "").trim();
  if (!c) return "";
  return c.toUpperCase().startsWith("CONV-") ? `CONV-${c.slice(5)}` : `CONV-${c}`;
}

/**
 * Compose "<emoji> <Colour> · <peer_id> · CONV-<n> · <label>", dropping any
 * empty segment. Orchestrator is the special prefix; unknown slugs render the
 * capitalised slug with no emoji; an all-empty input falls back to "Claude".
 */
export function composeTabTitle(
  channel: string | undefined,
  peerId: string | undefined,
  conv: string | undefined,
  label: string | undefined,
): string {
  const segments: string[] = [];
  const slug = (channel ?? "").toLowerCase();
  if (slug === "orchestrator") {
    segments.push("🐙 Orchestrator");
  } else if (slug) {
    const emoji = CHANNEL_EMOJI[slug] ?? "";
    const colour = slug.charAt(0).toUpperCase() + slug.slice(1);
    segments.push(`${emoji} ${colour}`.trim());
  }
  if (peerId && peerId.trim()) segments.push(peerId.trim());
  const convSeg = normaliseConv(conv);
  if (convSeg) segments.push(convSeg);
  if (label && label.trim()) segments.push(label.trim());
  return segments.join(" · ") || "Claude";
}

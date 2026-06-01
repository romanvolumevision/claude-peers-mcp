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

// ---------------------------------------------------------------------------
// CONV-10613 three-field rename. These mirror scripts/iterm/tab_title.py
// VERBATIM (same inputs → same outputs); the parity test vectors in
// tabtitle.test.ts + tests/iterm/test_tab_title.py are the gate-4 proof.
// ---------------------------------------------------------------------------

/** Colour / role words that may lead a peer's live summary banner. */
const PREFIX_WORDS = new Set<string>([...Object.keys(CHANNEL_EMOJI), "orch"]);

/**
 * Strip a leading "<emoji> <Colour> [CONV-<n>] [—|·|-|:]" identity banner from a
 * live `summary` so only the bare work-topic remains. Without this, feeding the
 * raw summary into a composer double-paints the emoji+colour the composer
 * already prepends — the CONV-10613 doubling bug
 * ("🟠 Orange · 1frhehsa · CONV-10655 · 🟠 Orange CONV-10655"). Idempotent on an
 * already-bare topic; never throws.
 */
export function stripSummaryPrefix(text: string | undefined | null): string {
  let s = (text ?? "").trim();
  if (!s) return "";
  // Leading channel emoji.
  for (const emoji of Object.values(CHANNEL_EMOJI)) {
    if (s.startsWith(emoji)) {
      s = s.slice(emoji.length).replace(/^\s+/, "");
      break;
    }
  }
  // Leading colour / role word.
  const spaceIdx = s.indexOf(" ");
  const head = spaceIdx === -1 ? s : s.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : s.slice(spaceIdx + 1);
  if (PREFIX_WORDS.has(head.toLowerCase().replace(/^[:—·\-()]+|[:—·\-()]+$/g, ""))) {
    s = spaceIdx === -1 ? "" : rest.replace(/^\s+/, "");
  }
  // Separator run, CONV-<n> (optionally parenthesised), separator run.
  s = s.replace(/^[\s:—·\-]+/, "");
  s = s.replace(/^\(?\s*CONV-\d+\s*\)?/i, "");
  s = s.replace(/^[\s:—·\-]+/, "");
  return s.trim();
}

/** First `limit` whitespace-delimited words of `text` (the compact topic). */
export function topicWords(text: string | undefined | null, limit = 3): string {
  return (text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, limit)
    .join(" ");
}

/**
 * COMPACT tab-strip identifier (CONV-10613 gate 1):
 * "<emoji> · <peer_id> · CONV-<n> · <topic ≤3 words>" — emoji ONLY (no colour
 * word), topic = first three words of the prefix-stripped summary.
 */
export function composeCompactTitle(
  channel: string | undefined,
  peerId: string | undefined,
  conv: string | undefined,
  summary: string | undefined,
  label?: string | undefined,
): string {
  const segments: string[] = [];
  const slug = (channel ?? "").toLowerCase();
  const emoji = CHANNEL_EMOJI[slug] ?? "";
  if (emoji) segments.push(emoji);
  else if (slug) segments.push(slug.charAt(0).toUpperCase() + slug.slice(1));
  if (peerId && peerId.trim()) segments.push(peerId.trim());
  const convSeg = normaliseConv(conv);
  if (convSeg) segments.push(convSeg);
  // CONV-10613 (B — Roman directive): prefer the stable work-label (verbatim,
  // e.g. "Plan #34 - LLM Hardening") over the churning live summary. Only fall
  // back to the first 3 words of the prefix-stripped summary when no label is
  // set. Parity with the GUPPI daemon paint (scripts/iterm/tab_title.py), which
  // already sources the topic from .state.json `label`.
  const topic = (label && label.trim())
    ? label.trim()
    : topicWords(stripSummaryPrefix(summary), 3);
  if (topic) segments.push(topic);
  return segments.join(" · ") || "Claude";
}

/**
 * LONGER descriptive session name (CONV-10613 gate 2):
 * "<emoji> <Colour> · <peer_id> · CONV-<n> · <full topic>" — keeps the colour
 * word + the full prefix-stripped topic. Reuses composeTabTitle.
 */
export function composeSessionName(
  channel: string | undefined,
  peerId: string | undefined,
  conv: string | undefined,
  summary: string | undefined,
  label?: string | undefined,
): string {
  // CONV-10613 (B): same work-label-over-summary precedence as composeCompactTitle.
  const topic = (label && label.trim()) ? label.trim() : stripSummaryPrefix(summary);
  return composeTabTitle(channel, peerId, conv, topic);
}

/**
 * iTerm2 badge text (CONV-10613 gate 3): colour worker → "<emoji> <COLOUR>"
 * (matches the DynamicProfile Badge Text); orchestrator → "🐙 ORCH"; a
 * channel-less / unknown peer → a 1-2 word role from the stripped summary
 * (upper-cased), falling back to "CLAUDE".
 */
export function composeBadge(channel: string | undefined, summary?: string): string {
  const slug = (channel ?? "").toLowerCase();
  if (slug === "orchestrator") return "🐙 ORCH";
  const emoji = CHANNEL_EMOJI[slug] ?? "";
  if (emoji) return `${emoji} ${slug.toUpperCase()}`;
  const role = topicWords(stripSummaryPrefix(summary), 2);
  return role ? role.toUpperCase() : "CLAUDE";
}

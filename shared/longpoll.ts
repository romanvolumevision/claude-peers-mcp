/**
 * board-10 / #3567 — long-poll delivery helpers (CONV-11507).
 *
 * Pure, boot-free logic extracted from broker.ts + server.ts so the risky
 * decisions (wake fan-out, client-pacing fallback, the peer-list hoist) are
 * unit-testable without spawning a broker / booting the stdio MCP. See
 * longpoll_helpers.test.ts.
 *
 * The delivery path used to be poll-GATED only: the client polled every 1000ms
 * and the broker returned immediately, so a message waited up to ~1s. Long-poll
 * holds the recipient's /poll-messages open until an insert for that recipient,
 * a bounded timeout, or the client disconnecting — turning delivery from
 * "next-poll" into "near-instant" while REDUCING idle poll load (one held
 * connection vs a poll every second).
 */

import type { Message, Peer } from "./types.ts";

/** Bounds the client-requested hold to [0, maxMs]. Any non-finite / negative /
 * missing value coerces to 0 (= "do not hold" — the old-client / immediate
 * path). Broker-side: an unrecognised or absent `wait_ms` therefore behaves
 * byte-identically to the pre-long-poll broker. */
export function clampWaitMs(raw: unknown, maxMs: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  if (n <= 0) return 0;
  return Math.min(n, maxMs);
}

/** A held /poll-messages request waiting to be woken. `resolve` is called at
 * most once (the caller guards idempotency) on wake OR timeout OR disconnect. */
export interface Waiter {
  resolve: () => void;
}

/**
 * Per-peer wake fan-out for long-poll (gate 2 — no thundering herd). An insert
 * for recipient R wakes ONLY R's held requests; every other peer's hold is
 * untouched. Registration/deregistration is balanced so a completed hold leaves
 * no residue (gate 3 — no connection leak under many idle peers): an emptied
 * peer Set is dropped from the map entirely.
 */
export class WaiterRegistry {
  private readonly map = new Map<string, Set<Waiter>>();

  register(peerId: string, w: Waiter): void {
    let set = this.map.get(peerId);
    if (!set) {
      set = new Set<Waiter>();
      this.map.set(peerId, set);
    }
    set.add(w);
  }

  deregister(peerId: string, w: Waiter): void {
    const set = this.map.get(peerId);
    if (!set) return;
    set.delete(w);
    if (set.size === 0) this.map.delete(peerId);
  }

  /** Resolve every waiter currently held for `peerId`. Returns the count woken.
   * Iterates a SNAPSHOT so a resolve() that synchronously deregisters (mutating
   * the Set) is safe during iteration. */
  wake(peerId: string): number {
    const set = this.map.get(peerId);
    if (!set || set.size === 0) return 0;
    const snapshot = [...set];
    for (const w of snapshot) w.resolve();
    return snapshot.length;
  }

  /** Number of held waiters — for a single peer, or across all peers when
   * `peerId` is omitted. Used by tests to assert no-leak. */
  size(peerId?: string): number {
    if (peerId !== undefined) return this.map.get(peerId)?.size ?? 0;
    let total = 0;
    for (const set of this.map.values()) total += set.size;
    return total;
  }
}

/**
 * Client-side next-poll pacing — the fallback belt (gate 4). When the broker
 * honoured the long-poll (`long_poll === true`) the client re-polls IMMEDIATELY
 * (0) to re-enter a continuous hold → near-instant delivery. Otherwise — an OLD
 * broker that doesn't set the flag, OR an error path where the caller passes
 * `undefined` — it falls back to the interval floor so a broker that can't (or
 * momentarily won't) long-poll can NEVER leave a peer deaf.
 */
export function nextPollDelayMs(
  resp: { long_poll?: boolean } | undefined,
  intervalMs: number,
): number {
  return resp?.long_poll === true ? 0 : intervalMs;
}

/** Dependencies for {@link processInbound}, injected so the drain logic is
 * testable without a broker or the MCP transport. */
export interface ProcessInboundDeps {
  /** Fetch the peer list ONCE per drain (not per message). */
  fetchPeers: () => Promise<Peer[]>;
  /** Push a single message to the session, with its resolved sender (or
   * undefined when the lookup failed / the sender is unknown). */
  push: (msg: Message, sender: Peer | undefined) => Promise<void>;
}

/**
 * Process a drained batch of inbound messages (gate 5 — kill the N-round-trip
 * amplifier). The pre-fix loop issued a `/list-peers` round-trip PER message;
 * this fetches the peer list exactly ONCE, builds an id→peer map, and pushes
 * each message with its resolved sender. A fetch failure is non-fatal: every
 * message is still pushed (without sender context) so a broker blip during
 * enrichment can never drop a delivery.
 */
export async function processInbound(
  messages: Message[],
  deps: ProcessInboundDeps,
): Promise<void> {
  if (messages.length === 0) return;

  const peersById = new Map<string, Peer>();
  try {
    const peers = await deps.fetchPeers();
    for (const p of peers) peersById.set(p.id, p);
  } catch {
    // Non-critical — enrichment only. Fall through and push with no sender.
  }

  for (const msg of messages) {
    await deps.push(msg, peersById.get(msg.from_id));
  }
}

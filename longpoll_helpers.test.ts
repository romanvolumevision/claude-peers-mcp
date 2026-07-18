/**
 * board-10 / #3567 — pure long-poll helpers (CONV-11507). Unit tests for the
 * extracted, boot-free logic in shared/longpoll.ts so the risky decisions are
 * pinned without spawning a broker:
 *   gate 2 — WaiterRegistry.wake(R) resolves ONLY R's waiters (no thundering
 *            herd) and leaves no residue after deregister (no connection leak).
 *   gate 4 — nextPollDelayMs: long_poll:true → re-poll immediately (0); a missing
 *            flag (old broker) OR an error (undefined) → the interval floor, so a
 *            broker that doesn't long-poll can NEVER leave a peer deaf.
 *   gate 5 — processInbound fetches the peer list ONCE per drain (kills the
 *            N-round-trip amplifier) and still pushes every message even when the
 *            sender lookup fails.
 * Also clampWaitMs bounds the client-requested hold.
 *
 * Run: bun test longpoll_helpers.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  clampWaitMs,
  WaiterRegistry,
  nextPollDelayMs,
  processInbound,
} from "./shared/longpoll.ts";
import type { Message, Peer } from "./shared/types.ts";

function mkMsg(fromId: string, text: string): Message {
  return { id: 0, from_id: fromId, to_id: "me", text, sent_at: "2026-01-01T00:00:00Z", delivered: false };
}

function mkPeer(id: string, summary: string): Peer {
  return {
    id,
    pid: 1,
    cwd: "/tmp",
    git_root: null,
    tty: null,
    profile: "",
    host: "",
    machine: "",
    display_name: "",
    slug: "",
    summary,
    registered_at: "2026-01-01T00:00:00Z",
    last_seen: "2026-01-01T00:00:00Z",
  };
}

describe("clampWaitMs — bound the client-requested hold to [0, max]", () => {
  test("passes a normal value through", () => {
    expect(clampWaitMs(5000, 30000)).toBe(5000);
  });
  test("clamps above max", () => {
    expect(clampWaitMs(99999, 30000)).toBe(30000);
  });
  test("floors a negative to 0", () => {
    expect(clampWaitMs(-5, 30000)).toBe(0);
  });
  test("coerces non-numbers / NaN / undefined to 0", () => {
    expect(clampWaitMs(undefined, 30000)).toBe(0);
    expect(clampWaitMs("nope", 30000)).toBe(0);
    expect(clampWaitMs(Number.NaN, 30000)).toBe(0);
    expect(clampWaitMs(null, 30000)).toBe(0);
  });
});

describe("gate 2 — WaiterRegistry wakes only the target peer", () => {
  test("wake(R1) resolves R1's waiter, not R2's", () => {
    const reg = new WaiterRegistry();
    let r1woke = false;
    let r2woke = false;
    reg.register("R1", { resolve: () => { r1woke = true; } });
    reg.register("R2", { resolve: () => { r2woke = true; } });
    const n = reg.wake("R1");
    expect(n).toBe(1);
    expect(r1woke).toBe(true);
    expect(r2woke).toBe(false);
  });

  test("multiple waiters for the same peer all wake", () => {
    const reg = new WaiterRegistry();
    let a = false;
    let b = false;
    reg.register("R", { resolve: () => { a = true; } });
    reg.register("R", { resolve: () => { b = true; } });
    expect(reg.wake("R")).toBe(2);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  test("register/deregister leaves no residue and the map is emptied (no leak)", () => {
    const reg = new WaiterRegistry();
    const w = { resolve: () => {} };
    reg.register("R1", w);
    expect(reg.size("R1")).toBe(1);
    reg.deregister("R1", w);
    expect(reg.size("R1")).toBe(0);
    expect(reg.size()).toBe(0); // the peer's empty Set is dropped from the map
  });

  test("waking a peer with no waiters is a no-op", () => {
    const reg = new WaiterRegistry();
    expect(reg.wake("nobody")).toBe(0);
  });
});

describe("gate 4 — nextPollDelayMs picks the client's next-poll pacing (fallback belt)", () => {
  test("long_poll:true → re-poll immediately (continuous long-poll)", () => {
    expect(nextPollDelayMs({ long_poll: true }, 1000)).toBe(0);
  });
  test("no long_poll flag (old / non-long-poll broker) → interval floor", () => {
    expect(nextPollDelayMs({}, 1000)).toBe(1000);
    expect(nextPollDelayMs({ long_poll: false }, 1000)).toBe(1000);
  });
  test("undefined response (error path) → interval floor — never deaf", () => {
    expect(nextPollDelayMs(undefined, 1000)).toBe(1000);
  });
});

describe("gate 5 — processInbound hoists the peer-list fetch out of the per-message loop", () => {
  test("fetches the peer list ONCE for N messages, pushes each with its sender", async () => {
    const msgs: Message[] = [mkMsg("a", "1"), mkMsg("a", "2"), mkMsg("b", "3")];
    let fetchCount = 0;
    const peers: Peer[] = [mkPeer("a", "sum-a"), mkPeer("b", "sum-b")];
    const pushed: Array<{ text: string; from: string | undefined }> = [];
    await processInbound(msgs, {
      fetchPeers: async () => {
        fetchCount++;
        return peers;
      },
      push: async (m, sender) => {
        pushed.push({ text: m.text, from: sender?.id });
      },
    });
    expect(fetchCount).toBe(1); // ONCE — not 3× (the amplifier fix)
    expect(pushed.map((p) => p.text)).toEqual(["1", "2", "3"]);
    expect(pushed[0]?.from).toBe("a");
    expect(pushed[2]?.from).toBe("b");
  });

  test("empty batch does no peer fetch and no push", async () => {
    let fetchCount = 0;
    let pushCount = 0;
    await processInbound([], {
      fetchPeers: async () => {
        fetchCount++;
        return [];
      },
      push: async () => {
        pushCount++;
      },
    });
    expect(fetchCount).toBe(0);
    expect(pushCount).toBe(0);
  });

  test("a fetchPeers failure still pushes every message (best-effort sender lookup)", async () => {
    const msgs: Message[] = [mkMsg("x", "only")];
    let pushCount = 0;
    let sawSender: string | undefined = "sentinel";
    await processInbound(msgs, {
      fetchPeers: async () => {
        throw new Error("broker blip");
      },
      push: async (_m, sender) => {
        pushCount++;
        sawSender = sender?.id;
      },
    });
    expect(pushCount).toBe(1); // message still delivered
    expect(sawSender).toBeUndefined(); // no sender context, but not dropped
  });
});

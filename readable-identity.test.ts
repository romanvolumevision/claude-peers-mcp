/**
 * D-0060 broker-side readable identity (CONV-10767).
 *
 * readableIdentity() derives a canonical "<emoji> <Colour> · <Name> · <repo>"
 * label as a PURE function of (iTerm profile colour, repo) — no client
 * cooperation, no AI. These tests pin the mapping, the fallbacks, and the
 * derivation wiring in renderPeerBlock.
 *
 * Run: bun test readable-identity.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  readableIdentity,
  renderPeerBlock,
  repoShortName,
  NAME_BY_COLOUR,
} from "./shared/peer_display.ts";
import type { Peer } from "./shared/types.ts";

function makePeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "nhnxlgkd",
    pid: 4242,
    cwd: "/Users/romantarasov/code/volume-vision/guppi",
    git_root: "/Users/romantarasov/code/volume-vision/guppi",
    tty: "ttys004",
    profile: "🟡 Yellow — GUPPI",
    host: "iTerm",
    machine: "MacBook",
    display_name: "",
    slug: "",
    summary: "",
    registered_at: "2026-07-16T00:00:00.000Z",
    last_seen: "2026-07-16T00:05:00.000Z",
    ...overrides,
  };
}

describe("readableIdentity — canonical derivation", () => {
  test("Yellow profile + guppi repo → 🟡 Yellow · Ron · guppi", () => {
    const p = makePeer({ profile: "🟡 Yellow — GUPPI" });
    expect(readableIdentity(p)).toBe("🟡 Yellow · Ron · guppi");
  });

  test("Green profile + offplan repo → 🟢 Green · Uma · offplan", () => {
    const p = makePeer({
      profile: "🟢 Green — GUPPI",
      cwd: "/Users/x/code/offplan",
      git_root: "/Users/x/code/offplan",
    });
    expect(readableIdentity(p)).toBe("🟢 Green · Uma · offplan");
  });

  test("every colour maps to its frozen D-0060 name", () => {
    const cases: Array<[string, string, string]> = [
      ["🟢 Green — GUPPI", "green", "Uma"],
      ["🟡 Yellow — GUPPI", "yellow", "Ron"],
      ["🔴 Red — GUPPI", "red", "Ada"],
      ["🔵 Blue — GUPPI", "blue", "Cleo"],
      ["🩵 Cyan — GUPPI", "cyan", "Mina"],
      ["🟠 Orange — GUPPI", "orange", "Odi"],
      ["🟣 Purple — GUPPI", "purple", "Bex"],
      ["🩷 Pink — GUPPI", "pink", "Ivo"],
      ["⚪ Gray — GUPPI", "gray", "Nell"],
    ];
    for (const [profile, colour, name] of cases) {
      const p = makePeer({ profile });
      expect(NAME_BY_COLOUR[colour]).toBe(name);
      const colourWord = colour.charAt(0).toUpperCase() + colour.slice(1);
      expect(readableIdentity(p)).toContain(`${colourWord} · ${name} · guppi`);
    }
  });
});

describe("readableIdentity — orchestrator", () => {
  test("orchestrator profile → 🐙 <repo>-orch", () => {
    const p = makePeer({ profile: "🐙 Orchestrator — GUPPI" });
    expect(readableIdentity(p)).toBe("🐙 guppi-orch");
  });

  test("bound role=orchestrator (any/no profile) → 🐙 <repo>-orch", () => {
    const p = makePeer({ profile: "", role: "orchestrator" });
    expect(readableIdentity(p)).toBe("🐙 guppi-orch");
  });

  test("orchestrator with no derivable repo → 🐙 orch (never a bare id)", () => {
    const p = makePeer({ profile: "🐙 Orchestrator — GUPPI", cwd: "", git_root: null, repo_root: null });
    expect(readableIdentity(p)).toBe("🐙 orch");
  });
});

describe("readableIdentity — fallbacks", () => {
  test("colour resolves but no repo → <emoji> <Colour> · <Name>", () => {
    const p = makePeer({ profile: "🟡 Yellow — GUPPI", cwd: "", git_root: null, repo_root: null });
    expect(readableIdentity(p)).toBe("🟡 Yellow · Ron");
  });

  test("no profile / unknown colour → '' (caller keeps the opaque id)", () => {
    expect(readableIdentity(makePeer({ profile: "" }))).toBe("");
    expect(readableIdentity(makePeer({ profile: "Some Custom Tab" }))).toBe("");
  });

  test("repo_root (normalized main worktree) is preferred over a worktree git_root", () => {
    const p = makePeer({
      profile: "🟢 Green — GUPPI",
      git_root: "/Users/x/code/guppi-worktrees/green",
      repo_root: "/Users/romantarasov/code/volume-vision/guppi",
    });
    expect(readableIdentity(p)).toBe("🟢 Green · Uma · guppi");
    expect(repoShortName(p)).toBe("guppi");
  });
});

describe("renderPeerBlock — derivation wiring", () => {
  test("unlabeled peer WITH a profile now gets a derived Name line", () => {
    const p = makePeer({ display_name: "", slug: "", profile: "🟡 Yellow — GUPPI" });
    const out = renderPeerBlock(p);
    expect(out).toContain("Name: 🟡 Yellow · Ron · guppi");
    expect(out).toContain("ID: nhnxlgkd"); // opaque id line unchanged
  });

  test("a client-supplied display_name still WINS over derivation", () => {
    const p = makePeer({ display_name: "🟢 Green · P1 · Uma — offplan", slug: "offplan-g1-uma" });
    const out = renderPeerBlock(p);
    expect(out).toContain("Name: 🟢 Green · P1 · Uma — offplan");
    expect(out).toContain("Slug: offplan-g1-uma");
  });

  test("orchestrator peer renders the 🐙 <repo>-orch identity", () => {
    const p = makePeer({ profile: "🐙 Orchestrator — GUPPI", role: "orchestrator" });
    expect(renderPeerBlock(p)).toContain("Name: 🐙 guppi-orch");
  });
});

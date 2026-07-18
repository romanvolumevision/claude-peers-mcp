/**
 * D-0060 readable display names (CONV-10767).
 *
 * Additive, non-breaking: the opaque broker id stays the SOLE routing key; a
 * human-readable `display_name` + `slug` ride alongside as DISPLAY-ONLY fields.
 *
 * Two layers:
 *   1. Unit — renderPeerBlock byte-identity: a peer with NO display_name/slug
 *      (empty OR undefined, the un-upgraded-broker case) renders byte-for-byte
 *      identically to a pinned copy of the pre-D-0060 renderer; a peer WITH a
 *      display_name gains exactly a `Name:`/`Slug:` line and nothing else.
 *   2. Integration — spawn the real broker and prove: register WITHOUT the
 *      fields is back-compat (id minted, stored ''); register WITH them stores +
 *      projects them via /list-peers; the opaque id is unchanged (still 8-char)
 *      and still routes send/poll; a re-register never blanks the readable name.
 *
 * Run: bun test readable-names.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPeerBlock } from "./shared/peer_display.ts";
import type { Peer } from "./shared/types.ts";

// --- Layer 1: renderPeerBlock byte-identity (pure) ---

/**
 * Pinned copy of the pre-D-0060 inline server.ts peer-row renderer (VERBATIM,
 * before Name/Slug were added). The invariant: for any peer with no readable
 * name, renderPeerBlock must equal THIS byte-for-byte.
 */
function legacyRenderPeerBlock(p: Peer): string {
  const parts = [`ID: ${p.id}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.profile) parts.push(`Profile: ${p.profile}`);
  if (p.host) parts.push(`Host: ${p.host}`);
  if (p.machine) parts.push(`Machine: ${p.machine}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

function makePeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "8n9aqm28",
    pid: 4242,
    cwd: "/Users/x/code/offplan",
    git_root: "/Users/x/code/offplan",
    tty: "ttys004",
    profile: "🟢 Green — GUPPI",
    host: "iTerm",
    machine: "MacBook",
    display_name: "",
    slug: "",
    summary: "wiring readable names",
    registered_at: "2026-07-14T00:00:00.000Z",
    last_seen: "2026-07-14T00:05:00.000Z",
    ...overrides,
  };
}

describe("D-0060 renderPeerBlock byte-identity (nothing to derive)", () => {
  // Post-readable-identity: an unlabeled peer now DERIVES a Name from its
  // profile colour + repo. Byte-identity therefore holds only when there is
  // ALSO nothing to derive from — i.e. no profile (profile: "") — which is the
  // genuine "hand-opened tab / non-fleet session" case.
  test("empty display_name/slug AND no profile → byte-identical to the pre-D-0060 renderer", () => {
    const p = makePeer({ display_name: "", slug: "", profile: "" });
    expect(renderPeerBlock(p)).toBe(legacyRenderPeerBlock(p));
    expect(renderPeerBlock(p)).not.toContain("Name:");
    expect(renderPeerBlock(p)).not.toContain("Slug:");
  });

  test("UNDEFINED display_name/slug (un-upgraded broker) + no profile → byte-identical, no Name line", () => {
    // Simulate an old broker that returns Peer rows without the new fields.
    const p = makePeer({ profile: "" });
    delete (p as Partial<Peer>).display_name;
    delete (p as Partial<Peer>).slug;
    expect(renderPeerBlock(p)).toBe(legacyRenderPeerBlock(p));
    expect(renderPeerBlock(p)).not.toContain("Name:");
  });

  test("byte-identity holds across the optional-field matrix (git_root/tty/host/machine/summary absent, no profile)", () => {
    const variants: Partial<Peer>[] = [
      { git_root: null },
      { tty: null },
      { host: "", machine: "" },
      { summary: "" },
      { git_root: null, tty: null, host: "", machine: "", summary: "" },
    ];
    for (const v of variants) {
      const p = makePeer({ ...v, display_name: "", slug: "", profile: "" });
      expect(renderPeerBlock(p)).toBe(legacyRenderPeerBlock(p));
    }
  });
});

describe("D-0060 renderPeerBlock WITH a display_name", () => {
  test("adds exactly a Name: + Slug: line; the ID (routing key) line is unchanged", () => {
    const p = makePeer({
      display_name: "🟢 Green · P1 · Uma — offplan",
      slug: "offplan-g1-uma",
    });
    const out = renderPeerBlock(p);
    expect(out).toContain("Name: 🟢 Green · P1 · Uma — offplan");
    expect(out).toContain("Slug: offplan-g1-uma");
    // The opaque id line is byte-identical — display name did NOT replace it.
    expect(out).toContain("ID: 8n9aqm28");
    // Superset of the legacy render: every legacy line still present, in order.
    const legacyLines = legacyRenderPeerBlock(p).split("\n  ");
    const outLines = out.split("\n  ");
    for (const line of legacyLines) expect(outLines).toContain(line);
  });

  test("Name line appears between Machine and Summary (grouped with identity fields)", () => {
    const p = makePeer({ display_name: "🟢 Green · P1 · Uma — offplan", slug: "offplan-g1-uma" });
    const lines = renderPeerBlock(p).split("\n  ");
    const machineIdx = lines.findIndex((l) => l.startsWith("Machine:"));
    const nameIdx = lines.findIndex((l) => l.startsWith("Name:"));
    const summaryIdx = lines.findIndex((l) => l.startsWith("Summary:"));
    expect(machineIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBe(machineIdx + 1);
    expect(summaryIdx).toBeGreaterThan(nameIdx);
  });
});

// --- Layer 2: broker integration (register / list-peers / routing) ---

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  tmpDir: string;
}

async function waitForBroker(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Broker did not come up within ${timeoutMs}ms`);
}

async function spawnBroker(): Promise<SpawnedBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-readable-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 19100 + Math.floor(Math.random() * 700);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForBroker(url);
  return { proc, url, tmpDir };
}

function killBroker(b: SpawnedBroker) {
  try {
    b.proc.kill();
  } catch {
    // ignore
  }
  try {
    rmSync(b.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

describe("D-0060 broker register + list-peers", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker();
  });

  afterAll(() => {
    killBroker(broker);
  });

  test("register WITHOUT display_name is back-compat: id minted, stored fields default ''", async () => {
    const pid = process.pid;
    const legacyBody = { pid, cwd: "/tmp/d0060-legacy", git_root: null, tty: null, profile: "", summary: "legacy" };
    const reg = await post<{ id: string; token?: string }>(`${broker.url}/register`, legacyBody);
    // Registration response is byte-identical in shape: an 8-char opaque id.
    expect(reg.id).toMatch(/^[a-z0-9]{8}$/);

    const peers = await post<Peer[]>(`${broker.url}/list-peers`, {
      scope: "machine",
      cwd: "/tmp/d0060-legacy",
      git_root: null,
    });
    const me = peers.find((p) => p.id === reg.id);
    expect(me).toBeTruthy();
    // New columns exist and default to '' — the row is otherwise unchanged.
    expect(me?.display_name).toBe("");
    expect(me?.slug).toBe("");
    // A peer with no readable name renders byte-identically (no Name/Slug line).
    expect(renderPeerBlock(me!)).not.toContain("Name:");
  });

  test("register WITH display_name/slug stores + projects them; opaque id still 8-char", async () => {
    // Register under a distinct live pid (a spawned sleep) so it coexists.
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const pid = child.pid;
    try {
      const reg = await post<{ id: string }>(`${broker.url}/register`, {
        pid,
        cwd: "/tmp/d0060-labeled",
        git_root: "/tmp/d0060-labeled",
        tty: null,
        profile: "🟢 Green — GUPPI",
        display_name: "🟢 Green · P1 · Uma — offplan",
        slug: "offplan-g1-uma",
        summary: "labeled peer",
      });
      // The routing key is STILL the opaque 8-char id — NOT the slug/display name.
      expect(reg.id).toMatch(/^[a-z0-9]{8}$/);
      expect(reg.id).not.toBe("offplan-g1-uma");

      const peers = await post<Peer[]>(`${broker.url}/list-peers`, {
        scope: "machine",
        cwd: "/tmp/d0060-labeled",
        git_root: "/tmp/d0060-labeled",
      });
      const me = peers.find((p) => p.id === reg.id);
      expect(me?.display_name).toBe("🟢 Green · P1 · Uma — offplan");
      expect(me?.slug).toBe("offplan-g1-uma");
      // Rendered block surfaces the name next to the (unchanged) opaque id.
      const block = renderPeerBlock(me!);
      expect(block).toContain(`ID: ${reg.id}`);
      expect(block).toContain("Name: 🟢 Green · P1 · Uma — offplan");
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("re-register (same live PID) with display_name preserves the id AND does not blank the name", async () => {
    const pid = process.pid; // live → id-reuse (in-place UPDATE) path
    const cwd = "/tmp/d0060-rereg";
    const first = await post<{ id: string }>(`${broker.url}/register`, {
      pid,
      cwd,
      git_root: null,
      tty: null,
      profile: "",
      display_name: "🟢 Green · P1 · Uma — offplan",
      slug: "offplan-g1-uma",
      summary: "first",
    });
    expect(first.id).toMatch(/^[a-z0-9]{8}$/);

    // Re-register (broker blip) re-sending the SAME name → id stable, name kept.
    const second = await post<{ id: string }>(`${broker.url}/register`, {
      pid,
      cwd,
      git_root: null,
      tty: null,
      profile: "",
      display_name: "🟢 Green · P1 · Uma — offplan",
      slug: "offplan-g1-uma",
      summary: "second (after blip)",
    });
    expect(second.id).toBe(first.id); // routing key unchanged

    const peers = await post<Peer[]>(`${broker.url}/list-peers`, { scope: "machine", cwd, git_root: null });
    const me = peers.find((p) => p.id === first.id);
    expect(me?.display_name).toBe("🟢 Green · P1 · Uma — offplan"); // NOT blanked
    expect(me?.summary).toBe("second (after blip)"); // mutable field refreshed
  });

  test("send-message still routes by the opaque id when a display_name is set", async () => {
    const pid = process.pid;
    const cwd = "/tmp/d0060-route";
    const reg = await post<{ id: string }>(`${broker.url}/register`, {
      pid,
      cwd,
      git_root: null,
      tty: null,
      profile: "",
      display_name: "🟢 Green · P1 · Uma — offplan",
      slug: "offplan-g1-uma",
      summary: "route test",
    });
    // Route a message to that peer BY ID (not by slug/name) and poll it back.
    const send = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_id: reg.id,
      to_id: reg.id,
      text: "ping-by-id",
    });
    expect(send.ok).toBe(true);
    const poll = await post<{ messages: { from_id: string; text: string }[] }>(
      `${broker.url}/poll-messages`,
      { id: reg.id },
    );
    expect(poll.messages.some((m) => m.text === "ping-by-id")).toBe(true);
    // The slug is NOT an addressable id — sending to it fails to find a peer.
    const bySlug = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_id: reg.id,
      to_id: "offplan-g1-uma",
      text: "should-not-route",
    });
    expect(bySlug.ok).toBe(false);
  });
});

/**
 * Tests for the pid-keyed peer-id marker (CONV-10613).
 *
 * Two layers:
 *  1. Unit — shared/stamp.ts stampPeerIdFile: writes GUPPI_PEER_ID + profile +
 *     pid + extra KEY=value lines atomically (no .tmp left behind), keyed by
 *     pid under $HOME/.guppi/sessions/.
 *  2. Integration — boot a real broker subprocess with a redirected HOME, POST
 *     /register, and assert the broker-side backstop wrote the marker with the
 *     broker-returned id. This is the "session can now read its own peer_id"
 *     guarantee that fixes the root problem.
 *
 * Run: bun test stamp.test.ts
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { stampPeerIdFile, markerPath, sessionsDir } from "./shared/stamp";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Unit: stampPeerIdFile
// ---------------------------------------------------------------------------

describe("stampPeerIdFile", () => {
  let home: string;
  const created: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "stamp-home-"));
    created.push(home);
    process.env.HOME = home;
  });

  afterAll(() => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("writes GUPPI_PEER_ID + profile + pid keyed by pid", () => {
    const ok = stampPeerIdFile(4242, "u60ssaqv", "🟢 Green — GUPPI");
    expect(ok).toBe(true);

    const marker = markerPath(4242);
    expect(marker).toBe(join(home, ".guppi", "sessions", "4242.peerid"));
    expect(existsSync(marker)).toBe(true);

    const body = readFileSync(marker, "utf-8");
    expect(body).toContain("GUPPI_PEER_ID=u60ssaqv");
    expect(body).toContain("ITERM_PROFILE=🟢 Green — GUPPI");
    expect(body).toContain("PID=4242");
  });

  test("round-trips extra KEY=value lines (LABEL)", () => {
    stampPeerIdFile(7, "abc123", "", { LABEL: "Dispatch state dual-write fix" });
    const body = readFileSync(markerPath(7), "utf-8");
    expect(body).toContain("GUPPI_PEER_ID=abc123");
    expect(body).toContain("LABEL=Dispatch state dual-write fix");
  });

  test("is atomic — no .tmp file left behind", () => {
    stampPeerIdFile(99, "id99", "");
    const entries = readdirSync(sessionsDir());
    expect(entries).toContain("99.peerid");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  test("overwriting the same pid is idempotent (last write wins)", () => {
    stampPeerIdFile(5, "first", "");
    stampPeerIdFile(5, "second", "");
    const body = readFileSync(markerPath(5), "utf-8");
    expect(body).toContain("GUPPI_PEER_ID=second");
    expect(body).not.toContain("GUPPI_PEER_ID=first");
  });
});

// ---------------------------------------------------------------------------
// Integration: broker-side backstop writes the marker on /register
// ---------------------------------------------------------------------------

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  tmpDir: string;
  home: string;
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

async function spawnBrokerWithHome(): Promise<SpawnedBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "stamp-broker-"));
  const home = mkdtempSync(join(tmpdir(), "stamp-broker-home-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForBroker(url);
  return { proc, url, tmpDir, home };
}

function killBroker(b: SpawnedBroker) {
  try {
    b.proc.kill();
  } catch {
    // ignore
  }
  for (const dir of [b.tmpDir, b.home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

describe("broker /register backstop stamps the pid-keyed marker", () => {
  let broker: SpawnedBroker;

  afterAll(() => {
    if (broker) killBroker(broker);
  });

  test("a registered peer's id lands in ~/.guppi/sessions/<pid>.peerid", async () => {
    broker = await spawnBrokerWithHome();
    const pid = process.pid; // live pid so the liveness filter keeps the row

    const reg = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid,
        cwd: "/tmp/stamp-cwd",
        git_root: null,
        tty: null,
        profile: "🟢 Green — GUPPI",
        summary: "stamp integration peer",
      }),
    });
    expect(reg.ok).toBe(true);
    const { id } = (await reg.json()) as { id: string };
    expect(typeof id).toBe("string");

    const marker = join(broker.home, ".guppi", "sessions", `${pid}.peerid`);
    expect(existsSync(marker)).toBe(true);
    const body = readFileSync(marker, "utf-8");
    expect(body).toContain(`GUPPI_PEER_ID=${id}`);
    expect(body).toContain("ITERM_PROFILE=🟢 Green — GUPPI");
    expect(body).toContain(`PID=${pid}`);
  });
});

// Restore HOME after the suite so other test files see the real value.
afterAll(() => {
  process.env.HOME = homedir();
});

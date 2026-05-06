/**
 * Regression test for the `profile` field (ITERM_PROFILE → peer record).
 *
 * Spawns a fresh broker on an isolated port + DB, hits /register with a
 * profile string, then asserts /list-peers returns it intact. Also covers
 * the legacy-DB migration path (broker can boot against a peers table that
 * has no `profile` column and still register successfully).
 *
 * Run: bun test profile.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  url: string;
  dbPath: string;
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

async function spawnBroker(opts: { seedDb?: (db: Database) => void } = {}): Promise<SpawnedBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-test-"));
  const dbPath = join(tmpDir, "peers.db");

  if (opts.seedDb) {
    const db = new Database(dbPath);
    opts.seedDb(db);
    db.close();
  }

  // Pick a random high port to avoid colliding with the live broker on 7899.
  const port = 17000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForBroker(url);
  return { proc, port, url, dbPath, tmpDir };
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

describe("profile field propagation", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker();
  });

  afterAll(() => {
    killBroker(broker);
  });

  test("registers a peer with ITERM_PROFILE-style value and surfaces it via list-peers", async () => {
    const reg = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: process.pid, // a live PID so list-peers' liveness filter keeps it
        cwd: "/tmp/test-cwd",
        git_root: null,
        tty: null,
        profile: "Blue Shadow",
        summary: "test peer",
      }),
    });
    expect(reg.ok).toBe(true);
    const { id } = (await reg.json()) as { id: string };
    expect(typeof id).toBe("string");

    const list = await fetch(`${broker.url}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/tmp/test-cwd", git_root: null }),
    });
    const peers = (await list.json()) as Array<{ id: string; profile: string }>;
    const me = peers.find((p) => p.id === id);
    expect(me).toBeDefined();
    expect(me!.profile).toBe("Blue Shadow");
  });

  test("missing/empty profile defaults to empty string and registers cleanly", async () => {
    const reg = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: process.pid,
        cwd: "/tmp/test-cwd-2",
        git_root: null,
        tty: null,
        // profile intentionally omitted
        summary: "no-profile peer",
      }),
    });
    expect(reg.ok).toBe(true);
    const { id } = (await reg.json()) as { id: string };

    const list = await fetch(`${broker.url}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/tmp/test-cwd-2", git_root: null }),
    });
    const peers = (await list.json()) as Array<{ id: string; profile: string }>;
    const me = peers.find((p) => p.id === id);
    expect(me).toBeDefined();
    expect(me!.profile).toBe("");
  });
});

describe("legacy-DB migration", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    // Seed a DB that mirrors the pre-profile schema, so we exercise the
    // ALTER TABLE migration path.
    broker = await spawnBroker({
      seedDb: (db) => {
        db.run(`
          CREATE TABLE peers (
            id TEXT PRIMARY KEY,
            pid INTEGER NOT NULL,
            cwd TEXT NOT NULL,
            git_root TEXT,
            tty TEXT,
            summary TEXT NOT NULL DEFAULT '',
            registered_at TEXT NOT NULL,
            last_seen TEXT NOT NULL
          )
        `);
        db.run(`
          CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            text TEXT NOT NULL,
            sent_at TEXT NOT NULL,
            delivered INTEGER NOT NULL DEFAULT 0
          )
        `);
      },
    });
  });

  afterAll(() => {
    killBroker(broker);
  });

  test("broker auto-adds the profile column and accepts new registrations", async () => {
    const reg = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: process.pid,
        cwd: "/tmp/test-legacy",
        git_root: null,
        tty: null,
        profile: "Red Active",
        summary: "post-migration peer",
      }),
    });
    expect(reg.ok).toBe(true);
    const { id } = (await reg.json()) as { id: string };

    const list = await fetch(`${broker.url}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/tmp/test-legacy", git_root: null }),
    });
    const peers = (await list.json()) as Array<{ id: string; profile: string }>;
    const me = peers.find((p) => p.id === id);
    expect(me).toBeDefined();
    expect(me!.profile).toBe("Red Active");
  });
});

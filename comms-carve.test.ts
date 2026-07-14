/**
 * Open-016 (CONV-10639) — comms-MCP carve regression.
 *
 * Phase 1 of the MCP role-split removes `kill_peer` from the comms surface
 * (`server.ts` TOOLS[] + the case handler). Peer termination is an
 * orchestration authority that moves to the env-gated orchestrator MCP
 * (~/guppi-mcp), which still calls the broker's POST /kill-peer over HTTP.
 *
 * This test pins BOTH halves of the carve:
 *   1. server.ts exposes EXACTLY the 4 peer-to-peer comms tools, and
 *      `kill_peer` is gone from the comms tool surface.
 *   2. the broker `/kill-peer` route is UNTOUCHED — it still terminates a
 *      live peer and drops it from list-peers (the orch-MCP path stays intact).
 *
 * Run: bun test comms-carve.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./server.ts";

const COMMS_TOOLS = ["list_peers", "send_message", "set_summary", "check_messages"];
// bind_orchestrator (CONV-10767) is an orchestrator identity SELF-op — it binds
// only the calling session's own row (role/repo_id/boot_id) and takes no target
// id, so it grants NO cross-peer authority and does NOT reopen the kill_peer
// carve. It is on the tool surface but is NOT a peer-to-peer comms tool.
const SELF_OPS = ["bind_orchestrator"];

describe("Open-016 comms surface (server.ts TOOLS)", () => {
  test("exposes exactly the 4 comms tools + the bind_orchestrator self-op — nothing else", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([...COMMS_TOOLS, ...SELF_OPS].sort());
    expect(TOOLS.length).toBe(COMMS_TOOLS.length + SELF_OPS.length);
  });

  test("kill_peer is no longer a comms tool", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain("kill_peer");
  });

  test("the 4 surviving comms tools are intact (names preserved)", () => {
    const names = TOOLS.map((t) => t.name);
    for (const name of COMMS_TOOLS) {
      expect(names).toContain(name);
    }
  });

  test("the bind_orchestrator self-op adds no cross-peer authority (no target id in its schema)", () => {
    const tool = TOOLS.find((t) => t.name === "bind_orchestrator");
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    // Only self-scoped inputs — no id/peer_id/to_id/target that could name another peer.
    for (const forbidden of ["id", "peer_id", "to_id", "target"]) {
      expect(forbidden in props).toBe(false);
    }
  });
});

// --- broker /kill-peer route stays intact (orch-MCP calls it over HTTP) ---

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
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-commscarve-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 18500 + Math.floor(Math.random() * 1000);
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

describe("Open-016 broker /kill-peer route is UNTOUCHED by the comms carve", () => {
  let broker: SpawnedBroker;

  beforeAll(async () => {
    broker = await spawnBroker();
  });

  afterAll(() => {
    killBroker(broker);
  });

  test("broker /kill-peer still terminates a live peer and drops it (orch-MCP path)", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const cwd = "/tmp/commscarve-kill";
    const { id } = await post<{ id: string }>(`${broker.url}/register`, {
      pid: child.pid,
      cwd,
      git_root: null,
      tty: null,
      profile: "",
      summary: "comms-carve kill route check",
    });

    const before = await post<Array<{ id: string }>>(`${broker.url}/list-peers`, {
      scope: "machine",
      cwd,
      git_root: null,
    });
    expect(before.map((p) => p.id)).toContain(id);

    const result = await post<{ ok: boolean; pid?: number; error?: string }>(
      `${broker.url}/kill-peer`,
      { from_id: "orch-test", to_id: id },
    );
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(child.pid);

    const code = await child.exited;
    expect(code).not.toBe(0); // killed by signal

    const after = await post<Array<{ id: string }>>(`${broker.url}/list-peers`, {
      scope: "machine",
      cwd,
      git_root: null,
    });
    expect(after.map((p) => p.id)).not.toContain(id);
  });
});

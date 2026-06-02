/**
 * Tests for the A5 kill-audit-parity envelope — broker `handleKillPeer`
 * (Open-016, CONV-10639). A destructive, irreversible cross-tier kill must be
 * at least as observable as a keystroke. The Python guppi-mcp side emits
 * `kill_peer_dispatched`; this verifies the TS broker half.
 *
 * Strategy: stand up a tiny capture HTTP server acting as the guppi aggregator
 * `/broker-audit-relay` receiver, spawn an isolated broker pointed at it with
 * the relay-audit flag ON + a provisioned HMAC secret, then exercise the live
 * `/kill-peer` route against a real throwaway child and assert the captured
 * `kill_peer_dispatched` envelope (actor, target peer id + pid, signal, result).
 *
 * Run: bun test kill-audit.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface CapturedEnvelope {
  script: string;
  action_type: string;
  conv_id: string | null;
  details_envelope: { timestamp: string; context: Record<string, unknown> };
}

interface CaptureServer {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  envelopes: CapturedEnvelope[];
}

function startCaptureServer(): CaptureServer {
  const envelopes: CapturedEnvelope[] = [];
  const server = Bun.serve({
    port: 0, // ephemeral
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "POST") {
        try {
          envelopes.push((await req.json()) as CapturedEnvelope);
        } catch {
          // ignore malformed
        }
      }
      return Response.json({ ok: true });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/broker-audit-relay`, envelopes };
}

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

async function spawnBroker(relayUrl: string): Promise<SpawnedBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-kill-audit-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 19000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Turn the relay emit ON (default-off) and provision the secret so
      // buildRelayAuditHeaders does not short-circuit to null.
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "1",
      CLAUDE_PEERS_HMAC_SECRET: "test-secret-kill-audit",
      // Point the broker's aggregator relay at our capture server.
      GUPPI_BROKER_AUDIT_RELAY_URL: relayUrl,
    },
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

async function register(url: string, pid: number, cwd: string): Promise<string> {
  const { id } = await post<{ id: string }>(`${url}/register`, {
    pid,
    cwd,
    git_root: null,
    tty: null,
    profile: "",
    summary: "kill-audit-test peer",
  });
  return id;
}

type KillResponse = { ok: boolean; error?: string; pid?: number };

// The relay emit is fire-and-forget, so the envelope may land after the HTTP
// response. Poll the capture server briefly for a matching envelope.
async function waitForEnvelope(
  capture: CaptureServer,
  predicate: (e: CapturedEnvelope) => boolean,
  timeoutMs = 3000,
): Promise<CapturedEnvelope | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = capture.envelopes.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("kill_peer audit-parity envelope (A5)", () => {
  let capture: CaptureServer;
  let broker: SpawnedBroker;

  beforeAll(async () => {
    capture = startCaptureServer();
    broker = await spawnBroker(capture.url);
  });

  afterAll(() => {
    killBroker(broker);
    capture.server.stop(true);
  });

  test("a successful kill emits kill_peer_dispatched with actor/target/pid/signal/result", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const cwd = "/tmp/kill-audit-live";
    const id = await register(broker.url, child.pid, cwd);

    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-audit-test",
      to_id: id,
    });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(child.pid);
    await child.exited;

    const env = await waitForEnvelope(
      capture,
      (e) => e.action_type === "kill_peer_dispatched" && e.details_envelope.context.target_peer_id === id,
    );
    expect(env).not.toBeNull();
    expect(env!.script).toBe("claude_peers_broker");
    const ctx = env!.details_envelope.context;
    expect(ctx.actor).toBe("orch-audit-test");
    expect(ctx.target_peer_id).toBe(id);
    expect(ctx.target_pid).toBe(child.pid);
    expect(ctx.signal).toBe("SIGTERM");
    expect(ctx.result).toBe("ok");
  });

  test("an already-dead PID emits kill_peer_dispatched with result=esrch_stale_cleaned", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const deadPid = child.pid;
    child.kill();
    await child.exited;
    const cwd = "/tmp/kill-audit-stale";
    const id = await register(broker.url, deadPid, cwd);

    const result = await post<KillResponse>(`${broker.url}/kill-peer`, {
      from_id: "orch-audit-test",
      to_id: id,
    });
    expect(result.ok).toBe(true);
    expect(result.error).toContain("already exited");

    const env = await waitForEnvelope(
      capture,
      (e) =>
        e.action_type === "kill_peer_dispatched" &&
        e.details_envelope.context.target_peer_id === id &&
        e.details_envelope.context.result === "esrch_stale_cleaned",
    );
    expect(env).not.toBeNull();
    expect(env!.details_envelope.context.target_pid).toBe(deadPid);
    expect(env!.details_envelope.context.actor).toBe("orch-audit-test");
  });
});

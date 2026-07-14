/**
 * bind_orchestrator — broker self-op + MCP tool surface (CONV-10767).
 *
 * The KEYSTONE of the orchestrator boot hardening. Today a booting orchestrator
 * reconstructs its OWN peer id from ~6 scattered signals (env marker keyed by a
 * wrong pid → tty → sqlite lookup), which caused the self-collision bug. But the
 * MCP server ALREADY KNOWS its own peer id (`myId` — it created the row at
 * /register). bind_orchestrator exposes it AUTHORITATIVELY: on the CALLER'S OWN
 * row it stamps role="orchestrator" + repo_id + boot_id and returns the caller's
 * own peer id.
 *
 * The security property proven here: the op binds SELF only. The MCP tool takes
 * NO peer-id parameter — the caller cannot name another peer's row; server.ts
 * injects its own myId. Identity is asserted by the server that OWNS the row, not
 * reconstructed or claimed.
 *
 * Two layers:
 *   1. Broker integration — POST /bind-orchestrator {id, repo_id, boot_id}
 *      against a REAL broker on an isolated tmp DB + random high port (NEVER the
 *      live ~/.claude-peers.db). Stamps role/repo_id/boot_id on exactly that row,
 *      returns {peer_id, repo_id, boot_id}, is idempotent (re-bind in place), and
 *      touches NO other peer's row (self-scoped). list-peers still works, now
 *      surfaces the bound role, and never leaks token/boot_id/repo_id.
 *   2. Tool surface — server.ts exposes a bind_orchestrator MCP tool whose input
 *      schema is exactly {repo_id, boot_id} with NO peer-id/target parameter.
 *
 * All modes (HMAC / identity-bind / repo-wall) forced OFF so the new op is
 * isolated and the "compose with off mode" acceptance is exercised directly.
 *
 * Run: bun test bind_orchestrator.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./server.ts";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  dbPath: string;
  tmpDir: string;
}

async function waitForBroker(url: string, timeoutMs = 8000): Promise<void> {
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
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-bindorch-test-"));
  const dbPath = join(tmpDir, "peers.db");
  const port = 19500 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Isolate the new op from the other three layers — off = the acceptance mode.
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: "off",
      BROKER_REPO_WALL_MODE: "off",
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForBroker(url);
  return { proc, url, dbPath, tmpDir };
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

async function post<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

// Register with a REAL live child pid so the peer survives the list-peers
// PID-liveness filter. Returns the broker-assigned id + the spawned child (so the
// caller can reap it in afterAll).
async function registerLive(
  url: string,
  cwd: string,
): Promise<{ id: string; token: string; child: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  const { json } = await post<{ id: string; token: string }>(`${url}/register`, {
    pid: child.pid,
    cwd,
    git_root: cwd,
    tty: null,
    profile: "",
    summary: "bind-orchestrator test peer",
  });
  return { id: json.id, token: json.token, child };
}

interface BindResponse {
  peer_id: string;
  repo_id: string;
  boot_id: string;
}

// Read a peer row straight off the on-disk DB (read-only) to assert what the
// broker actually stored — the same introspection idiom as identity_bind_respawn.
function readRow(dbPath: string, id: string): Record<string, unknown> | null {
  const ro = new Database(dbPath, { readonly: true });
  try {
    return (ro.query("SELECT * FROM peers WHERE id = ?").get(id) as Record<string, unknown>) ?? null;
  } finally {
    ro.close();
  }
}

describe("bind_orchestrator — broker self-op (POST /bind-orchestrator)", () => {
  let broker: SpawnedBroker;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  beforeAll(async () => {
    broker = await spawnBroker();
  }, 25000);

  afterAll(() => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        // ignore
      }
    }
    killBroker(broker);
  });

  test("stamps role=orchestrator + repo_id + boot_id on the caller's OWN row and returns its own peer id", async () => {
    const peer = await registerLive(broker.url, "/tmp/bindorch-A");
    children.push(peer.child);

    const res = await post<BindResponse>(`${broker.url}/bind-orchestrator`, {
      id: peer.id,
      repo_id: "guppi",
      boot_id: "boot-aaaa-1111",
    });
    expect(res.status).toBe(200);
    // RESPONSE contract: the authoritative self peer id + the bound fields.
    expect(res.json.peer_id).toBe(peer.id);
    expect(res.json.repo_id).toBe("guppi");
    expect(res.json.boot_id).toBe("boot-aaaa-1111");

    // EFFECT: the row actually carries the bound identity.
    const row = readRow(broker.dbPath, peer.id);
    expect(row).not.toBeNull();
    expect(row!.role).toBe("orchestrator");
    expect(row!.repo_id).toBe("guppi");
    expect(row!.boot_id).toBe("boot-aaaa-1111");
  });

  test("is idempotent — a re-bind updates repo_id/boot_id in place (one row, role stays orchestrator)", async () => {
    const peer = await registerLive(broker.url, "/tmp/bindorch-idem");
    children.push(peer.child);

    await post<BindResponse>(`${broker.url}/bind-orchestrator`, {
      id: peer.id,
      repo_id: "repo-v1",
      boot_id: "boot-v1",
    });
    const res2 = await post<BindResponse>(`${broker.url}/bind-orchestrator`, {
      id: peer.id,
      repo_id: "repo-v2",
      boot_id: "boot-v2",
    });
    expect(res2.status).toBe(200);
    expect(res2.json.peer_id).toBe(peer.id);
    expect(res2.json.repo_id).toBe("repo-v2");
    expect(res2.json.boot_id).toBe("boot-v2");

    const row = readRow(broker.dbPath, peer.id);
    expect(row!.role).toBe("orchestrator");
    expect(row!.repo_id).toBe("repo-v2");
    expect(row!.boot_id).toBe("boot-v2");
  });

  test("binds SELF only — binding one peer NEVER mutates another peer's row (back-compat: unbound peer keeps role='')", async () => {
    const a = await registerLive(broker.url, "/tmp/bindorch-self-A");
    const b = await registerLive(broker.url, "/tmp/bindorch-self-B");
    children.push(a.child, b.child);

    // Bind ONLY a. b never calls bind_orchestrator.
    await post<BindResponse>(`${broker.url}/bind-orchestrator`, {
      id: a.id,
      repo_id: "repo-A",
      boot_id: "boot-A",
    });

    const rowA = readRow(broker.dbPath, a.id);
    const rowB = readRow(broker.dbPath, b.id);
    // a is bound…
    expect(rowA!.role).toBe("orchestrator");
    expect(rowA!.repo_id).toBe("repo-A");
    // …b is completely untouched — the additive columns default to '' (byte-
    // identical to a peer that predates this migration).
    expect(rowB!.role).toBe("");
    expect(rowB!.repo_id).toBe("");
    expect(rowB!.boot_id).toBe("");
  });

  test("list-peers still works, now surfaces the bound role, and never leaks token/boot_id/repo_id", async () => {
    const peer = await registerLive(broker.url, "/tmp/bindorch-list");
    children.push(peer.child);
    await post<BindResponse>(`${broker.url}/bind-orchestrator`, {
      id: peer.id,
      repo_id: "guppi",
      boot_id: "boot-list",
    });

    // Request from a different cwd so the peer is not self-excluded.
    const { status, json } = await post<Array<Record<string, unknown>>>(
      `${broker.url}/list-peers`,
      { scope: "machine", cwd: "/somewhere/else", git_root: null },
    );
    expect(status).toBe(200);
    const me = json.find((p) => p.id === peer.id);
    expect(me).toBeDefined();
    // The bound role IS surfaced (public, non-secret — "who is the orchestrator").
    expect(me!.role).toBe("orchestrator");
    // Existing reads intact.
    expect(me!.summary).toBeDefined();
    // Secret / off-contract columns MUST still NOT be projected (GBA-789 contract).
    expect("token" in me!).toBe(false);
    expect("boot_id" in me!).toBe(false);
    expect("repo_id" in me!).toBe(false);
    expect("session_id" in me!).toBe(false);
  });

  test("binding an unknown id is a not-found and creates no phantom row", async () => {
    const res = await post<{ error?: string; peer_id?: string }>(
      `${broker.url}/bind-orchestrator`,
      { id: "nope0000", repo_id: "x", boot_id: "y" },
    );
    expect(res.status).toBe(404);
    expect(res.json.peer_id).toBeUndefined();
    expect(readRow(broker.dbPath, "nope0000")).toBeNull();
  });

  test("a missing/blank id is a bad request (never a silent no-op)", async () => {
    const res = await post<{ error?: string }>(`${broker.url}/bind-orchestrator`, {
      repo_id: "x",
      boot_id: "y",
    });
    expect(res.status).toBe(400);
  });
});

// --- Layer 2: the MCP tool surface (self-only contract) ---

describe("bind_orchestrator — MCP tool surface (server.ts TOOLS)", () => {
  test("server.ts exposes a bind_orchestrator tool", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("bind_orchestrator");
  });

  test("its input schema is exactly {repo_id, boot_id} — NO peer-id/target parameter (self-only)", () => {
    const tool = TOOLS.find((t) => t.name === "bind_orchestrator");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const props = Object.keys(schema.properties).sort();
    expect(props).toEqual(["boot_id", "repo_id"]);
    expect((schema.required ?? []).sort()).toEqual(["boot_id", "repo_id"]);
    // The self-only guarantee: the caller CANNOT name another peer's row. There
    // is no id / peer_id / target / to_id parameter — the server injects its own
    // myId. This is what makes the op impossible to use for impersonation.
    for (const forbidden of ["id", "peer_id", "target", "to_id"]) {
      expect(forbidden in schema.properties).toBe(false);
    }
  });
});

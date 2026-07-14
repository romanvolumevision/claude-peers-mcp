/**
 * Integration tests for the repo-scoped message walls (CONV-10767) — end-to-end
 * against a REAL broker process spawned on an isolated tmp DB + random high
 * port. NEVER touches the live ~/.claude-peers.db (each spawn gets its own
 * CLAUDE_PEERS_DB under a mkdtemp dir, torn down in afterAll). HMAC and
 * identity-binding are BOTH forced off so the wall behaviour is isolated from
 * those layers, and the audit relay is kept inert (default-off) so the only
 * observable side-effect is the broker's stderr log line.
 *
 * Synthetic fleet — 2 repos × {peers, orchestrator} + a spoofer:
 *   pA1, pA2  peers in repo A
 *   pB1       peer  in repo B
 *   oA        orchestrator in repo A — BOUND via POST /bind-orchestrator (role='orchestrator')
 *   oB        orchestrator in repo B — BOUND via POST /bind-orchestrator (role='orchestrator')
 *   sA        SPOOFER in repo A — sets summary="🐙 ORCH …" (and even the iTerm
 *             "🐙 Orchestrator" profile) but NEVER calls bind_orchestrator, so
 *             role='' — proves the wall trusts the BOUND role column, not the
 *             peer-settable summary/profile.
 *
 * THE WALL RULE proven here (sender → recipient):
 *   ALLOW iff (same git_root) OR (both BOUND orchestrators); else REJECT.
 * The orchestrators-room exception keys off the server-owned role column: a peer
 * that merely tags its own summary "🐙 ORCH" gains NO cross-repo reach.
 *
 * Run: bun test repo_wall_integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

const REPO_A = "/tmp/repo-wall-A";
const REPO_B = "/tmp/repo-wall-B";

interface SpawnedBroker {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
  tmpDir: string;
  stderr: () => string;
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

function spawnBroker(mode: "off" | "shadow" | "enforce"): SpawnedBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), `claude-peers-repowall-${mode}-`));
  const port = 18900 + Math.floor(Math.random() * 900);
  const dbPath = join(tmpDir, "peers.db");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Isolate the wall from the other two layers.
      BROKER_HMAC_MODE: "off",
      BROKER_IDENTITY_BIND_MODE: "off",
      BROKER_REPO_WALL_MODE: mode,
      // Keep the audit relay inert (default-off anyway) — no external POSTs.
      CLAUDE_PEERS_RELAY_AUDIT_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Continuously drain stderr into a buffer so shadow-mode log assertions can
  // inspect the structured repo_wall line without racing the pipe.
  let buf = "";
  (async () => {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
      }
    } catch {
      // stream closed on teardown — ignore
    }
  })();

  return { proc, url: `http://127.0.0.1:${port}`, port, tmpDir, stderr: () => buf };
}

function teardown(b: SpawnedBroker) {
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

interface PostResult<T = unknown> {
  status: number;
  ok: boolean;
  json: T;
}

async function post<T = unknown>(url: string, body: unknown): Promise<PostResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    json = null as T;
  }
  return { status: res.status, ok: res.ok, json };
}

interface RegOpts {
  git_root: string | null;
  summary?: string;
  profile?: string;
}

async function register(url: string, pid: number, opts: RegOpts): Promise<string> {
  const res = await post<{ id: string }>(`${url}/register`, {
    pid,
    cwd: opts.git_root ?? "/tmp/repo-wall-none",
    git_root: opts.git_root,
    tty: null,
    profile: opts.profile ?? "",
    summary: opts.summary ?? "worker",
  });
  expect(res.status).toBe(200);
  expect(res.json.id).toBeTruthy();
  return res.json.id;
}

// Authoritatively BIND a peer as an orchestrator — the server-owned self-op that
// stamps role='orchestrator' on that row. This (not the summary/profile) is the
// signal the wall trusts. Returns nothing; asserts the bind acknowledged.
async function bindOrchestrator(url: string, id: string): Promise<void> {
  const res = await post<{ peer_id: string }>(`${url}/bind-orchestrator`, {
    id,
    repo_id: "",
    boot_id: "",
  });
  expect(res.status).toBe(200);
  expect(res.json.peer_id).toBe(id);
}

interface Fleet {
  pA1: string;
  pA2: string;
  pB1: string;
  oA: string;
  oB: string;
  sA: string;
}

// Distinct FAKE pids — fresh-mint each (no reuse path). Send-message target
// checks + wall lookups don't liveness-probe, so the rows persist for the
// (sub-30s) test without being reaped by cleanStalePeers.
async function registerFleet(url: string): Promise<Fleet> {
  const pA1 = await register(url, 900011, { git_root: REPO_A, summary: "green legwork" });
  const pA2 = await register(url, 900012, { git_root: REPO_A, summary: "green legwork 2" });
  const pB1 = await register(url, 900021, { git_root: REPO_B, summary: "blue legwork" });
  // Two REAL orchestrators — each registered THEN authoritatively bound. The
  // summary/profile are set too, but it is the bind (role='orchestrator') that
  // earns the cross-repo exception now.
  const oA = await register(url, 900031, {
    git_root: REPO_A,
    summary: "🐙 ORCH (CONV-10767) — repoA fleet",
  });
  await bindOrchestrator(url, oA);
  const oB = await register(url, 900041, {
    git_root: REPO_B,
    profile: "🐙 Orchestrator",
    summary: "coordinating repoB",
  });
  await bindOrchestrator(url, oB);
  // The SPOOFER — carries BOTH peer-settable orchestrator signals (summary tag +
  // iTerm profile) but is deliberately NEVER bound, so role=''. Under the old
  // summary-prefix wall this row would have inherited the orchestrators-room
  // exception; under the bound-role wall it must not.
  const sA = await register(url, 900051, {
    git_root: REPO_A,
    profile: "🐙 Orchestrator",
    summary: "🐙 ORCH (CONV-10767) — SPOOFER, never bound",
  });
  return { pA1, pA2, pB1, oA, oB, sA };
}

async function send(url: string, from_id: string, to_id: string, text: string) {
  return post<{ ok: boolean; error?: string }>(`${url}/send-message`, { from_id, to_id, text });
}

// The 8 ordered (sender → recipient) cells and their expected ALLOW under the
// wall rule. Keyed by fleet field so each broker can resolve real ids.
type Cell = { from: keyof Fleet; to: keyof Fleet; allow: boolean; label: string };
const MATRIX: Cell[] = [
  { from: "pA1", to: "pA2", allow: true, label: "same-repo peer→peer" },
  { from: "pA1", to: "oA", allow: true, label: "peer→own-repo orch" },
  { from: "pA1", to: "pB1", allow: false, label: "cross-repo peer→peer" },
  { from: "pA1", to: "oB", allow: false, label: "peer→other-repo orch" },
  { from: "oA", to: "oB", allow: true, label: "BOUND orch↔orch (orchestrators room)" },
  { from: "oA", to: "pA1", allow: true, label: "orch→own-repo peer" },
  { from: "oA", to: "pB1", allow: false, label: "orch→other-repo peer" },
  { from: "oB", to: "pA1", allow: false, label: "orch→other-repo peer (B→A)" },
  // ── SPOOF REJECTION — the point of the bound-role wall ──────────────────────
  // sA sets summary="🐙 ORCH" + the orchestrator profile but never bound, so
  // role=''. It gets NO orchestrators-room exception: cross-repo to a real bound
  // orch is REJECTED. (Under the old summary-prefix wall this would ALLOW.)
  { from: "sA", to: "oB", allow: false, label: "SPOOF summary-only → bound orch (REJECTED)" },
  // A bound orch reaching the spoofer cross-repo is also rejected — the spoofer
  // is not a bound orch, so (orch AND orch) fails on the recipient side too.
  { from: "oB", to: "sA", allow: false, label: "bound orch → SPOOF summary-only (REJECTED)" },
  // The spoofer is still a normal same-repo peer: sA→pA1 (both repo A) ALLOWS.
  { from: "sA", to: "pA1", allow: true, label: "spoofer→same-repo peer (still ALLOWED)" },
];

// ── flag OFF (default) — byte-identical: every send delivers ─────────────────

describe("repo wall OFF — byte-identical (every send delivers)", () => {
  let broker: SpawnedBroker;
  let fleet: Fleet;

  beforeAll(async () => {
    broker = spawnBroker("off");
    await waitForBroker(broker.url);
    fleet = await registerFleet(broker.url);
  });
  afterAll(() => teardown(broker));

  test("all 8 matrix cells DELIVER regardless of repo/role", async () => {
    for (const c of MATRIX) {
      const res = await send(broker.url, fleet[c.from], fleet[c.to], `off:${c.label}`);
      expect({ cell: c.label, status: res.status, ok: res.json.ok }).toEqual({
        cell: c.label,
        status: 200,
        ok: true,
      });
    }
  });

  test("no repo_wall line is ever logged in off mode", () => {
    expect(broker.stderr()).not.toContain("repo_wall_blocked");
  });
});

// ── flag ENFORCE — the wall bites ────────────────────────────────────────────

describe("repo wall ENFORCE — full reachability matrix", () => {
  let broker: SpawnedBroker;
  let fleet: Fleet;

  beforeAll(async () => {
    broker = spawnBroker("enforce");
    await waitForBroker(broker.url);
    fleet = await registerFleet(broker.url);
  });
  afterAll(() => teardown(broker));

  test("each cell is ALLOWED / REJECTED exactly per the wall rule", async () => {
    for (const c of MATRIX) {
      const res = await send(broker.url, fleet[c.from], fleet[c.to], `enforce:${c.label}`);
      // The broker renders handleSendMessage's result at HTTP 200 either way
      // (a walled send is an ok:false delivery refusal, same shape as a
      // target-not-found — NOT an auth 401).
      expect(res.status).toBe(200);
      expect({ cell: c.label, ok: res.json.ok }).toEqual({ cell: c.label, ok: c.allow });
      if (!c.allow) {
        expect(res.json.error).toContain("repo wall");
      }
    }
  });

  test("a rejected send is NOT delivered (recipient inbox stays empty)", async () => {
    // pA1 → pB1 was rejected above. pB1 must have received nothing.
    const poll = await post<{ messages: unknown[] }>(`${broker.url}/poll-messages`, {
      id: fleet.pB1,
    });
    expect(poll.status).toBe(200);
    expect(poll.json.messages.length).toBe(0);
  });

  test("an allowed send IS delivered (recipient can poll it)", async () => {
    // pA1 → pA2 (same repo) was allowed above.
    const poll = await post<{ messages: Array<{ text: string; from_id: string }> }>(
      `${broker.url}/poll-messages`,
      { id: fleet.pA2 },
    );
    expect(poll.status).toBe(200);
    expect(poll.json.messages.length).toBe(1);
    expect(poll.json.messages[0]!.from_id).toBe(fleet.pA1);
  });
});

// ── flag SHADOW — would-reject is LOGGED but still DELIVERED ──────────────────

describe("repo wall SHADOW — observe-only (log would-reject, still deliver)", () => {
  let broker: SpawnedBroker;
  let fleet: Fleet;

  beforeAll(async () => {
    broker = spawnBroker("shadow");
    await waitForBroker(broker.url);
    fleet = await registerFleet(broker.url);
  });
  afterAll(() => teardown(broker));

  test("EVERY cell delivers in shadow (including the would-reject ones)", async () => {
    for (const c of MATRIX) {
      const res = await send(broker.url, fleet[c.from], fleet[c.to], `shadow:${c.label}`);
      expect({ cell: c.label, status: res.status, ok: res.json.ok }).toEqual({
        cell: c.label,
        status: 200,
        ok: true,
      });
    }
  });

  test("a would-reject send is genuinely delivered (recipient can poll it)", async () => {
    // pB1 received the cross-repo pA1→pB1 message (walled, but shadow delivers).
    const poll = await post<{ messages: Array<{ text: string; from_id: string }> }>(
      `${broker.url}/poll-messages`,
      { id: fleet.pB1 },
    );
    expect(poll.status).toBe(200);
    // pA1→pB1 and oA→pB1 (both would-reject) were sent; both delivered.
    expect(poll.json.messages.length).toBeGreaterThanOrEqual(1);
    expect(poll.json.messages.some((m) => m.from_id === fleet.pA1)).toBe(true);
  });

  test("would-reject cells are FLAGGED; allowed cells are NOT flagged", async () => {
    // Give the stderr pipe a moment to flush the structured lines.
    const deadline = Date.now() + 2000;
    const walledToIds = MATRIX.filter((c) => !c.allow).map((c) => fleet[c.to]);
    while (Date.now() < deadline) {
      const log = broker.stderr();
      if (walledToIds.every((id) => log.includes(id))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const log = broker.stderr();
    const wallLines = log.split("\n").filter((l) => l.includes("repo_wall_blocked"));

    // Every would-reject recipient appears in a repo_wall_blocked line.
    for (const c of MATRIX.filter((x) => !x.allow)) {
      const hit = wallLines.some(
        (l) => l.includes(`"from_id":"${fleet[c.from]}"`) && l.includes(`"to_id":"${fleet[c.to]}"`),
      );
      expect({ cell: c.label, flagged: hit }).toEqual({ cell: c.label, flagged: true });
    }

    // No ALLOWED cell (same-repo / orch-room) is ever flagged. Check that no
    // repo_wall line names an allowed (sender→recipient) pair.
    for (const c of MATRIX.filter((x) => x.allow)) {
      const flagged = wallLines.some(
        (l) => l.includes(`"from_id":"${fleet[c.from]}"`) && l.includes(`"to_id":"${fleet[c.to]}"`),
      );
      expect({ cell: c.label, flagged }).toEqual({ cell: c.label, flagged: false });
    }

    // Shadow lines are labelled would_block (not blocked).
    expect(wallLines.every((l) => l.includes('"outcome":"would_block"'))).toBe(true);
    // And they carry NO secrets / message text.
    expect(wallLines.every((l) => !l.includes("token") && !l.includes("boot_id"))).toBe(true);
    expect(log).not.toContain("shadow:cross-repo peer→peer"); // message text never logged
  });
});

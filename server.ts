#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  BindOrchestratorResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

import { sign } from "./auth";
import * as fs from "fs";
import * as path from "path";
import { stampPeerIdFile } from "./shared/stamp";
import { composeCompactTitle, composeSessionName, composeBadge, profileToChannel } from "./shared/tabtitle";
import { renderPeerBlock, readableIdentity, peerLabel } from "./shared/peer_display";
import { resolveProfileEnv } from "./shared/profile_env";
import { paintTmuxWindowTitle } from "./shared/tmux_paint";
import { shouldReRegister } from "./shared/reregister";
import type { HeartbeatResponse } from "./shared/types.ts";
import { makeTransportCloseHandler } from "./shared/transport_close";
import { waitForBrokerHealthy } from "./shared/wait_broker";
// CONV-10767 worktree fix: resolveRepoRoot normalizes a repo + ALL its linked
// worktrees to ONE logical repo_root (the MAIN working tree). A GUPPI peer runs
// in a per-colour git WORKTREE, whose raw git_root (toplevel) is the worktree
// path — NOT the main repo. repo_root collapses them so the broker's repo wall
// treats an orchestrator in the main checkout and a peer in a worktree as the
// same repo room. See shared/repo_root.ts.
import { resolveRepoRoot } from "./shared/repo_root";
// S1 broker hardening (GBA-7/8/9) — PR-B peer-client leg. generateBootId mints
// this process's boot_id (GBA-8); buildIdentityHeaders emits the scope-token +
// boot_id echo headers the broker binds against once BROKER_IDENTITY_BIND_MODE
// is warn/enforce. Both are additive + backward-tolerant: an old broker ignores
// the extra headers, and buildIdentityHeaders omits empty values so a peer that
// has not yet captured a token sends nothing new. See shared/identity_bind.ts.
import { generateBootId, buildIdentityHeaders } from "./shared/identity_bind";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const HMAC_SECRET = process.env.CLAUDE_PEERS_HMAC_SECRET ?? "";
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
// Open-016 Phase 3d: the adapter no longer self-spawns a broker (launchd owns
// it), so the broker script path is no longer needed here.

// --- Broker communication ---

/**
 * Phase 0 broker-auth-substrate (CONV-9671 T0.7): signs outbound POSTs with
 * HMAC headers when CLAUDE_PEERS_HMAC_SECRET is set. Backwards-compatible
 * when env-var is unset (no headers added; broker accepts in warn mode,
 * rejects in enforce mode).
 */
async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (HMAC_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    headers["X-Claude-Peers-Auth"] = sign(bodyStr, ts, HMAC_SECRET);
    headers["X-Claude-Peers-Timestamp"] = String(ts);
    // Phase 0 stub — Phase 1+ will populate from caller's session_anchor.
    headers["X-Claude-Peers-Session-Anchor"] = "";
  }
  // S1 broker hardening (GBA-8/9) — echo this peer's identity credentials on
  // EVERY outbound POST so the broker can bind our body-claimed id (from_id/id)
  // to the minted scope-token + boot_id. Strictly additive + inert until the
  // broker enforces: buildIdentityHeaders omits empties (myToken is "" until the
  // first /register response is captured), and an old broker — or the new one
  // while BROKER_IDENTITY_BIND_MODE is off — simply ignores these headers.
  // Harmless on /register too: the broker reads boot_id from the request BODY
  // there (added below) and never consults the token header on that path.
  Object.assign(headers, buildIdentityHeaders(myToken, myBootId));
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Open-016 Phase 3d: trust launchd as the SOLE broker owner. The old
// self-spawn made BOTH launchd and any adapter able to start a broker, racing
// for :7899 (EADDRINUSE / repeated "listening on :7899" noise) — and two
// brokers on one SQLite WAL is corruption. So we no longer spawn a broker; we
// just WAIT for launchd's broker to be healthy. If it never comes up the
// startup throws (a fail-fast the supervisor / operator can see), rather than
// the adapter silently racing a second broker into existence.
async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker is healthy");
    return;
  }
  log("Broker not yet healthy — waiting for launchd-owned broker (NOT self-spawning)...");
  const healthy = await waitForBrokerHealthy(isBrokerAlive, { attempts: 30, intervalMs: 200 });
  if (!healthy) {
    throw new Error(
      "Broker did not become healthy after 6s. launchd owns the broker " +
        "(com.guppi.claude-peers-broker.plist); check `launchctl list | grep claude-peers-broker` " +
        "and the broker log. The adapter no longer self-spawns a broker (Open-016 Phase 3d).",
    );
  }
  log("Broker became healthy");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

// --- Self-identity stamp + auto-tab-naming (CONV-10613) ---
//
// Root problem fixed: a session cannot see its own peer_id — the broker
// excludes self from list_peers and never echoes own from_id. We close that by
// writing the broker-assigned id where the session can read it back:
//   * the GUPPI_PEER_ID env var on this process (visible to child shells), and
//   * a pid-keyed marker file ~/.guppi/sessions/<pid>.peerid.
//
// Keyed by process.pid rather than a claude_session_id because no session-id
// source exists in this MCP; pid is available everywhere the stamp is written
// (server.ts self-register here, and broker.ts via body.pid).
//
// composeTabTitle / profileToChannel live in shared/tabtitle.ts (unit-testable
// without booting the stdio MCP) and mirror scripts/iterm/tab_title.py.

/**
 * Stamp the broker-assigned peer_id where this session can read it: the
 * GUPPI_PEER_ID env var (for child shells) + the pid-keyed marker file
 * (shared writer in shared/stamp.ts, also used by the broker backstop).
 */
function stampPeerId(id: string): void {
  process.env.GUPPI_PEER_ID = id;
  stampPeerIdFile(process.pid, id, resolveProfileEnv());
}

/** Read the channel's last_conv from workstreams/.state.json (best-effort). */
function readLastConv(): string | undefined {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || myGitRoot || myCwd;
    if (!projectDir) return undefined;
    const statePath = path.join(projectDir, "workstreams", ".state.json");
    const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const channel = profileToChannel(resolveProfileEnv());
    if (!channel) return undefined;
    const slice = data?.channels?.[channel];
    const conv = slice?.last_conv;
    return typeof conv === "string" && conv ? conv : undefined;
  } catch {
    return undefined;
  }
}

/** Read the channel's work-label from workstreams/.state.json (best-effort).
 * CONV-10613 (B): the stable tab topic source — "just what we're working on",
 * not the churning summary. Treats null / "none" as absent. */
function readLabel(): string | undefined {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || myGitRoot || myCwd;
    if (!projectDir) return undefined;
    const statePath = path.join(projectDir, "workstreams", ".state.json");
    const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const channel = profileToChannel(resolveProfileEnv());
    if (!channel) return undefined;
    const slice = data?.channels?.[channel];
    const label = slice?.label;
    return (typeof label === "string" && label.trim() && label.trim().toLowerCase() !== "none")
      ? label.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-render + emit the self-identifying tab title after a summary change. The
 * server is a bun subprocess with no iTerm2 Python API, so it (a) records the
 * new label into the marker file and then drives the composed title onto
 * whichever terminal surface this session is running under:
 *   • iTerm2 (Mac control plane) — the AppleScript `set name` leg targeting
 *     $ITERM_SESSION_ID, which also bypasses the profile's
 *     `Allow Title Setting: false` OSC gate (CONV-8207).
 *   • tmux (Forge remote-control) — `tmux rename-window` on the window owning
 *     $TMUX_PANE, gated on $TMUX (tmux-migration §5 step 5). There is no iTerm2
 *     over SSH/tmux, so $ITERM_SESSION_ID is empty and the iTerm leg no-ops;
 *     this leg fills that gap.
 * The two legs are additive and independently gated ($ITERM_SESSION_ID vs
 * $TMUX) — on a Mac iTerm session $TMUX is unset, so behaviour is unchanged.
 * Fully best-effort: any failure is logged and swallowed so it can never break
 * set_summary, and neither leg blocks the other.
 */
function refreshTabTitle(summary: string): void {
  try {
    if (myId) {
      stampPeerIdFile(process.pid, myId, resolveProfileEnv(), { LABEL: summary });
    }
    const channel = profileToChannel(resolveProfileEnv());
    const conv = readLastConv();
    // D-0060: prefer the readable bare name token (GUPPI_PEER_NAME, e.g. "Uma")
    // over the opaque id in the tab title — "🟢 · Uma · CONV-… · topic" instead
    // of "🟢 · 8n9aqm28 · …". Falls back to the opaque id when unset, so a
    // hand-opened tab is unchanged. Routing + the pid-keyed marker still use myId.
    const peer = myPeerName || myId || undefined;
    // CONV-10613 three-field rename — kept in parity with the GUPPI daemon
    // paint path (scripts/iterm/tab_title.py + guppi-daemon.py). The OLD code
    // fed the raw `summary` as the title label, double-painting the
    // "<emoji> <Colour>" the composer already prepends
    // ("🟠 Orange · 1frhehsa · CONV-10655 · 🟠 Orange CONV-10655"). Now:
    //   • session NAME  = the COMPACT identifier (the tab strip, since the
    //     GUPPI profiles run Title Components = SESSION_NAME).
    //   • user.window_title + user.session_subtitle = the LONG descriptive form
    //     (the DynamicProfile interpolates them into Custom Window Title +
    //     Subtitle — best-effort; harmless no-op if a profile renders neither).
    //   • user.badge = colour / 1-2-word role (DynamicProfile Badge Text).
    // All four are AppleScript-writable (set name / set variable) — the only
    // parity-safe surfaces (tab.title + window.name are NOT settable via
    // AppleScript; TitleComponents.CUSTOM needs a Python RPC the bun broker
    // can't register). Probed live CONV-10657.
    const label = readLabel();
    const compact = composeCompactTitle(channel, peer, conv, summary, label);
    const sessionName = composeSessionName(channel, peer, conv, summary, label);
    const badge = composeBadge(channel, summary);

    // --- iTerm2 leg (Mac) — gated on $ITERM_SESSION_ID. ---
    const sessionId = process.env.ITERM_SESSION_ID ?? "";
    if (sessionId) {
      const uuid = sessionId.includes(":") ? sessionId.slice(sessionId.lastIndexOf(":") + 1) : sessionId;
      // Explicit-session targeting (Roman directive 2026-05-11, CONV-8191): walk
      // sessions by unique id rather than touching the frontmost window.
      const applescript = [
        "on run argv",
        "  set targetName to item 1 of argv",
        "  set targetUUID to item 2 of argv",
        "  set winTitle to item 3 of argv",
        "  set subTitle to item 4 of argv",
        "  set badgeText to item 5 of argv",
        '  tell application "iTerm2"',
        "    repeat with w in windows",
        "      repeat with t in tabs of w",
        "        repeat with s in sessions of t",
        "          if (unique id of s as string) is targetUUID then",
        "            tell s",
        "              set name to targetName",
        '              set variable named "user.window_title" to winTitle',
        '              set variable named "user.session_subtitle" to subTitle',
        '              set variable named "user.badge" to badgeText',
        "            end tell",
        "            return",
        "          end if",
        "        end repeat",
        "      end repeat",
        "    end repeat",
        "  end tell",
        "end run",
      ].join("\n");
      Bun.spawn(["osascript", "-", compact, uuid, sessionName, sessionName, badge], {
        stdin: new TextEncoder().encode(applescript),
        stdout: "ignore",
        stderr: "ignore",
      });
    }

    // --- tmux leg (Forge) — gated on $TMUX (tmux-migration §5 step 5). ---
    // ADDITIVE: paints the SAME compact title the iTerm `set name` leg uses onto
    // the tmux window owning $TMUX_PANE. Internally gated on $TMUX (no-op off
    // tmux) and best-effort (never throws, never blocks set_summary); we don't
    // await it so it can't slow the set_summary response.
    void paintTmuxWindowTitle(compact, { log }).catch((e) => {
      log(`tmux title paint failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    });
  } catch (e) {
    log(`refreshTabTitle failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// Detect the client app hosting this session, host-agnostic. tty/profile are
// empty off-iTerm, so this gives an explicit "where am I running" signal:
// VS Code (both the extension host and its integrated terminal), iTerm, the
// macOS Terminal, tmux, the Claude desktop app, etc.
function detectHost(): string {
  const env = process.env;
  // VS Code — extension host sets VSCODE_PID/IPC_HOOK + extensionHost marker;
  // the integrated terminal sets TERM_PROGRAM=vscode + VSCODE_GIT_*.
  if (
    env.TERM_PROGRAM === "vscode" ||
    env.VSCODE_PID ||
    env.VSCODE_IPC_HOOK ||
    env.VSCODE_GIT_IPC_HANDLE ||
    env.VSCODE_CRASH_REPORTER_PROCESS_TYPE
  ) {
    return env.VSCODE_CRASH_REPORTER_PROCESS_TYPE === "extensionHost"
      ? "VS Code (extension)"
      : "VS Code";
  }
  if (env.TMUX) return "tmux";
  const tp = env.TERM_PROGRAM ?? "";
  const known: Record<string, string> = {
    "iTerm.app": "iTerm",
    Apple_Terminal: "Terminal",
    WezTerm: "WezTerm",
    Hyper: "Hyper",
    ghostty: "Ghostty",
    WarpTerminal: "Warp",
  };
  if (known[tp]) return known[tp];
  if ((env.__CFBundleIdentifier ?? "").toLowerCase().includes("claude")) {
    return "Claude Desktop";
  }
  return tp || "";
}

// Detect the physical machine. GUPPI_SURFACE (mac/apollo/openclaw) is the
// authoritative fleet surface when present; otherwise fall back to the
// hostname, mapped to a friendly name (MacBook / Forge) where recognisable.
function detectMachine(): string {
  const surface = (process.env.GUPPI_SURFACE ?? "").toLowerCase();
  const surfaceMap: Record<string, string> = {
    mac: "MacBook",
    apollo: "Apollo",
    openclaw: "OpenClaw",
    forge: "Forge",
  };
  if (surface && surfaceMap[surface]) return surfaceMap[surface];
  if (surface) return surface;
  let h = "";
  try {
    h = require("os").hostname() as string;
  } catch {
    h = "";
  }
  const hl = h.toLowerCase();
  if (hl.includes("macbook")) return "MacBook";
  if (hl.includes("forge")) return "Forge";
  return h.replace(/\.local$/, "");
}

// --- State ---

let myId: PeerId | null = null;
// S1 broker hardening (GBA-8/9) — per-peer identity credentials.
//   myBootId — this process's boot_id (GBA-8), minted ONCE at module load. Sent
//     in the /register BODY (stored broker-side) and echoed on every subsequent
//     write via buildIdentityHeaders. Constant for the process lifetime, so a
//     re-register after a broker blip presents the SAME boot_id → identity-stable.
//   myToken  — the scope-token (GBA-9) the broker mints and returns from
//     /register; captured below and echoed on every write. "" until first
//     register (or against an old broker that returns no token) → omitted by
//     buildIdentityHeaders, keeping the peer "unbound" (accepted in every mode).
const myBootId = generateBootId();
let myToken = "";
let myCwd = process.cwd();
let myGitRoot: string | null = null;
// CONV-10767 worktree fix: the NORMALIZED main-worktree root. For a normal
// checkout this equals myGitRoot; for a per-colour WORKTREE it is the MAIN repo
// (so the wall keeps the worktree peer in its repo's room). Cached in main() and
// re-presented on every /register (incl. the post-broker-blip re-register).
let myRepoRoot: string | null = null;
// Open-016 Phase 3b: cached registration context so reRegister() can re-POST
// /register with the same shape after a broker loss (set once in main()).
let myTty: string | null = null;
let myProfile = "";
// Host (client app) + machine — constant per process; detected once.
const myHost = detectHost();
const myMachine = detectMachine();
// D-0060 readable identity (CONV-10767) — DISPLAY-ONLY, never a routing key.
// Composed Python-side by the GUPPI orchestrator spawn assigner (peer_names.py:
// compose_peer_name / peer_id_slug / next_name) and injected into this session's
// env; here we only TRANSPORT the pre-composed strings — TS never re-implements
// the grammar. All default '' → a session launched without them (a hand-opened
// tab, or before the orchestrator assigner is wired) is byte-identical to today.
//   GUPPI_PEER_LABEL — full readable label, e.g. "🟢 Green · P1 · Uma — offplan".
//   GUPPI_PEER_SLUG  — deterministic short handle, e.g. "offplan-g1-uma".
//   GUPPI_PEER_NAME  — the bare human handle ("Uma"); used only as the tab-title
//                      token in place of the opaque id (routing stays on myId).
const myDisplayName = process.env.GUPPI_PEER_LABEL ?? "";
const mySlug = process.env.GUPPI_PEER_SLUG ?? "";
const myPeerName = process.env.GUPPI_PEER_NAME ?? "";
let mySummary = "";
// Auto-summary refresh state. `summaryIsAuto` stays true only while the summary
// is broker-generated; the first explicit set_summary tool call flips it false
// so the refresh timer NEVER overwrites a description a session set on purpose.
// `lastSummaryContext` is the branch+recent-files signature at the last refresh,
// so an unchanged context skips the (nano) LLM call entirely (cost guard).
let summaryIsAuto = true;
let lastSummaryContext = "";

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages
- bind_orchestrator: Authoritatively bind THIS session as the orchestrator (sets your role + repo_id + boot_id on your own row and returns your authoritative peer id). Use it at orchestrator boot instead of guessing your own peer id.

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

// Exported so the tool-surface contract is unit-testable without booting the
// stdio MCP / broker (server.ts only runs main() when invoked as the entry point
// — see the `import.meta.main` guard at the bottom). The surface is the 4
// peer-to-peer comms tools PLUS the bind_orchestrator SELF-op (CONV-10767) — and
// still NO kill_peer (peer termination remains an env-gated orchestrator-MCP
// authority, Open-016). bind_orchestrator is not a cross-peer authority: it binds
// only THIS session's own row, so it does not reopen the least-privilege carve.
export const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "bind_orchestrator",
    description:
      "Authoritatively bind THIS session as the orchestrator. Sets your role to 'orchestrator' plus the given repo_id and boot_id on YOUR OWN peer row, and returns your authoritative peer_id (the id the broker assigned you at registration). Use this at orchestrator boot instead of reconstructing your own peer id from environment/tty signals. Binds only yourself — it takes no target id and cannot bind another peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_id: {
          type: "string" as const,
          description: "The repo this orchestrator owns (e.g. the git repo name or root).",
        },
        boot_id: {
          type: "string" as const,
          description:
            "This orchestrator boot's id — the boot epoch recorded on your row for restart detection / the lease model.",
        },
      },
      required: ["repo_id", "boot_id"],
    },
  },
  // Open-016 (CONV-10639): `kill_peer` is intentionally NOT a comms tool. Peer
  // termination is an orchestration authority that lives on the env-gated
  // orchestrator MCP (~/guppi-mcp), which calls the broker's POST /kill-peer
  // over HTTP. The broker route + handleKillPeer() stay in broker.ts as the
  // sole executor; only the comms-side tool surface drops it. Least-privilege:
  // colour peers can no longer kill their siblings.
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        // Self-row: a session must be able to see its OWN identity. The broker
        // excludes self (exclude_id: myId), and the CONV-10613 env/peerid-file
        // stamps are fragile across hosts (empty GUPPI_PEER_ID + wrong-pid
        // peerid file in the VS Code extension build). Rendering self here is
        // host-agnostic — works identically in iTerm, VS Code, tmux, anywhere.
        const selfParts = [
          `ID: ${myId ?? "(registering…)"}   ← YOU (this session)`,
          `PID: ${process.pid}`,
          `CWD: ${myCwd}`,
        ];
        if (myGitRoot) selfParts.push(`Repo: ${myGitRoot}`);
        const selfTty = getTty();
        if (selfTty) selfParts.push(`TTY: ${selfTty}`);
        const selfProfile = resolveProfileEnv();
        if (selfProfile) selfParts.push(`Profile: ${selfProfile}`);
        if (myHost) selfParts.push(`Host: ${myHost}`);
        if (myMachine) selfParts.push(`Machine: ${myMachine}`);
        // D-0060 — surface this session's own readable name (display-only):
        // the client-supplied display_name if set, else the broker-derived
        // canonical identity (profile colour + repo), so YOU reads the same as
        // how peers see this session.
        const selfIdentity =
          myDisplayName ||
          readableIdentity({ profile: selfProfile, cwd: myCwd, git_root: myGitRoot });
        if (selfIdentity) selfParts.push(`Name: ${selfIdentity}`);
        if (mySlug) selfParts.push(`Slug: ${mySlug}`);
        if (mySummary) selfParts.push(`Summary: ${mySummary}`);
        const selfLine = selfParts.join("\n  ");

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `You are the only session in scope (${scope}).\n\nYOU:\n  ${selfLine}`,
              },
            ],
          };
        }

        // D-0060 (CONV-10767): per-peer block rendered by the extracted
        // renderPeerBlock helper (shared/peer_display.ts) — identical field
        // order/labels to before, plus an OPTIONAL `Name:`/`Slug:` line only
        // when the peer carries one. Extracted so byte-identity is unit-tested.
        const lines = peers.map(renderPeerBlock);

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} other peer(s) (scope: ${scope}), plus YOU:\n\nYOU:\n  ${selfLine}\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        mySummary = summary;
        // Deliberate set → this session OWNS its description. The auto-refresh
        // timer must never overwrite it from here on.
        summaryIsAuto = false;
        await brokerFetch("/set-summary", { id: myId, summary });
        // CONV-10613: re-render the self-identifying tab title automatically on
        // every explicit summary change — this is the in-MCP hook that keeps
        // the tab current without any opt-in step. Best-effort; never makes the
        // handler return isError on a title-emit failure.
        refreshTabTitle(summary);
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        // D-0060: resolve each sender's readable identity for the "From …"
        // header. Best-effort — a lookup failure or an unknown sender falls back
        // to the opaque from_id (still routable). The raw id is kept in
        // parentheses for debugging whenever a readable label is shown.
        const senderById = new Map<string, Peer>();
        try {
          const senders = await brokerFetch<Peer[]>("/list-peers", {
            scope: "machine",
            cwd: myCwd,
            git_root: myGitRoot,
          });
          for (const s of senders) senderById.set(s.id, s);
        } catch {
          // Non-critical — render with opaque ids.
        }
        const lines = result.messages.map((m) => {
          const sender = senderById.get(m.from_id);
          const label = sender ? peerLabel(sender) : "";
          const who = label ? `${label} (${m.from_id})` : m.from_id;
          return `From ${who} (${m.sent_at}):\n${m.text}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "bind_orchestrator": {
      const { repo_id, boot_id } = args as { repo_id: string; boot_id: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        // The self-only guarantee lives HERE: we send our OWN myId as the row to
        // bind — never a caller-supplied id (the tool exposes only repo_id +
        // boot_id). The broker stamps role=orchestrator + repo_id + boot_id on
        // that row and echoes the authoritative peer id back. This replaces the
        // 6-signal self-id reconstruction that caused the boot self-collision.
        const result = await brokerFetch<BindOrchestratorResponse>("/bind-orchestrator", {
          id: myId,
          repo_id,
          boot_id,
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Bound as orchestrator.\n  peer_id: ${result.peer_id}\n  repo_id: ${result.repo_id}\n` +
                `  boot_id: ${result.boot_id}\n\nThis is your authoritative peer id — use it as your own id.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error binding orchestrator: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      let fromDisplay = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
          // D-0060: sender's readable identity for the "── from … ──" header —
          // the client-supplied display_name if set, else the broker-derived
          // canonical identity (profile colour + repo). Display context only;
          // the reply is still addressed by from_id (the opaque routing key).
          fromDisplay = peerLabel(sender);
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — this is what makes it immediate
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_display: fromDisplay,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Re-register on broker loss (Open-016 Phase 3b) ---
//
// /register happens once at startup. After a broker restart the adapter is
// alive but registered nowhere, so poll/heartbeat silently no-op and the
// session lingers blind. We re-/register when the broker reports it no longer
// knows us (heartbeat `known: false`). The broker reuses the id for our known
// live PID (Phase 3c), so the re-register is identity-stable — myId is
// unchanged in the normal case, and we re-stamp + repaint either way.
async function reRegister(): Promise<void> {
  try {
    const reg = await brokerFetch<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: myCwd,
      git_root: myGitRoot,
      // CONV-10767 worktree fix: re-present the same normalized repo_root so a
      // re-register (post broker-blip) never blanks it.
      repo_root: myRepoRoot,
      tty: myTty,
      profile: myProfile,
      host: myHost,
      machine: myMachine,
      // D-0060: re-present the same readable name so a re-register never blanks it.
      display_name: myDisplayName,
      slug: mySlug,
      summary: mySummary,
      // GBA-8: re-present the SAME boot_id so a live-PID re-register is
      // recognised as us (the broker's anti-hijack requires the echo to match).
      boot_id: myBootId,
    });
    const prev = myId;
    myId = reg.id;
    // GBA-9: capture the (possibly refreshed) scope-token. The broker preserves
    // it across a re-register, so it is normally unchanged; guard against an old
    // broker that returns none by keeping the prior value.
    if (reg.token) myToken = reg.token;
    stampPeerId(myId);
    if (prev && prev !== myId) {
      // Should not happen for a live PID (Phase 3c reuses the id); surface it
      // loudly if the broker minted a fresh id so an id-flip is never silent.
      log(`WARN: re-register changed peer id ${prev} -> ${myId} (expected stable for a live PID)`);
    }
    log(`Re-registered with broker as peer ${myId} (broker had forgotten us)`);
    refreshTabTitle(mySummary);
  } catch (e) {
    log(`Re-register failed (will retry on next heartbeat): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  // CONV-10767 worktree fix: normalize repo + linked worktrees to one repo_root.
  myRepoRoot = await resolveRepoRoot(myCwd, myGitRoot);
  const tty = getTty();
  // Channel identity: ITERM_PROFILE (iTerm2 sets it automatically, e.g.
  // "Blue Shadow") with a TMUX_PROFILE fallback for the Forge tmux path, ""
  // otherwise. See shared/profile_env.ts.
  const profile = resolveProfileEnv();
  // Open-016 Phase 3b: cache the registration context so reRegister() can
  // re-POST /register with the same shape after a broker loss.
  myTty = tty;
  myProfile = profile;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Repo root (normalized): ${myRepoRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);
  log(`Profile: ${profile || "(unset)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      // Seed the refresh signature so the first timer tick doesn't re-summarize
      // an unchanged context right after startup.
      lastSummaryContext = `${branch ?? ""} ${recentFiles.join(",")}`;
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    // CONV-10767 worktree fix: the normalized main-worktree root (see above).
    repo_root: myRepoRoot,
    tty,
    profile,
    host: myHost,
    machine: myMachine,
    // D-0060: transport this session's pre-composed readable name (from env).
    display_name: myDisplayName,
    slug: mySlug,
    summary: initialSummary,
    // GBA-8: send this process's boot_id so the broker stores it and can later
    // require the echo to match (defeats the PID-spoof /register hijack).
    boot_id: myBootId,
  });
  myId = reg.id;
  // GBA-9: capture the minted scope-token; brokerFetch echoes it on every
  // subsequent write so this peer is "bound" once the broker enforces.
  if (reg.token) myToken = reg.token;
  mySummary = initialSummary;
  log(`Registered as peer ${myId}`);

  // CONV-10613: stamp the broker-assigned id where this session can read it
  // (GUPPI_PEER_ID env + pid-keyed marker), closing the "session can't see its
  // own peer_id" gap. Then paint the initial self-identifying tab title.
  stampPeerId(myId);
  refreshTabTitle(initialSummary);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          mySummary = initialSummary;
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
          // CONV-10613: re-render the tab title with the late auto-summary.
          refreshTabTitle(initialSummary);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio. Open-016 Phase 3a: attach close/error handlers
  // so a stdio EOF / transport error is SURFACED loudly instead of stranding
  // the session silently (the CONV-10639 "claude-peers seems broken" bug).
  // PROBE RESULT (plan §6 Q1): the CLI does NOT auto-respawn a non-zero-exit
  // stdio MCP — so we emit a loud stderr line with a `/mcp` recovery nudge
  // BEFORE exiting non-zero, rather than exiting silently. mcp.connect() sets
  // the transport's onclose/onerror for its own protocol cleanup, so we wrap
  // (call-through) rather than clobber.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP connected");

  const closeHandler = makeTransportCloseHandler(
    { log, exit: (code) => process.exit(code) },
    "close",
  );
  const errorHandler = makeTransportCloseHandler(
    { log, exit: (code) => process.exit(code) },
    "error",
  );
  const priorOnClose = transport.onclose?.bind(transport);
  const priorOnError = transport.onerror?.bind(transport);
  transport.onclose = () => {
    try {
      priorOnClose?.();
    } finally {
      closeHandler();
    }
  };
  transport.onerror = (err) => {
    try {
      priorOnError?.(err);
    } finally {
      errorHandler(err);
    }
  };

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat. Open-016 Phase 3b: the broker now reports whether it
  // still knows us; on `known: false` (broker restarted / forgot us) we
  // re-/register instead of silently no-op'ing. The broker reuses our id for
  // our live PID (Phase 3c) so the re-register is identity-stable.
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        const hb = await brokerFetch<HeartbeatResponse>("/heartbeat", { id: myId });
        if (shouldReRegister(hb)) {
          log("Broker no longer knows this peer (known:false) — re-registering");
          await reRegister();
        }
      } catch {
        // Broker likely down right now; the next heartbeat re-checks and
        // re-registers once it is back (heartbeat reports known:false then).
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 7.5. Auto-refresh the description on a throttle so idle/silent sessions
  // don't go stale. NEVER overwrites a summary a session set deliberately
  // (summaryIsAuto=false), and skips the gpt-5.4-nano call when the branch +
  // recent files are unchanged since the last refresh (cost guard → near-zero
  // when idle). Host-agnostic: runs in every session regardless of terminal.
  const SUMMARY_REFRESH_INTERVAL_MS = 12 * 60 * 1000; // 12 min
  const summaryRefreshTimer = setInterval(async () => {
    if (!summaryIsAuto || !myId) return;
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const sig = `${branch ?? ""} ${recentFiles.join(",")}`;
      if (sig === lastSummaryContext) return; // unchanged → skip the LLM call
      lastSummaryContext = sig;
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary && summary !== mySummary) {
        mySummary = summary;
        await brokerFetch("/set-summary", { id: myId, summary });
        refreshTabTitle(summary);
        log(`Auto-refreshed summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-refresh failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  }, SUMMARY_REFRESH_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearInterval(summaryRefreshTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Only boot the stdio server + broker when run as the entry point. Importing
// this module (e.g. from a test that introspects the TOOLS surface) must NOT
// trigger main() / ensureBroker() / a live /register.
if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

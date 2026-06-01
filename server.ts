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
  KillPeerResponse,
  PollMessagesResponse,
  Message,
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
import { composeTabTitle, profileToChannel } from "./shared/tabtitle";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const HMAC_SECRET = process.env.CLAUDE_PEERS_HMAC_SECRET ?? "";
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

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

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
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
  stampPeerIdFile(process.pid, id, process.env.ITERM_PROFILE ?? "");
}

/** Read the channel's last_conv from workstreams/.state.json (best-effort). */
function readLastConv(): string | undefined {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || myGitRoot || myCwd;
    if (!projectDir) return undefined;
    const statePath = path.join(projectDir, "workstreams", ".state.json");
    const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const channel = profileToChannel(process.env.ITERM_PROFILE ?? "");
    if (!channel) return undefined;
    const slice = data?.channels?.[channel];
    const conv = slice?.last_conv;
    return typeof conv === "string" && conv ? conv : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-render + emit the self-identifying tab title after a summary change. The
 * server is a bun subprocess with no iTerm2 Python API, so it (a) records the
 * new label into the marker file and (b) shells out to the AppleScript
 * `set name` leg targeting $ITERM_SESSION_ID — both bypass the profile's
 * `Allow Title Setting: false` OSC gate (CONV-8207). Fully best-effort: any
 * failure is logged and swallowed so it can never break set_summary.
 */
function refreshTabTitle(summary: string): void {
  try {
    if (myId) {
      stampPeerIdFile(process.pid, myId, process.env.ITERM_PROFILE ?? "", { LABEL: summary });
    }
    const sessionId = process.env.ITERM_SESSION_ID ?? "";
    if (!sessionId) return; // not in an iTerm2 session (SSH/CI/Terminal.app)
    const channel = profileToChannel(process.env.ITERM_PROFILE ?? "");
    const title = composeTabTitle(channel, myId ?? undefined, readLastConv(), summary);
    const uuid = sessionId.includes(":") ? sessionId.slice(sessionId.lastIndexOf(":") + 1) : sessionId;
    // Explicit-session targeting (Roman directive 2026-05-11, CONV-8191): walk
    // sessions by unique id rather than touching the frontmost window.
    const applescript = [
      "on run argv",
      "  set targetTitle to item 1 of argv",
      "  set targetUUID to item 2 of argv",
      '  tell application "iTerm2"',
      "    repeat with w in windows",
      "      repeat with t in tabs of w",
      "        repeat with s in sessions of t",
      "          if (unique id of s as string) is targetUUID then",
      "            tell s to set name to targetTitle",
      "            return",
      "          end if",
      "        end repeat",
      "      end repeat",
      "    end repeat",
      "  end tell",
      "end run",
    ].join("\n");
    Bun.spawn(["osascript", "-", title, uuid], {
      stdin: new TextEncoder().encode(applescript),
      stdout: "ignore",
      stderr: "ignore",
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

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

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
- kill_peer: Terminate another instance by ID (sends SIGTERM, or SIGKILL/SIGINT). Use sparingly — this kills the target process. Prefer send_message with a "please stop" / session.pause envelope first; reserve kill_peer for an unresponsive peer or an orchestrator-level emergency stop.

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
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
    name: "kill_peer",
    description:
      "Terminate another Claude Code instance by peer ID. Sends a signal (default SIGTERM) to the target's process. Use sparingly: prefer send_message with a 'please stop' / session.pause request first, and reserve this for an unresponsive peer or an orchestrator-level emergency stop. The target leaves list_peers immediately on success.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        signal: {
          type: "string" as const,
          enum: ["SIGTERM", "SIGKILL", "SIGINT"],
          description:
            "Signal to send (default SIGTERM — lets the target unregister + exit cleanly). Use SIGKILL only if SIGTERM did not work.",
        },
      },
      required: ["to_id"],
    },
  },
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

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.profile) parts.push(`Profile: ${p.profile}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
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
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
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

    case "kill_peer": {
      const { to_id, signal } = args as { to_id: string; signal?: "SIGTERM" | "SIGKILL" | "SIGINT" };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      if (to_id === myId) {
        return {
          content: [{ type: "text" as const, text: "Refusing to kill_peer myself — exit normally instead." }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<KillPeerResponse>("/kill-peer", {
          from_id: myId,
          to_id,
          signal,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to kill peer ${to_id}: ${result.error}` }],
            isError: true,
          };
        }
        const note = result.error ? ` (${result.error})` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent ${signal ?? "SIGTERM"} to peer ${to_id} (pid ${result.pid})${note}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error killing peer: ${e instanceof Error ? e.message : String(e)}`,
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

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  // ITERM_PROFILE is set automatically by iTerm2 to the dynamic-profile name
  // (e.g. "Blue Shadow"). Empty string for non-iTerm callers.
  const profile = process.env.ITERM_PROFILE ?? "";

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
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
    tty,
    profile,
    summary: initialSummary,
  });
  myId = reg.id;
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

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
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

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

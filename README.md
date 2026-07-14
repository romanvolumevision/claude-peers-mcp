# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)               |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable                | Default              | Description                                                                                                                                                                              |
| ----------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`                 | `7899`               | Broker port                                                                                                                                                                              |
| `CLAUDE_PEERS_DB`                   | `~/.claude-peers.db` | SQLite database path                                                                                                                                                                     |
| `OPENAI_API_KEY`                    | —                    | Enables auto-summary via gpt-5.4-nano                                                                                                                                                    |
| `CLAUDE_PEERS_RELAY_AUDIT_ENABLED` | `0` (off)            | When truthy (`1`/`true`/`yes`/`on`, case-insensitive), the broker POSTs HMAC-signed audit envelopes to the guppi `/broker-audit-relay` receiver. Default-off until the receiver is deployed AND `CLAUDE_PEERS_HMAC_SECRET` is provisioned (Atlas #3136 / PR-A-FOLLOWUP-1). |
| `BROKER_IDENTITY_BIND_MODE`         | `off`                | S1 per-peer identity binding (GBA-7/8/9). `off` = byte-identical to pre-GBA789 (no checks, claimed id accepted verbatim). `warn` = check + emit an `identity_mismatch` audit on a mismatch but still accept. `enforce` = reject (401) a mismatch / missing credential for a **bound** peer. Peers with an empty stored token (`''` — un-upgraded `server.ts` or a pre-migration row) are "unbound" and skipped in every mode. |

### Identity-bind rollout & respawn safety

The broker runs under launchd with **`KeepAlive=true`**: it execs `bun broker.ts` **from the working tree**, so any exit is respawned onto **whatever `broker.ts` is on disk at that instant**. That respawn is **uncontrolled** — it is launchd's call, not the operator's, and it can fire at any time (crash, OOM, machine wake), including **before** a controlled re-register of the peer fleet. So the "tolerance window" for un-upgraded peers can open **unchosen**: the merged broker can boot on the live DB while every existing peer is still `''`-unbound.

This is safe because **the enforce-gate ordering keeps the flag `off` across that whole window**:

1. **Land the broker flag-off** (this stays byte-identical — an uncontrolled respawn onto it is a non-event; proven by `identity_bind_respawn.test.ts`).
2. **`server.ts` populates `token`/`boot_id`** (PR-B) so peers echo a credential.
3. **Re-register the fleet** so live rows are bound.
4. **Operator flips `warn` → `enforce`** — the only step that changes acceptance, and it is a deliberate operator action, never a respawn side effect.

Because an uncontrolled respawn only ever re-execs the same on-disk `broker.ts` with the same env (flag still `off`), it **cannot** advance that sequence on its own. The respawn proof (`identity_bind_respawn.test.ts`) demonstrates it end-to-end: kill broker-A, respawn broker-B from the same merged `broker.ts` on the same DB, and existing peers are still accepted **byte-identically** — `/list-peers` reads back byte-for-byte, a forged `from_id` still flows (200), messages still deliver, and no `token`/`boot_id`/`repo_id`/`session_id` column is ever leaked.

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)

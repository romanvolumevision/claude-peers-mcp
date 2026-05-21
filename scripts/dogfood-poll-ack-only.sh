#!/usr/bin/env bash
# Dogfood smoke for PR-C /poll-messages?ack-only=true peek-only mode.
# Pre-req: broker running locally on $CLAUDE_PEERS_PORT (default 7899);
#          at least one undelivered message addressed to $PEER_ID (send via
#          the existing claude-peers MCP send_message tool from another peer
#          before running this script).
set -euo pipefail

# Portability preflight.
for cmd in curl openssl python3 jq date; do
  command -v "$cmd" >/dev/null || { echo "FAIL: missing command: $cmd" >&2; exit 3; }
done

PORT="${CLAUDE_PEERS_PORT:-7899}"
PEER_ID="${1:?usage: dogfood-poll-ack-only.sh <peer-id>}"
SECRET="${CLAUDE_PEERS_HMAC_SECRET:?Set CLAUDE_PEERS_HMAC_SECRET first}"

post_signed_query() {
  local path="$1"; local body="$2"
  local ts; ts="$(date +%s)"
  local sig; sig="$(printf '%s:%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"
  curl -sS -X POST "http://127.0.0.1:${PORT}${path}" \
    -H 'Content-Type: application/json' \
    -H "X-Claude-Peers-Auth: ${sig}" \
    -H "X-Claude-Peers-Timestamp: ${ts}" \
    --data "$body"
  echo
}

echo "--- 1. Peek-only (idempotent — two identical calls):"
PEEK1=$(post_signed_query '/poll-messages?ack-only=true' "{\"id\":\"${PEER_ID}\"}")
echo "$PEEK1"
PEEK2=$(post_signed_query '/poll-messages?ack-only=true' "{\"id\":\"${PEER_ID}\"}")
echo "$PEEK2"
if [ "$PEEK1" != "$PEEK2" ]; then
  echo "FAIL: peek responses differ — idempotency broken." >&2
  exit 1
fi

# Assert COUNT > 0 so the script can't false-pass on an empty queue.
COUNT=$(printf '%s' "$PEEK1" | jq '.messages | length')
if [ "$COUNT" -eq 0 ]; then
  echo "SKIP: no undelivered messages addressed to ${PEER_ID}; send one via claude-peers MCP send_message from another peer, then re-run." >&2
  exit 2
fi
echo "--- 2. Peek-only returned ${COUNT} undelivered message(s) without marking them."

echo "--- 3. Atomic peek+ack (legacy mode, no query param) — flips delivered=1:"
ATOMIC=$(post_signed_query '/poll-messages' "{\"id\":\"${PEER_ID}\"}")
echo "$ATOMIC"
ATOMIC_COUNT=$(printf '%s' "$ATOMIC" | jq '.messages | length')
if [ "$ATOMIC_COUNT" -ne "$COUNT" ]; then
  echo "FAIL: atomic peek returned ${ATOMIC_COUNT} but peek-only returned ${COUNT} — contract divergence." >&2
  exit 1
fi

echo "--- 4. Peek-only again — should return empty (messages now marked delivered):"
FINAL=$(post_signed_query '/poll-messages?ack-only=true' "{\"id\":\"${PEER_ID}\"}")
echo "$FINAL"
FINAL_COUNT=$(printf '%s' "$FINAL" | jq '.messages | length')
if [ "$FINAL_COUNT" -ne 0 ]; then
  echo "FAIL: after atomic drain, peek-only still returned ${FINAL_COUNT} messages — atomic peek+ack didn't flip delivered=1 OR new messages arrived mid-test." >&2
  exit 1
fi

echo "PASS: dogfood smoke complete. ${COUNT} message(s) peeked-only (idempotent), atomic-drained, final peek empty."

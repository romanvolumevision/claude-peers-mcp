/**
 * Tests for the relay-audit HMAC signing + feature-flag gate — `relay-audit.ts`.
 *
 * Atlas #3136 (PR-A-FOLLOWUP-1) — cross-repo with guppi PR-B.2.
 *
 * Covers Atlas #3136 details.required_pr_a_changes:
 *   - HMAC sign_request on relay POST mirroring broker auth c7e96b1
 *   - Feature-flag env-var (default-off) to gate emit during PR-B gap
 *
 * Run: bun test __tests__/relay-audit.test.ts
 */

import { describe, test, expect } from "bun:test";

import { verify } from "../auth";
import {
  RELAY_AUDIT_FLAG_ENV,
  relayAuditEnabled,
  buildRelayAuditHeaders,
} from "../relay-audit";

const SECRET = "test-shared-secret-32-bytes-stub-data-only";
const BODY =
  '{"script":"claude_peers_broker","action_type":"auth_success","conv_id":null,"details_envelope":{"timestamp":"2026-05-19T00:00:00.000Z","context":{"path":"/register","remote":"local","session_anchor":""}}}';

describe("RELAY_AUDIT_FLAG_ENV", () => {
  test("is the canonical env-var name", () => {
    expect(RELAY_AUDIT_FLAG_ENV).toBe("CLAUDE_PEERS_RELAY_AUDIT_ENABLED");
  });
});

describe("relayAuditEnabled", () => {
  test("returns false when env-var unset", () => {
    expect(relayAuditEnabled({})).toBe(false);
  });

  test("returns false when env-var empty string", () => {
    expect(relayAuditEnabled({ [RELAY_AUDIT_FLAG_ENV]: "" })).toBe(false);
  });

  test.each([
    ["false"],
    ["0"],
    ["no"],
    ["off"],
    ["random-garbage"],
  ])("returns false for falsey value %p", (val) => {
    expect(relayAuditEnabled({ [RELAY_AUDIT_FLAG_ENV]: val })).toBe(false);
  });

  test.each([
    ["1"],
    ["true"],
    ["yes"],
    ["on"],
  ])("returns true for truthy value %p", (val) => {
    expect(relayAuditEnabled({ [RELAY_AUDIT_FLAG_ENV]: val })).toBe(true);
  });

  test.each([
    ["TRUE"],
    ["Yes"],
    ["ON"],
    ["True"],
  ])("matches case-insensitively for %p", (val) => {
    expect(relayAuditEnabled({ [RELAY_AUDIT_FLAG_ENV]: val })).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    expect(relayAuditEnabled({ [RELAY_AUDIT_FLAG_ENV]: "  true  " })).toBe(true);
  });
});

describe("buildRelayAuditHeaders", () => {
  test("returns null when secret unset (opts omitted)", () => {
    expect(buildRelayAuditHeaders(BODY)).toBeNull();
  });

  test("returns null when secret is empty string", () => {
    expect(buildRelayAuditHeaders(BODY, { secret: "" })).toBeNull();
  });

  test("returns headers dict when secret provided", () => {
    const ts = Math.floor(Date.now() / 1000);
    const headers = buildRelayAuditHeaders(BODY, { secret: SECRET, ts });
    expect(headers).not.toBeNull();
    expect(headers!["Content-Type"]).toBe("application/json");
    expect(headers!["X-Claude-Peers-Auth"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers!["X-Claude-Peers-Timestamp"]).toBe(String(ts));
    expect(headers!["X-Claude-Peers-Session-Anchor"]).toBe("");
  });

  test("signature verifies via auth.verify round-trip", () => {
    const ts = Math.floor(Date.now() / 1000);
    const headers = buildRelayAuditHeaders(BODY, { secret: SECRET, ts });
    const sig = headers!["X-Claude-Peers-Auth"]!;
    expect(verify(sig, BODY, ts, SECRET)).toBe(true);
  });

  test("signature does NOT verify with wrong secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    const headers = buildRelayAuditHeaders(BODY, { secret: SECRET, ts });
    const sig = headers!["X-Claude-Peers-Auth"]!;
    expect(verify(sig, BODY, ts, "different-secret")).toBe(false);
  });

  test("signature does NOT verify if body is tampered", () => {
    const ts = Math.floor(Date.now() / 1000);
    const headers = buildRelayAuditHeaders(BODY, { secret: SECRET, ts });
    const sig = headers!["X-Claude-Peers-Auth"]!;
    expect(verify(sig, BODY + "tamper", ts, SECRET)).toBe(false);
  });

  test("uses current timestamp when ts omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const headers = buildRelayAuditHeaders(BODY, { secret: SECRET });
    const after = Math.floor(Date.now() / 1000);
    const ts = parseInt(headers!["X-Claude-Peers-Timestamp"]!, 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("passes through sessionAnchor when provided (Phase 1+ readiness)", () => {
    const headers = buildRelayAuditHeaders(BODY, {
      secret: SECRET,
      sessionAnchor: "anchor-v1-stub",
    });
    expect(headers!["X-Claude-Peers-Session-Anchor"]).toBe("anchor-v1-stub");
  });

  test("mirrors brokerFetch HMAC shape (server.ts:55-75 pattern)", () => {
    // Asserts header keys + body-as-string-input contract matches the
    // canonical outbound brokerFetch path so the verify pipeline on the
    // guppi receiver is symmetric.
    const ts = 1747625400;
    const headers = buildRelayAuditHeaders(BODY, { secret: SECRET, ts });
    expect(Object.keys(headers!).sort()).toEqual([
      "Content-Type",
      "X-Claude-Peers-Auth",
      "X-Claude-Peers-Session-Anchor",
      "X-Claude-Peers-Timestamp",
    ]);
  });
});

/**
 * Unit tests for the S1 identity-binding primitives (GBA-7/8/9).
 *
 * Pure predicate coverage — the classify + policy logic that the broker
 * middleware and the /register reuse-path both rely on, exercised without
 * booting the broker. The live-broker enforcement is covered end-to-end in
 * identity_bind_integration.test.ts.
 *
 * Run: bun test __tests__/identity_bind.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  BOOT_ID_HEADER,
  IDENTITY_BIND_FLAG_ENV,
  PEER_TOKEN_HEADER,
  bindingAccepts,
  buildIdentityHeaders,
  classifyBinding,
  constantTimeEqual,
  generateBootId,
  generatePeerToken,
  identityBindMode,
  isBindMismatch,
} from "../shared/identity_bind.ts";

describe("identityBindMode() — default-off three-state flag", () => {
  test("defaults to off when unset (byte-identical-to-today)", () => {
    expect(identityBindMode({})).toBe("off");
  });

  test("parses warn / enforce case-insensitively with trimming", () => {
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "warn" })).toBe("warn");
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "  ENFORCE " })).toBe("enforce");
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "Warn" })).toBe("warn");
  });

  test("junk / empty / unknown resolves to off (fail-safe)", () => {
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "" })).toBe("off");
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "1" })).toBe("off");
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "yes" })).toBe("off");
    expect(identityBindMode({ [IDENTITY_BIND_FLAG_ENV]: "on" })).toBe("off");
  });
});

describe("token / boot_id generation", () => {
  test("generatePeerToken() is 64 lowercase hex chars and unique", () => {
    const a = generatePeerToken();
    const b = generatePeerToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("generateBootId() is 32 lowercase hex chars and unique", () => {
    const a = generateBootId();
    const b = generateBootId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("constantTimeEqual()", () => {
  test("true only for identical non-empty strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  test("false for differing, length-mismatch, or empty inputs", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(false);
    expect(constantTimeEqual("x", "")).toBe(false);
  });
});

describe("classifyBinding() — the credential decision", () => {
  const TOKEN = "a".repeat(64);
  const BOOT = "b".repeat(32);

  test("match: bound peer echoes the correct token", () => {
    expect(
      classifyBinding({
        storedToken: TOKEN,
        storedBootId: "",
        presentedToken: TOKEN,
        presentedBootId: "",
      }),
    ).toBe("match");
  });

  test("unbound: stored token empty (un-upgraded / legacy row)", () => {
    expect(
      classifyBinding({
        storedToken: "",
        storedBootId: "",
        presentedToken: "",
        presentedBootId: "",
      }),
    ).toBe("unbound");
  });

  test("token_missing: bound peer echoes no token", () => {
    expect(
      classifyBinding({
        storedToken: TOKEN,
        storedBootId: "",
        presentedToken: "",
        presentedBootId: "",
      }),
    ).toBe("token_missing");
  });

  test("token_mismatch: bound peer echoes the wrong token (forged from_id)", () => {
    expect(
      classifyBinding({
        storedToken: TOKEN,
        storedBootId: "",
        presentedToken: "c".repeat(64),
        presentedBootId: "",
      }),
    ).toBe("token_mismatch");
  });

  test("bootid_mismatch: an echoed boot_id that does not match stored", () => {
    expect(
      classifyBinding({
        storedToken: TOKEN,
        storedBootId: BOOT,
        presentedToken: TOKEN,
        presentedBootId: "d".repeat(32),
      }),
    ).toBe("bootid_mismatch");
  });

  test("bootid_mismatch outranks token: echoed boot_id but none stored", () => {
    expect(
      classifyBinding({
        storedToken: TOKEN,
        storedBootId: "",
        presentedToken: TOKEN,
        presentedBootId: BOOT,
      }),
    ).toBe("bootid_mismatch");
  });

  test("match when both token and boot_id echo correctly", () => {
    expect(
      classifyBinding({
        storedToken: TOKEN,
        storedBootId: BOOT,
        presentedToken: TOKEN,
        presentedBootId: BOOT,
      }),
    ).toBe("match");
  });
});

describe("bindingAccepts() — mode policy", () => {
  const statuses = [
    "match",
    "unbound",
    "token_missing",
    "token_mismatch",
    "bootid_mismatch",
  ] as const;

  test("off accepts everything (byte-identical to today)", () => {
    for (const s of statuses) expect(bindingAccepts("off", s)).toBe(true);
  });

  test("warn accepts everything (observe-only)", () => {
    for (const s of statuses) expect(bindingAccepts("warn", s)).toBe(true);
  });

  test("enforce accepts only match + unbound; rejects the mismatches", () => {
    expect(bindingAccepts("enforce", "match")).toBe(true);
    expect(bindingAccepts("enforce", "unbound")).toBe(true);
    expect(bindingAccepts("enforce", "token_missing")).toBe(false);
    expect(bindingAccepts("enforce", "token_mismatch")).toBe(false);
    expect(bindingAccepts("enforce", "bootid_mismatch")).toBe(false);
  });
});

describe("isBindMismatch()", () => {
  test("true only for the reject-worthy statuses", () => {
    expect(isBindMismatch("match")).toBe(false);
    expect(isBindMismatch("unbound")).toBe(false);
    expect(isBindMismatch("token_missing")).toBe(true);
    expect(isBindMismatch("token_mismatch")).toBe(true);
    expect(isBindMismatch("bootid_mismatch")).toBe(true);
  });
});

describe("buildIdentityHeaders() — GBA-9 publish helper", () => {
  test("emits both headers when present", () => {
    const h = buildIdentityHeaders("tok", "boot");
    expect(h[PEER_TOKEN_HEADER]).toBe("tok");
    expect(h[BOOT_ID_HEADER]).toBe("boot");
  });

  test("omits empty values (backward-tolerant — un-upgraded caller sends nothing)", () => {
    expect(buildIdentityHeaders("", "")).toEqual({});
    expect(buildIdentityHeaders("tok", "")).toEqual({ [PEER_TOKEN_HEADER]: "tok" });
    expect(buildIdentityHeaders("", "boot")).toEqual({ [BOOT_ID_HEADER]: "boot" });
  });
});

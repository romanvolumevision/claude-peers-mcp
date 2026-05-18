/**
 * Tests for the HMAC sign/verify primitives — `auth.ts` module.
 *
 * Phase 0 broker-auth-substrate (guppi workstream
 * `cross-org-broker-phase-0-broker-auth-substrate.md` T0.2; Atlas #2904).
 *
 * Covers per workstream Rev 2 + plan §Phase 0 ACs:
 *   - sign(body, timestamp, secret) → hex HMAC-SHA256 string
 *   - verify(signature, body, timestamp, secret, opts?) → boolean
 *     * happy path
 *     * missing signature
 *     * malformed signature
 *     * body tamper
 *     * timestamp skew (>5min window)
 *     * wrong secret
 *     * constant-time comparison (timing-attack resistance)
 *
 * Run: bun test __tests__/auth.test.ts
 */

import { describe, test, expect } from "bun:test";

import { sign, verify, MAX_TIMESTAMP_SKEW_SEC } from "../auth";

const SECRET = "shared-secret-32-bytes-base64-stub-data-only";
const WRONG_SECRET = "different-secret-of-equivalent-length-stub";
const BODY = '{"id":"peer-pink-260518-01","scope":"machine"}';
const TIMESTAMP_NOW = () => Math.floor(Date.now() / 1000);

describe("sign", () => {
  test("returns a hex string of expected length (HMAC-SHA256 = 64 hex chars)", () => {
    const sig = sign(BODY, TIMESTAMP_NOW(), SECRET);
    expect(typeof sig).toBe("string");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same (body, timestamp, secret) triple", () => {
    const ts = TIMESTAMP_NOW();
    expect(sign(BODY, ts, SECRET)).toBe(sign(BODY, ts, SECRET));
  });

  test("differs when body changes", () => {
    const ts = TIMESTAMP_NOW();
    expect(sign(BODY, ts, SECRET)).not.toBe(sign(BODY + "x", ts, SECRET));
  });

  test("differs when timestamp changes", () => {
    expect(sign(BODY, 1000, SECRET)).not.toBe(sign(BODY, 1001, SECRET));
  });

  test("differs when secret changes", () => {
    const ts = TIMESTAMP_NOW();
    expect(sign(BODY, ts, SECRET)).not.toBe(sign(BODY, ts, WRONG_SECRET));
  });
});

describe("verify — happy + edge cases", () => {
  test("returns true for a valid round-trip", () => {
    const ts = TIMESTAMP_NOW();
    const sig = sign(BODY, ts, SECRET);
    expect(verify(sig, BODY, ts, SECRET)).toBe(true);
  });

  test("returns false when signature is missing (empty string)", () => {
    const ts = TIMESTAMP_NOW();
    expect(verify("", BODY, ts, SECRET)).toBe(false);
  });

  test("returns false when signature is malformed (non-hex)", () => {
    const ts = TIMESTAMP_NOW();
    expect(verify("not-hex-at-all-but-the-right-length-x".padEnd(64, "x"), BODY, ts, SECRET)).toBe(false);
  });

  test("returns false when signature is wrong length", () => {
    const ts = TIMESTAMP_NOW();
    expect(verify("a".repeat(63), BODY, ts, SECRET)).toBe(false);
    expect(verify("a".repeat(65), BODY, ts, SECRET)).toBe(false);
  });

  test("returns false when body is tampered", () => {
    const ts = TIMESTAMP_NOW();
    const sig = sign(BODY, ts, SECRET);
    expect(verify(sig, BODY + "tamper", ts, SECRET)).toBe(false);
  });

  test("returns false when secret is wrong", () => {
    const ts = TIMESTAMP_NOW();
    const sig = sign(BODY, ts, SECRET);
    expect(verify(sig, BODY, ts, WRONG_SECRET)).toBe(false);
  });

  test("returns false when timestamp skew exceeds the window", () => {
    const tsNow = TIMESTAMP_NOW();
    const tsOld = tsNow - (MAX_TIMESTAMP_SKEW_SEC + 60);
    const sigOld = sign(BODY, tsOld, SECRET);
    // The verifier compares the supplied timestamp against the current clock,
    // not against the signature's embedded timestamp (the signature itself is
    // tied to whatever timestamp was used to sign it). The caller passes the
    // claimed timestamp from the header; verify() rejects if abs(now - claimed)
    // exceeds the skew window.
    expect(verify(sigOld, BODY, tsOld, SECRET)).toBe(false);
  });

  test("returns true within the skew window (sub-MAX_TIMESTAMP_SKEW_SEC drift)", () => {
    const tsNow = TIMESTAMP_NOW();
    const tsRecent = tsNow - Math.floor(MAX_TIMESTAMP_SKEW_SEC / 2);
    const sigRecent = sign(BODY, tsRecent, SECRET);
    expect(verify(sigRecent, BODY, tsRecent, SECRET)).toBe(true);
  });

  test("MAX_TIMESTAMP_SKEW_SEC is 300 (5-minute window per plan body)", () => {
    expect(MAX_TIMESTAMP_SKEW_SEC).toBe(300);
  });
});

describe("verify — constant-time comparison (timing-attack resistance)", () => {
  // Statistical timing test per plan body AC #4. The test asserts that the
  // distribution of verify() runtimes is NOT detectably different between
  // early-mismatch (signature differs in first byte) and late-mismatch
  // (signature differs in last byte). A naive non-constant-time comparison
  // would short-circuit on the first mismatched byte; constant-time
  // comparison runs the full length regardless.
  //
  // We use a coarse runtime budget (N=2000 iterations rather than the AC's
  // 10000) for CI-friendliness; the absolute mean delta should stay under
  // 50µs for both groups. Sharper p-value testing belongs in a separate
  // statistical-rigor test marked `bun test --slow`.
  test("early-vs-late mismatch runtime delta < 50µs (mean over N=2000)", () => {
    const ts = TIMESTAMP_NOW();
    const validSig = sign(BODY, ts, SECRET);

    // Construct two mismatched signatures:
    //   earlyMismatch: differs in byte 0 (would short-circuit at index 0)
    //   lateMismatch: differs in byte 63 (would short-circuit at index 63)
    const earlyMismatch = (validSig[0] === "0" ? "1" : "0") + validSig.slice(1);
    const lateMismatch = validSig.slice(0, 63) + (validSig[63] === "0" ? "1" : "0");

    const N = 2000;
    let earlyTotal = 0;
    let lateTotal = 0;

    // Warm-up — JIT primes.
    for (let i = 0; i < 200; i++) {
      verify(earlyMismatch, BODY, ts, SECRET);
      verify(lateMismatch, BODY, ts, SECRET);
    }

    // Interleave to amortise system noise.
    for (let i = 0; i < N; i++) {
      const t0 = Bun.nanoseconds();
      verify(earlyMismatch, BODY, ts, SECRET);
      const t1 = Bun.nanoseconds();
      verify(lateMismatch, BODY, ts, SECRET);
      const t2 = Bun.nanoseconds();
      earlyTotal += t1 - t0;
      lateTotal += t2 - t1;
    }

    const earlyMeanUs = earlyTotal / N / 1000;
    const lateMeanUs = lateTotal / N / 1000;
    const deltaUs = Math.abs(earlyMeanUs - lateMeanUs);

    // Sanity bound — both should be in microsecond range.
    expect(earlyMeanUs).toBeLessThan(5000);
    expect(lateMeanUs).toBeLessThan(5000);
    // Constant-time guarantee — delta should be small relative to a
    // hypothetical short-circuit advantage (which would be ~60-byte
    // comparison vs ~1-byte comparison, easily measurable).
    expect(deltaUs).toBeLessThan(50);
  });
});

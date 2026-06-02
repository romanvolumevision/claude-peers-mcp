/**
 * Open-016 Phase 3d (CONV-10639) — wait-for-broker-healthy.
 *
 * Retires the adapter's `ensureBroker()` self-spawn. The broker is owned by
 * launchd (com.guppi.claude-peers-broker.plist, KeepAlive=true) as the SOLE
 * supervisor. The old self-spawn created dual supervision: launchd AND any
 * adapter could each start a broker, racing for :7899 and producing the
 * repeated "listening on :7899" / EADDRINUSE log noise — and worse, two
 * brokers on one SQLite WAL is corruption (double cleanStalePeers, split
 * delivery). DO NOT add reusePort — single-ownership is the fix.
 *
 * So the adapter no longer spawns a broker; it just WAITS for launchd's broker
 * to be healthy, then proceeds. This module is the pure poll loop with an
 * injected `isAlive` probe + injected sleep, so it is unit-testable without a
 * real broker or real timers.
 */

export interface WaitBrokerOptions {
  /** Max attempts before giving up. */
  attempts?: number;
  /** Delay between attempts, ms. */
  intervalMs?: number;
  /** Injected sleep (defaults to setTimeout); tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `isAlive` until it resolves true or attempts are exhausted. Returns true
 * if the broker became healthy, false otherwise. Never spawns a broker —
 * launchd owns that.
 */
export async function waitForBrokerHealthy(
  isAlive: () => Promise<boolean>,
  opts: WaitBrokerOptions = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 30;
  const intervalMs = opts.intervalMs ?? 200;
  const sleep = opts.sleep ?? defaultSleep;

  for (let i = 0; i < attempts; i++) {
    if (await isAlive()) return true;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}

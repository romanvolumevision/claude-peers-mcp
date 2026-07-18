---
title: "Build contract — board-10 #3567 broker long-poll delivery (delivery-lag)"
type: build-contract
parent: "[[CLAUDE.md]]"   # claude-peers-mcp is a flat single-package repo; no CONTEXT/MOC room
asset: "broker.ts · server.ts · shared/longpoll.ts · shared/types.ts · broker_longpoll.test.ts · longpoll_helpers.test.ts · server_longpoll_e2e.test.ts"
class: "mcp"
conv: "CONV-11507"
opened: "2026-07-19"
status: closed   # open | closed — only /build-contract check may set closed
# single-PR build → closes at its PR (no carried-open)
---

## 0 · Goal (refused if empty)

**What are we actually trying to achieve? What does done look like?**

> Peer message delivery was poll-GATED only: `server.ts` polled every 1000ms and
> the broker's `/poll-messages` returned immediately (non-blocking, no
> push-on-insert), so a queued message waited up to ~1s (avg ~500ms) for the
> recipient's next poll. board-10/#3567 makes delivery near-instant via LONG-POLL
> while CUTTING idle poll load, and removes the per-message `/list-peers`
> amplifier. **Done =** (broker) `/poll-messages` holds an empty poll open until
> an insert for that recipient wakes it, a bounded timeout (~25s), or the client
> disconnects, waking ONLY the recipient's waiters; (client) `server.ts`
> long-polls and re-polls immediately when the broker long-polled, else falls
> back to the interval floor so a peer is NEVER left deaf; sender enrichment is
> fetched ONCE per drain, not per message. Backward-compatible (an old client
> omits `wait_ms` → never held; an old broker ignores it → client stays on
> interval polling) and restart-gated (bundles into the board-13 restart window
> like board-49). Proven RED-first end-to-end, Sol-red-teamed to CLEAN, no
> disruption to the live broker on :7899.

## The boxes

Rules: **State** is `OPEN`, `DONE`, or `N/A — <one-line reason>`. **Evidence**
is ONE line: `probe/command → artifact path or PR link` (verbatim probe output
goes in the Close ledger, never in the cell). A pointer into the asset's own
prose counts only for boxes asking whether something *exists in the asset*
(1–5, 7–8, 10); boxes 6 and 9 require evidence **external to the asset** — an
independent cold-reader/red-team output or a re-runnable probe. Boxes marked ★
are **never N/A**. A box with an inapplicable sub-part stays DONE if every
applicable sub-part is evidenced and the N/A sub-part carries its one-line
reason in the cell.

| # | Box — the question, in Roman's words | Source | State | Evidence |
|---|--------------------------------------|--------|-------|----------|
| 1 | **Deterministic 90/10** — which steps are code, which are rules, which are AI? Is the AI slice thin and justified? | D-0007 | DONE | 100% deterministic routing code (hold/wake/pacing/hoist); AI slice = none — a message-delivery path has no AI step. |
| 2 | **Step-contracts** — is the work split into explicit steps, each handing a validated artifact to the next (no monolithic prompt-flow)? | D-0007 · D-0083 | DONE | RED-first: broker gates 1-3 failed vs unmodified broker + helpers module-not-found → impl → GREEN (RED run quoted in ledger); commit `beb2028`. |
| 3 | **The two playbooks** — structure follows Clief Notes (Map/Rooms/Tools, unit standard); behaviour follows Loop Engineering (maker/checker, gates)? | D-0073 | DONE | Maker/checker loop (RED tests + 4-round Sol adversarial checker); structure inherited — new pure logic in `shared/longpoll.ts` per the repo's `shared/` helper convention, no new room. |
| 4 | **Folder trio** — the asset's folder carries CONTEXT + CHANGELOG + ROADMAP, wikilinked up and down? | D-0094 · D-0133 | N/A — flat single-package repo; no per-asset folder trio; no new folder created (matches board-49 precedent). |  |
| 5 | **Wired, not just built** — routing/MOC row exists AND the class's registry row? | D-0018 · D-0140 | DONE | End-to-end wiring proven (not helper-only): `server_longpoll_e2e.test.ts` boots the REAL `server.ts`, message delivered sub-600ms. Registry sub-part N/A (no GUPPI registry for this repo's internals). |
| 6 | **Fresh-teammate test** — someone with only this artifact reproduces the result; quality lives in the defaults, docs carry only the judgment calls? | portfolio-publisher v1.7.0 (CONV-10767) | DONE | External re-runnable probes = `bun test broker_longpoll.test.ts longpoll_helpers.test.ts server_longpoll_e2e.test.ts` (21+e2e); quality in defaults (backward-compat, fallback belt); the 5 gates are named in code comments + test names. |
| 7 | **Ask-first gates** — anything that publishes, sends, or overwrites asks before acting; protected addresses/resources named explicitly in the asset? | portfolio-publisher v2.0.0 (CONV-10767) | DONE | No new destructive/outward action; live broker on :7899 protected — every test pins `CLAUDE_PEERS_PORT` to an isolated random high port + tmp DB, never :7899. |
| 8 | **Announces itself** — states name + version on invocation, sets expectations, offers what's possible next? | portfolio-publisher v2.1.0 (CONV-10767) | N/A — internal broker/client behaviour change; the MCP tool surface + startup logs are unchanged, no new user-facing invocation (wait_ms/long_poll are additive wire fields). |  |
| 9★ | **Red-team + audit to CLEAN** — adversarial pass at intervals and before merge; findings fixed in-loop and re-reviewed, not filed? | D-0016 · D-0020 · D-0036 | DONE | Sol (ask_anthropic_direct, Opus 4.8) 4-round red-team aimed at gap/wake-race/exhaustion → 3 real defects fixed IN-LOOP → verdict SHIP; audit-equivalent full `bun test` 287/0. Verbatim in ledger. |
| 10 | **Changelog + version** — the asset's CHANGELOG updated with a semver heading in the same PR as the change? | D-0133 | N/A — claude-peers-mcp has no CHANGELOG.md and does not bump package.json (0.1.0 across all prior PRs); changelog = conventional-commit headings + PR number, which this commit + PR carry (matches board-49). |  |
| 11★ | **Evidence, not claims** — every DONE above carries its one-line evidence pointer, and close emits the DONE vs NOT-DONE ledger below? | D-0005 · D-0008 | DONE | Every DONE row carries a probe/commit pointer; the Close ledger below quotes verbatim RED→GREEN, Sol's 4-round verdict, and the full-suite output. |

## Close — DONE vs NOT-DONE ledger

**Checked 2026-07-19 (CONV-11507). Tamper-diff: box numbers + wording match
CONTRACT-TEMPLATE v1.2.0 verbatim (GUPPI-internal wikilinks preserved as the
cross-repo instance travels with the work). Result: ALL BOXES GREEN → closed.**

- **Box 1 — DONE.** Deterministic code path (WaiterRegistry wake fan-out,
  long-poll hold loop, `nextPollDelayMs` pacing, `processInbound` hoist); AI
  slice = none. Justified: a message-routing hot path has no place for an AI step.
- **Box 2 — DONE.** RED-first executed and captured before impl (single squash
  commit `beb2028`; no separate RED commit — repo has no TDD gate, RED run
  captured below). RED → impl → GREEN.
- **Box 3 — DONE.** Maker/checker loop: RED tests + Sol's 4-round adversarial
  checker drove 3 in-loop fixes. New pure logic isolated in `shared/longpoll.ts`
  (matches the repo's `shared/*.ts` unit-testable-helper convention).
- **Box 4 — N/A.** Flat single-package repo; no per-asset folder trio; no new
  folder created.
- **Box 5 — DONE.** Wiring proven end-to-end, not helper-only:
  `server_longpoll_e2e.test.ts` boots the real `bun server.ts` against an
  isolated broker and asserts a sent message flips `delivered=1` in <600ms
  (ran ×2 non-flaky). Registry sub-part N/A (no GUPPI registry for this repo).
- **Box 6 — DONE.** Re-runnable external probes = the three test files; the 5
  gates are documented in code comments + test names, so a teammate with only the
  repo reproduces the behaviour via `bun test`.
- **Box 7 — DONE.** No new destructive/outward action; live broker :7899
  protected — tests pin an isolated `CLAUDE_PEERS_PORT` (bands 26xxx/28xxx) + tmp
  DB, and force HMAC/identity-bind/repo-wall off.
- **Box 8 — N/A.** No new user-facing invocation surface; `wait_ms`/`long_poll`
  are additive, backward-compatible wire-protocol fields.
- **Box 9★ — DONE.** Adversarial pass to CLEAN. Sol (Opus 4.8 via llm-mcp),
  4 rounds, aimed at the orch's 3 vectors (gap / wake-race / exhaustion). Three
  REAL defects surfaced and fixed IN-LOOP, each re-reviewed:
  1. **DEFECT-1** (round 2): two concurrent same-peer polls → the loser returned
     a spurious empty. Fixed: the single hold became a deadline-bounded re-hold
     loop.
  2. **Busy-spin risk** (round 3): peek-vs-drain predicate mismatch. Fixed: the
     gap-check IS the drain (unified single predicate).
  3. **Woken-but-report-empty** (round 3): a wake microseconds before the
     deadline could return empty despite a claimable row. Fixed: claim at
     wake-time (`finish(drain())`) so a genuine wake is never discarded.
  Sol round-4 verbatim final verdict:
  > (1) closed, (2) closed, (3) none. **Correction: SHIP.** … each lost-race
  > wake costs a re-drain … Not a defect. **SHIP.**
  (Gemini 3.1 Pro was run in parallel for adversarial diversity but truncated on
  internal reasoning tokens; Sol carried the review.) Audit-equivalent: full
  `bun test` 287 pass / 0 fail.
- **Box 10 — N/A.** Repo has no CHANGELOG/semver-bump convention; changelog =
  conventional-commit headings + PR number, which this PR carries.
- **Box 11★ — DONE.** This ledger + per-row pointers.

**Verbatim probe — RED baseline (new tests vs UNMODIFIED broker/server):**
```
$ bun test broker_longpoll.test.ts longpoll_helpers.test.ts
(fail) gate1: a message inserted DURING a held long-poll … Expected: 1  Received: 0
(fail) gate2: an insert for R1 wakes ONLY R1 … Expected ["for-r1"]  Received []
(fail) gate3: an empty long-poll returns after ~wait_ms … long_poll Expected: true  Received: undefined
# Unhandled error: Cannot find module './shared/longpoll.ts'
 4 pass  4 fail  1 error   (the 4 pass = backward-compat/conservation/no-wedge guards)
```

**Verbatim probe — GREEN (new tests, post-impl + all 3 Sol fixes):**
```
$ bun test broker_longpoll.test.ts longpoll_helpers.test.ts server_longpoll_e2e.test.ts
 23 pass
 0 fail
 73 expect() calls
Ran 23 tests across 3 files.
```

**Verbatim probe — full suite (regression, post-remediation):**
```
$ bun test
 287 pass
 0 fail
 886 expect() calls
Ran 287 tests across 30 files. [16.46s]
```

**Verdict: build is DONE. Contract closed.**

---
title: "Build contract — board-49 broker session_id populate-at-registration"
type: build-contract
parent: "[[CLAUDE.md]]"   # claude-peers-mcp is a flat single-package repo; no CONTEXT/MOC room
asset: "server.ts · session_id_populate.test.ts"
class: "mcp"
conv: "CONV-11482"
opened: "2026-07-19"
status: closed   # open | closed — only /build-contract check may set closed
# single-PR build → closes at its PR (no carried-open)
---

## 0 · Goal (refused if empty)

**What are we actually trying to achieve? What does done look like?**

> Every claude-peers peer row must carry its Claude Code session id in the
> `peers.session_id` column, populated by `server.ts` in the `/register` body —
> replacing the empty `''` that all 13 live rows carried — so caller-binding can
> move from process-topology (`pid`) to session-identity (the #1185 path). The
> broker column, `RegisterRequest.session_id`, and the broker's `body.session_id
> ?? ''` store already existed; only the client was not sending a value. **Done
> =** a fresh `server.ts` boot with `CLAUDE_CODE_SESSION_ID` set produces a peer
> row whose `session_id` equals that value; with a `CLAUDE_SESSION_ID` legacy
> fallback; with neither set the row stays `''` (byte-compatible with a legacy
> peer). Proven end-to-end (env → body → broker → DB), not mocked. No disruption
> to the live broker on :7899.

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
| 1 | **Deterministic 90/10** — which steps are code, which are rules, which are AI? Is the AI slice thin and justified? | D-0007 | DONE | 100% deterministic code path (env read → JSON body → SQLite store); no AI/LLM step in the register write. server.ts's only LLM call (summary gen) is unrelated + unchanged. |
| 2 | **Step-contracts** — is the work split into explicit steps, each handing a validated artifact to the next (no monolithic prompt-flow)? | D-0007 · D-0083 | DONE | RED (87fea65, fails for the right reason) → impl (70e8a37) → red-team remediation (af5d885); each step gated on the prior artifact. |
| 3 | **The two playbooks** — structure follows [[infrastructure/library/playbooks/clief-notes\|Clief Notes]] (Map/Rooms/Tools, [[infrastructure/docs/unit-structure-standard\|unit standard]]); behaviour follows [[infrastructure/library/playbooks/loop-engineering\|Loop Engineering]] (maker/checker, gates)? | D-0073 | DONE | Loop Engineering maker/checker honored: RED test = checker, impl = maker, Sol = adversarial checker, full-suite = gate. Structure inherited (single-file edit in an existing mature room; no new Map/Rooms/Tools to author). |
| 4 | **Folder trio** — the asset's folder carries CONTEXT + CHANGELOG + ROADMAP, wikilinked up and down? | D-0094 · D-0133 | N/A — claude-peers-mcp is a flat single-package repo (Bun template) with no per-asset CONTEXT/CHANGELOG/ROADMAP trio; this build edits existing files and adds no new folder. |  |
| 5 | **Wired, not just built** — routing/MOC row exists AND the class's registry row (per `infrastructure/docs/registries.md`; no registry for the class yet → N/A with that reason)? | D-0018 · D-0140 | DONE | Wiring proven end-to-end by the e2e test (env → /register body → broker → peers.session_id), not just the client half. Registry: N/A — no GUPPI registry governs claude-peers-mcp broker internals. |
| 6 | **Fresh-teammate test** — someone with only this artifact (none of our chat) reproduces the result; quality lives in the defaults, docs carry only the judgment calls? | portfolio-publisher v1.7.0 (CONV-10767) | DONE | `bun test session_id_populate.test.ts` — self-contained (boots real server.ts + isolated broker); commit bodies + this contract explain the gap/fix; a fresh teammate reproduces RED→GREEN by checking out 87fea65 then 70e8a37. |
| 7 | **Ask-first gates** — anything that publishes, sends, or overwrites asks before acting; protected addresses/resources named explicitly in the asset? | portfolio-publisher v2.0.0 (CONV-10767) | DONE | No publish/send/overwrite introduced (one field added to an existing localhost POST). Protected resource named: the LIVE broker on :7899 — every test binds only random high ports + tmp DBs (spawnBroker), never :7899. |
| 8 | **Announces itself** — states name + version on invocation, sets expectations (defaults, approximate output), offers what's possible next at the right moment? | portfolio-publisher v2.1.0 (CONV-10767) | N/A — internal register-body field; the MCP tool surface + startup logs are unchanged, so there is no new user-facing invocation to announce. |  |
| 9★ | **Red-team + audit to CLEAN** — adversarial pass at intervals and before merge; findings fixed in-loop and re-reviewed, not filed? | D-0016 · D-0020 · D-0036 | DONE | Sol (Gemini 3.1 Pro) red-team → verdict SHIP; the two items (LOW port pool, NIT untrusted-assertion note) fixed in-loop (af5d885) + re-reviewed by full-suite re-run. Audit-equivalent: full `bun test` 264 pass / 0 fail. |
| 10 | **Changelog + version** — the asset's CHANGELOG updated with a semver heading (that heading IS the version) in the same PR as the change? | D-0133 | N/A — claude-peers-mcp has no CHANGELOG.md and does not bump package.json (0.1.0 across all 18 prior PRs); its changelog mechanism is conventional-commit headings + PR number, which these 3 commits + this PR carry. |  |
| 11★ | **Evidence, not claims** — every DONE above carries its one-line evidence pointer, and close emits the DONE vs NOT-DONE ledger below? | D-0005 · D-0008 | DONE | Every DONE row above carries a probe/commit pointer; the Close ledger below quotes verbatim probe + red-team output. |

## Close — DONE vs NOT-DONE ledger

**Checked 2026-07-19 (CONV-11482). Tamper-diff: box numbers + wording match
CONTRACT-TEMPLATE v1.2.0 verbatim (GUPPI-internal wikilinks preserved as the
cross-repo instance travels with the work). Result: ALL BOXES GREEN → closed.**

- **Box 1 — DONE.** Deterministic code path; AI slice = none. Justified: a
  register-body field write has no place for an AI step.
- **Box 2 — DONE.** TDD step-contract, git-verifiable:
  - `87fea65` test(broker): RED e2e
  - `70e8a37` feat(broker): impl
  - `af5d885` harden(board-49): Sol remediation
- **Box 3 — DONE.** Maker/checker loop; structure inherited (no new room).
- **Box 4 — N/A.** Flat single-package repo; no per-asset folder trio; no new
  folder created.
- **Box 5 — DONE.** End-to-end wiring proven (not client-half only). Registry
  sub-part N/A (no GUPPI registry for this repo's internals).
- **Box 6 — DONE.** Re-runnable external probe = the e2e test file.
- **Box 7 — DONE.** No new destructive/outward action; live broker :7899
  protected — tests never touch it.
- **Box 8 — N/A.** No new user-facing invocation surface.
- **Box 9★ — DONE.** Adversarial pass to CLEAN. Sol verbatim verdict:
  > CRITICAL: None real. HIGH: None real. MED: None real.
  > LOW: Test Flakiness via Port Collision [90-port pool] … Minimal Fix: … vastly
  > increase the range. NIT: … `session_id` is an untrusted, client-provided
  > assertion … future auth must account for it.
  > 1. `||` is correct. 2. No DB injection / no leak (excluded from PEER_COLUMNS).
  > 3. Adding a field does not break boot_id matching. **Verdict: SHIP.**
  Both non-blocking items fixed in-loop (af5d885): port range widened to
  20000–39999; untrusted-assertion note added to the `mySessionId` comment.
- **Box 10 — N/A.** Repo has no CHANGELOG/semver-bump convention; changelog =
  conventional-commit headings + PR number, which this PR carries.
- **Box 11★ — DONE.** This ledger + per-row pointers.

**Verbatim probe — full suite (post-remediation):**
```
$ bun test
 264 pass
 0 fail
 813 expect() calls
Ran 264 tests across 27 files. [7.98s]
```

**Verbatim probe — board-49 e2e RED→GREEN:**
```
# RED (before impl, at 87fea65):
Expected: "board49-canonical-2f7c9a10-uuid"  Received: ""   (fail ×2)
 1 pass  2 fail
# GREEN (after impl):
 3 pass  0 fail
```

**Verdict: build is DONE. Contract closed.**

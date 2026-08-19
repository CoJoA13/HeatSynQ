# Task 1 report — #111: single-flight the practice reset, delete the pinned transaction

Implementer report, Round 2 Group F, branch `group-f-infra`. Candidate (a) from the recon
(`gf-r111.md`), join semantics, as ratified by the brief.

## What changed

| File | Change |
| --- | --- |
| `erp/src/lib/single-flight.ts` (new, 22 lines) | The pure leaf: `singleFlight<T>(fn)` returns a wrapper holding one module-scoped in-flight slot. A call during a flight returns the SAME promise (fn not re-invoked); the slot clears via `.finally` on settlement — rejection included — so a failed run never wedges the wrapper. Zero imports (the `drain-queue.ts` leaf shape). Documented edge: a synchronous throw from `fn` propagates synchronously and leaves the slot clear. |
| `erp/tests/single-flight.test.ts` (new, 4 tests) | Hand-held deferreds; each fn invocation returns a DISTINCT deferred's promise so promise identity distinguishes a join from a re-invocation. Tests: join (same promise, fn once); resolution clears (later call runs fresh); rejection clears (retry runs fresh and can succeed); joined caller sees the same rejection (identity asserted BEFORE rejecting, so a non-joining implementation fails fast instead of timing out). |
| `erp/src/server/practice-reset.ts:34–65` | Deleted the `$transaction` + `pg_advisory_xact_lock(88018802)` + both 120s knobs. `resetPracticeData` is now: `assertPracticeDatabase(prisma)` first (unchanged, un-memoized, runs for EVERY caller — joiners included), then `return resetFlight()` where `resetFlight = singleFlight(resetPracticeDataUnguarded)` at module scope (:54). Net diff on this file: −7 lines of mechanism, the comment replaced. `resetPracticeDataUnguarded`, `truncateAllTables`, and the route are untouched. |

No route change, no schema change, no client change (`PracticeResetControl` needs none — the
joined click still resolves ok and redirects to /login).

## RED (watched, exact failure text)

The leaf was first written as a stub with today's no-single-flight behavior
(`return () => fn();` — every call invokes fn afresh), and the test file run against it:

| Test | RED result |
| --- | --- |
| a call issued WHILE one is in flight JOINS it: same promise, fn invoked once | **FAIL** — `AssertionError: expected [ { promise: Promise{…}, …(2) }, …(1) ] to have a length of 1 but got 2` (fn invoked twice — the exact no-single-flight behavior the brief predicted) |
| a JOINED caller sees the same rejection as the flight it joined | **FAIL** — `AssertionError: expected Promise{…} to be Promise{…} // Object.is equality` (two distinct promises — no join). Failed fast at the identity assertion, no timeout, by construction. |
| resolution clears the slot: a call AFTER completion runs fresh | pass (trivially true when every call is fresh — expected under the stub) |
| REJECTION clears the slot: a failed run must not wedge later calls | pass (same — trivially true under the stub) |

`Test Files 1 failed (1) — Tests 2 failed | 2 passed (4)`. Then the real implementation replaced
the stub: all 4 pass.

## Gates (from erp/, run after the implementation)

| Gate | Result |
| --- | --- |
| `npx vitest run tests/single-flight.test.ts tests/practice-reset.test.ts` | **PASS** — `Test Files 2 passed (2), Tests 8 passed (8)` (4 leaf + the 4 existing practice-reset tests, incl. both 403 route tests and the guarded-entry 403; no DB contention encountered, single run) |
| `npx tsc --noEmit` | **PASS** — exit 0 |
| `npx eslint src tests` | **PASS** — exit 0 |

Note: tsc/eslint ran over the whole tree, which at that moment also contained the other three
implementers' in-progress edits (ci.yml, README, setup.ts, partial-unique-sweep,
pg-forward-hazard) — exit 0 regardless, so mine introduce nothing red either way.

## Comment claims — verified against the repo before writing them

The rewritten comment (practice-reset.ts:34–53) names both Codex rounds and makes factual claims;
each was re-verified, not copied on faith:

- **One container, host-port bind**: `erp/docker-compose.yml:46–49` — `app-practice` with
  `ports: ["8080:3000"]`. A second replica cannot bind the host port.
- **One Node process, no cluster**: `erp/Dockerfile:48` —
  `CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]`; grep for cluster/pm2 across
  Dockerfile + compose: nothing.
- **Pool default is pg-pool's fixed 10, not `num_cpus*2+1`**: `node_modules/pg-pool/index.js:89`
  — `this.options.max = this.options.max || this.options.poolSize || 10`. The issue's pool-size
  framing is corrected in the comment itself (:40–41), per the brief's "comment or report" —
  it's in both.
- **No stale references to the deleted lock**: grep `88018802` across erp/src, erp/tests,
  erp/prisma, docs — only the Group F brief's own task description remains.
- **The Phase 8B "design-sanctioned self-healing" citation**: the squash message of `6f173e5`
  (per the recon's verbatim quote) — the pre-round-2 stance the residual reverts to.

## Docs check

- **CLAUDE.md Phase 8B paragraph**: describes the reset as "truncate → singletons FIRST →
  `seedDemoSlice`, deliberately non-atomic behind the db-identity pre-check" — it never described
  the advisory lock, so it stays accurate verbatim. No change made (the brief predicted "likely
  not").
- The pool-size correction the brief asked for lives in the comment and this report (above).

## Reviewer-attention notes

1. **Join vs. the old behavior is a real (accepted) delta**: previously a second click blocked up
   to 120s then ran a SECOND full truncate+seed; now it joins the running one and no second
   truncate happens. The observable contract ("my click ended with a fresh baseline") is
   identical, and the brief ratified join explicitly.
2. **The single-flight wraps `resetPracticeDataUnguarded`, not `resetPracticeData`** — so the
   un-memoized `assertPracticeDatabase` runs per caller BEFORE joining (a joiner still gets its
   own 403 on a non-practice DB), and CI's direct `resetPracticeDataUnguarded()` calls in
   `tests/practice-reset.test.ts` bypass the flight (intentional — that's the unguarded internal,
   and those tests run sequentially anyway).
3. **The serialization is still unreachable from erp_test through the guarded entry** (the
   guard-split: `assertPracticeDatabase` 403s first) — exactly as before the fix; that's why the
   TDD seam is the extracted leaf. The wiring is one line (`return resetFlight()`), covered by the
   existing 403 tests for the guard ordering.
4. **`singleFlight` returns the `.finally`-chained promise**, not `fn()`'s own — promise identity
   in the tests is against the chained one, which is what both callers actually receive; rejection
   passes through `.finally` unchanged (pinned by the joined-rejection test asserting `toBe(boom)`
   on the original Error instance).
5. E2E is deferred to group close-out per the brief (no flow can exercise the practice reset
   against the dev DB — structurally impossible; the standing run is a regression backstop).

# Task 5 report — `close-periods.ts` (close/reopen lifecycle + preliminary report + routes)

**Status:** implementation complete, all gates green. Not yet reviewed.
**Code commit:** `e1fda3d` — feat(5c): month-end close/reopen lifecycle, aging reconciliation, preliminary report + routes.

## What landed

- **`erp/src/server/close-periods.ts`** — `preliminaryReport(year, month)`, `closePeriod(year, month)`, `reopenPeriod(id, reason)`, plus the private `computeSchedule` (continuity roll-forward + the independent aging cross-check in integer cents) and `priorEndingAr` (beginning-A/R chaining / genesis / skipped-month refusal).
- **Routes** — `close/preliminary/route.ts` (GET, `receivables.view`, `?year=&month=`), `close/route.ts` (POST, `receivables.edit` + `close_ar_period`, body `{year, month}`), `close/[id]/reopen/route.ts` (POST, `receivables.edit` + `close_ar_period`, body `{reason}`, id from `ctx.params`). Thin: authorize → parse (`.strict()`) → delegate.
- **Tests** — `close-periods.test.ts` extended with the lifecycle suite + two RED-verified concurrency tests; `receivables-routes.test.ts` extended with the 401/403/200 ladder for all three routes, including a `close_ar_period`-missing 403.

Task-4 invariant honored: `closePeriod` takes **exactly one** `lockMonth(tx, year, month)`, at the top of its transaction. Every mutation runs through `auditedCreate`/`auditedUpdate`; the reopen reason is passed to `auditedUpdate` (recorded in the audit entry) as well as stored on the row. The accepted cross-connection `agingReport()` read (its own RepeatableRead txn, no `tx`) is kept with the plan's documented note.

## Gates

- **Full suite:** `npx vitest run` — **1910 passed / 123 files, 0 failures.**
- **`npx tsc --noEmit`** — clean. **`npx eslint src tests`** — clean.
- **E2E (foreground, `npm run test:e2e`, DEV db `erp`):** **all 17 flows PASS**, no regression (this task is additive server code + new routes with no UI yet; run per the standing rule).
- close-periods.test.ts (9) + receivables-routes.test.ts (22) green; GREEN re-run 3× with no flakiness.

## RED evidence (both concurrency tests — spec §12)

Both were RED-verified by commenting out `await lockMonth(tx, year, month)` in `closePeriod` and running `-t "concurrency"`; restored → GREEN. Each competing side runs at **Read Committed** so SSI is off the table and the advisory lock is the only possible serializer (the 5B `applications-concurrency` technique).

**Test 1 — a finalize racing a close.** HOLDER (Read Committed) hand-scripts the finalize's critical section (`pg_advisory_xact_lock(4200, 202607)` + write the finalized July invoice, held uncommitted); COMPETITOR is the real `closePeriod(2026, 7)`. GREEN: the close blocks on the held month, then on a fresh post-lock read counts the now-committed invoice (`endingAr` 100). RED transcript:

```
× a finalize racing a close serializes ...
  → expected 'settled' to be Symbol(timed out)
AssertionError: expected 'settled' to be Symbol(timed out)
- Expected: Symbol(timed out)   + Received: "settled"
```

Without the lock the close does not block — it reads past the uncommitted invoice (`endingAr` 0), commits a CLOSED July, and the invoice lands in that closed month uncounted; the block-detection race returns `"settled"`. (The apply/void postings §12 also names share the identical `assertPeriodOpen → lockMonth` guard, so this one finalize proof covers them.)

**Test 2 — a second close of one month.** HOLDER (Read Committed) hand-scripts the first close's critical section (advisory lock + insert the CLOSED July row, held uncommitted); COMPETITOR is the real `closePeriod(2026, 7)`. GREEN: the competitor blocks on the month, then on a fresh post-lock read sees the committed row and UPDATES it (one CLOSED row, no error). RED transcript:

```
× a second close of one month serializes behind the first ...
  → A close period with that value already exists
Error: A close period with that value already exists
 ❯ translatePrisma src/server/db-errors.ts:43:13   (P2002 on @@unique([year, month]))
```

Without the lock the competitor does not block, its `findFirst` misses the holder's uncommitted row, and its INSERT collides on the unique index → `await competitor` rejects. (A bare `Promise.all` of two closes left the collision to timing and passed spuriously in RED, so Test 2 uses the holder/competitor shape to force the window deterministically.)

## Two design decisions that DEPART from the brief's sample (flagged for the whole-branch review)

Both are evidence-backed corrections that make the brief internally consistent, not free choices.

### 1. `closePeriod`/`reopenPeriod` run at **Read Committed**, not Serializable

The brief's sample showed `{ isolationLevel: Serializable }`. That is incompatible with the brief's own concurrency acceptance, for a hard Postgres reason verified by probe **before** implementing: a Serializable (or RepeatableRead) transaction fixes its snapshot at its **first statement**; when that first statement is the **blocking** `lockMonth` SELECT, the snapshot is taken *before* the lock is granted, so every read after the lock is **stale** relative to whatever committed while we were blocked.

Probe of two concurrent closes doing `lockMonth → findFirst → create|update`:

```
PROBE SERIALIZABLE:   {"a":"A:OK","b":"B:ERR(P2034)","rows":1}
PROBE READCOMMITTED:  {"a":"A:OK","b":"B:OK","rows":1}
```

Under Serializable the second close unblocks stale, its `findFirst` misses the first's just-committed row, it re-inserts and takes a serialization failure (P2034 → 409) — it **errors**, breaking the brief's "*neither call errors / the second sees the first's row and updates it*". Under Read Committed each statement gets a fresh snapshot, so the post-lock reads see exactly the state the advisory lock has frozen for the month — both closes succeed with one row, and a close that blocked behind a finalize *counts* it instead of refusing on a spurious variance. The **advisory lock (not SSI) is the documented serializer** (period-locks.ts's own header, and the brief's reconciliation note, both cite the lock — never Serializable), so Read Committed is both correct and the only isolation meeting the acceptance. `preliminaryReport` keeps Serializable: it takes no lock, so it never blocks and never reads stale.

### 2. Prior-month rule = spec §4.1 (line 107) + ruling 5, not the brief's sample

The brief's sample `priorEndingAr` returned `$0` for **any** missing prior month (so it could never refuse), yet its "refuses to close a month before its prior month is closed" test closed August on an empty DB and expected a rejection — while its "closes a clean month" test closed July on an empty DB and expected success. Those two are structurally identical (one month of activity, no prior close) and cannot both hold under any principled rule.

The binding spec §4.1 resolves it: the close "*requires the prior month closed (or this is the first close) … Beginning A/R = the prior close's `endingAr`, else $0*" (ruling 5, chain-from-zero — no opening-balance entry). Implemented: a missing prior month is allowed **only** when nothing **strictly earlier** is closed (a genesis close, beginning `$0`); if an earlier month is already closed but the immediately-prior month is not, a month is being **skipped** → refuse. A REOPENED prior blocks too. Tests were rewritten to the spec: a first close of any month begins `$0` (genesis); a skipped-month refusal (close July, then close September leaving August open); and a variance refusal (a June residual vs a July genesis close — the roll-forward and aging disagree).

## Concerns / notes for the reviewer

- The two departures above are the substantive review items. Both are the interpretation that makes the brief self-consistent and are backed by the probes/transcripts above; neither amends the spec contract (§4.1 already states the prior-month rule; the isolation is an implementation detail below the contract), so no spec §15 amendment was made.
- `closePeriod`'s Read Committed vs the posting side's Serializable is intentional and independent: the posting side (`finalizeInvoice` etc., Task 3/4) stays Serializable — its guard read sits *after* an earlier snapshot-fixing claim, so SSI is what backstops the stale-read window there; the close's own correctness needs only the advisory lock + fresh reads.
- Re-closing a REOPENED month updates the row in place (`reopenedAt: null`), leaving the historical `reopenReason` text — harmless, matches the brief's data shape; flag if the reviewer wants it cleared.
- Housekeeping: this docs commit also persists three earlier untracked execution records (`task-1-brief.md`, `task-2-report.md`, `task-3-report.md`) that the recurring `.superpowers/sdd/.gitignore`-clobber had left exposed — committing them closes that loss window per the house rule. The `.gitignore` clobber itself (a bare `*`) was left untouched.

---

## Fix round 1 — Critical (data-integrity): a posting could leak into a just-closed month

**Verdict addressed:** review found the Read-Committed close (design decision #1 above) STRIPS the SSI backstop from the Serializable posting side. A Serializable `finalizeInvoice` fixes its snapshot at `claimInvoiceRow` (BEFORE `assertPeriodOpen`'s advisory lock); if a close commits after that snapshot, the new CLOSED row is invisible to the finalize's fixed snapshot (plain `findFirst`, no `FOR UPDATE`), and SSI cannot abort a Read-Committed writer — so a FINALIZED invoice lands in a just-closed month. The original concurrency Test 1 only exercised the SAFE direction (a hand-scripted RC holder taking the lock first) and so missed it. **This supersedes design decision #1: the Read-Committed choice was wrong.**

### What changed (`e1fda3d` is the base; this is the fix commit on top)

- **`src/server/db-errors.ts`** — added `retryOnSerializationConflict(run, tries = 5)` (+ `isRetryableConflict`): re-runs `run` on a raw `P2034` / raw-40001 / `P2002`, then lets the last failure escape to `withDbErrors` for translation. It wraps the RAW `prisma.$transaction` (inside `withDbErrors`) so it sees the Prisma error before translation.
- **`src/server/close-periods.ts`** — restored `{ isolationLevel: Serializable }` on BOTH `closePeriod` and `reopenPeriod`, each now wrapped in `retryOnSerializationConflict`. `lockMonth` kept (it orders the closes). The file-header ISOLATION section was rewritten: two serializers are load-bearing now — the advisory lock ORDERS closes, and Serializable-on-both-sides lets SSI backstop the posting-vs-close phantom; the retry absorbs the loser of two concurrent closes. Minors: `reopenReason: ""` added to the close `data` (a re-closed month no longer carries a stale reopen note), and the variance refusal message now names the delta — `… (off by ${schedule.variance})`.
- **`tests/close-periods.test.ts`** — the safe-direction Test 1 was REPLACED with the DANGEROUS direction (under Serializable it could not have passed anyway: a close that blocks behind a finalize reads a stale roll-forward and refuses on a spurious variance — that behavior was deliberately given up to close the leak). Test 2 (two concurrent closes) now asserts exactly one CLOSED row and that NEITHER call errors (the retry absorbs the loser). New helper `makeDraftInvoiceDated`.

### Dangerous-direction Test 1 (the deliverable) and its RED evidence

The test drives the REAL Serializable `finalizeInvoice` against a REAL `closePeriod(2026, 7)`. Determinism: a Read-Committed GATE holds the invoice's ORDER row `FOR UPDATE`, so the finalize fixes its snapshot at its first read and then BLOCKS at `claimOrder` — paused AFTER its snapshot is fixed, BEFORE its period read. The close then runs to completion (CLOSED July, `endingAr` 0 — the invoice is still DRAFT), the gate releases, and the finalize proceeds on its now-stale snapshot. GREEN: the finalize is refused/aborted (409) and the invoice stays DRAFT; `closePeriod`'s frozen schedule stays $0.

RED-verified by reverting `closePeriod` to Read Committed (dropping its `isolationLevel`): the close is invisible to SSI, the finalize's stale read misses the CLOSED row, nothing aborts it, and it commits FINALIZED into closed July:

```
× DANGEROUS direction: a real Serializable finalize whose snapshot predates a committed close ...
  → expected 'resolved' not to be 'resolved' // Object.is equality
   tests/close-periods.test.ts:250  expect(outcome).not.toBe("resolved");
```

(`outcome === "resolved"` ⇒ the finalize committed FINALIZED — the leak.) Restored Serializable → GREEN.

### Test 2 (two concurrent closes) and its RED evidence

HOLDER (Read Committed) hand-scripts the winning close's critical section (advisory lock + insert the CLOSED July row, held uncommitted); COMPETITOR is the real `closePeriod` (Serializable + retry). The competitor blocks on the month, unblocks with a snapshot fixed before the holder committed, its `findFirst` misses the row, its INSERT collides — and the retry re-runs it onto a fresh snapshot that UPDATES the row. One CLOSED row, no error.

RED-verified by disabling the retry (`tries = 1`): the collision escapes as `P2002` → `HttpError(400)` and `await competitor` REJECTS:

```
× two concurrent closes of one month: exactly one CLOSED row, NEITHER errors ...
  → A close period with that value already exists
   translatePrisma src/server/db-errors.ts:43  (P2002 on @@unique([year, month]))
```

Restored `tries = 5` → GREEN.

### Gates (all green)

- `npx vitest run tests/close-periods.test.ts tests/receivables-routes.test.ts` — **31 passed** (GREEN re-run 3× with no flakiness in either concurrency test).
- Full `npm test` — **1910 passed / 123 files, 0 failures.** `npx tsc --noEmit` clean. `npx eslint src tests` — 0/0.
- **E2E foreground (`npm run test:e2e`, DEV db `erp`)** — **all 17 flows PASS.**

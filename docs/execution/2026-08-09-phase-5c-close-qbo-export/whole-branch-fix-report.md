# Phase 5C — whole-branch review fix wave

**Date:** 2026-08-10
**Branch:** `phase-5c-close-qbo-export`
**Scope:** two owner rulings (§3 rulings 8 & 9) + two Important cross-task findings + two clear fixes
from the two-lens whole-branch review. No schema change, no migration.

## What landed

### Change A — invoice recognition basis = `finalizedAt` (ruling 8)

The defect (empirically confirmed by the review, variance = 100): the close roll-forward scoped
finalized invoices/credits by `invoiceDate`, but the aging it reconciles against includes an invoice
by `finalizedAt`. A July-dated / August-finalized invoice (the ordinary month-end pattern) was counted
in July's roll-forward but not July's aging *and* not August's roll-forward but yes August's aging — so
**both months failed to reconcile and were unclosable**, defeating the headline deliverable. It failed
safe (a refuse, never a wrong close) and was masked because every test set `finalizedAt == invoiceDate`.

Fixed by making all three period-scoped mechanisms recognize an invoice by `finalizedAt`:

1. **`close-periods.ts` `computeRollForward`** (formerly the invoice half of `computeSchedule`): finalized
   invoices/credits scoped by `finalizedAt ∈ [monthStart, nextMonthStart)`. Payments stay `receivedDate`,
   applications stay `appliedDate` (both `@db.Date`, `[start, end]` inclusive) — unchanged.
2. **`gl-export.ts` `buildCurrentJournal` and `resolveReadiness`**: finalized invoices/credits scoped by
   `finalizedAt ∈ [monthStart, nextStart)`. The JE date stamped on postings stays `periodEnd`; the
   `GlPosting` `glDate` prior-scope stays `[monthStart, monthEnd]` (all postings are stamped `periodEnd`).
3. **`invoices.ts` period-lock wiring:**
   - `finalizeInvoiceInTx`: `assertPeriodOpen(tx, invoice.invoiceDate)` → `assertPeriodOpen(tx, todayDateOnly())`
     — an invoice is recognized when finalized (≈ now); a July-dated invoice finalized today in August lands
     in August and must be allowed even if July is closed.
   - `unlockInvoiceInTx`: → `assertPeriodOpen(tx, invoice.finalizedAt!)` (FINALIZED ⟹ `finalizedAt` set).
     Unlock removes the invoice from its finalize-month; guarding `invoiceDate` would let unlocking a
     July-dated / Aug-finalized invoice silently change August's frozen figures while only checking July
     — the exact leak Task 5 fixed.
   - `createCredit`: kept its guard on `creditDate` (= `todayDateOnly()`), comment updated — a DRAFT credit
     posts nothing and touches no A/R until it is finalized through the same `finalizeInvoiceInTx` path
     (whose finalize-date guard is the real recognition guard); this create-time guard is the consistent
     current-month guard finalize also uses.

**The half-open interval matters:** `finalizedAt` is a plain `DateTime` (time-of-day), unlike the
`@db.Date` document dates. The aging compares `finalizedAt` by its *date part* (`formatDateOnly` →
`parseDateOnly`), so `date(finalizedAt) ∈ [monthStart, monthEnd]` ⟺ `finalizedAt ∈ [monthStart,
nextMonthStart)`. An inclusive `lte: monthEnd`-at-UTC-midnight would drop any invoice finalized after
00:00 on the last day of the month — a real bug the interval avoids and the reconciliation depends on.

### Change B — summary export (ruling 9)

`renderCsv` and the posting register previously emitted one row per event-line. `exportClose` now
computes `summaryLines = aggregateLines(lines)` — one line per `(account, side)`, debits and credits
summed in integer cents, first-occurrence order preserved so SALES precedes CASH — and hands the
**summary** to both `renderCsv` and the register. The per-event `GlPosting` rows are written from the
un-aggregated `lines` (the ERP-side detail + delta driver). Aggregation preserves Σdebit = Σcredit, so
the balance backstop (still on the per-event `lines`) still guarantees the summary balances.

### Change C — pool-starvation

`computeSchedule` called `agingReport()` (which opens its own `prisma.$transaction`, a second pooled
connection) *inside* the outer Serializable transaction of `preliminaryReport`/`closePeriod` — a
connection-held-while-acquiring-a-second antipattern → P2024 under concurrent close-screen load. Now the
aging is read **outside** the transaction (`agingEndingArAt`, on its own connection, released before the
roll-forward transaction opens); for `closePeriod` it is read inside the `retryOnSerializationConflict`
callback so a re-run re-reads it fresh. Correctness holds: an interleaved posting can only make the two
independent derivations *disagree* (a safe variance 409 the operator re-runs), never falsely reconcile,
and once the CLOSED row lands `assertPeriodOpen` freezes the month. `computeSchedule` was split into
`computeRollForward` (the tx) + `agingEndingArAt` (its own read) + `scheduleFrom` (assemble + variance).

### Change D — `emittedById`

`exportClose` now sets `GlExportBatch.emittedById: currentActor().id`, mirroring `closePeriod`'s
`closedById`.

### Not touched (filed as issues by the reviewer)

The non-latest-reopen continuity-chain stale figures; the freight/charge frozen-null readiness-vs-500
edge; and the ~10 cosmetic Minors.

## RED verification evidence

**Regression test (Change A, the empirically-confirmed defect).** New test
`close-periods.test.ts › "recognizes an invoice by finalizedAt, not invoiceDate (ruling 8 month-end
straddle reconciles both months)"`: an invoice with `invoiceDate = 2026-07-31` and `finalizedAt =
2026-08-02` → `closePeriod(2026, 7)` reconciles (invoicedTotal 0, endingAr 0, variance 0) and
`closePeriod(2026, 8)` counts it (invoicedTotal 100, endingAr 100, variance 0).

Temporarily reverting `computeRollForward`'s scope to the old `invoiceDate: { gte: start, lte: end }`
makes the regression FAIL exactly as the defect predicts:

```
× recognizes an invoice by finalizedAt, not invoiceDate (ruling 8 month-end straddle reconciles both months)
  → The close does not reconcile — ending A/R 100 vs aging 0 (off by 100)
```

(July counts the invoice by `invoiceDate` → endingAr 100, but the aging at 2026-07-31 excludes it by
`finalizedAt` → aging 0 → variance 100 → the close is refused. Restored to `finalizedAt` → green.)

**Dangerous-direction concurrency test (re-verified under the new basis).** The finalize now guards
`todayDateOnly()`, so the SSI edge (finalize's `assertPeriodOpen` predicate read ↔ close's CLOSED-row
insert) forms only when the close closes *today's* month — the test was updated to close the current
month accordingly. Temporarily dropping `closePeriod`'s Serializable isolation still leaks:

```
× DANGEROUS direction: ... no FINALIZED invoice leaks into the closed month
  → expected 'resolved' not to be 'resolved'
```

(Under a Read-Committed close the finalize's stale snapshot misses the CLOSED row, nothing aborts it, and
it commits FINALIZED into the just-closed month. Restored to Serializable → green.) The two-concurrent-
closes test is unaffected (no recognition-basis dependence) and stays green.

## Gate results

| Gate | Result |
|---|---|
| `npm test` (vitest, real `erp_test` DB) | **1941 passed** (125 files) — incl. the new regression, the two gl-export summary/emittedById tests, and both re-verified concurrency tests |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean (exit 0) |
| `npm run build` | ✓ Compiled successfully |
| `npm run test:e2e` (foreground, dev DB) | **18/18** — `close-month-end` exercises the finalize basis + summary file + reversing delta |

## Concerns / notes

- **`invoice.finalizedAt!` non-null assertion** in `unlockInvoiceInTx` is locally proven (the line runs
  only after the `status !== "FINALIZED"` refusal, and `finalizedAt` is stamped at finalize) and matches
  the codebase's existing `!` usage (`wireComputedParents`). eslint accepts it.
- **`aggregateLines` does not net debit against credit within an `(account, side)` group** — per ruling 9's
  "sum debit and credit," a group carrying both (e.g. SALES-side A/R when a month has both invoices and
  credits) renders both a debit and a credit sum on its one row. The batch still balances; this is the
  literal reading of the ruling and the simplest correct choice.
- The aging read moving outside the transaction slightly widens the window in which a concurrent posting
  can cause a *spurious* variance 409 (operator re-runs) under heavy concurrency — an accepted, fail-safe
  trade for closing the P2024 pool-starvation antipattern. It can never cause a false reconcile.

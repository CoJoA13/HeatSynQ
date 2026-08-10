# Task 6 report — `gl-export.ts` per-event delta, CSV, readiness refusal + routes

**Status:** COMPLETE. All gates green.

**Commit:** `6158c20` — `feat(5c): GL-export delta engine (idempotent, reversal-safe), CSV, readiness refusal + routes`

## What landed

- **`erp/src/server/gl-export.ts`** — the per-event GL-export delta engine and its readers.
  - `exportClose(closePeriodId)` — Serializable `$transaction` inside `withDbErrors`. Refuses a
    non-`CLOSED` period (409) and refuses on any readiness gap (409). Derives `periodEnd = Date.UTC(year,
    month, 0)`, builds the current in-scope journal and the net prior postings, diffs them, allocates
    `gl_export_batch_number_next` under the tx, and writes the `GlExportBatch` + one `GlPosting` per
    emitted line through `auditedCreate("glExportBatch", …)`. Register is `new Uint8Array()`
    (placeholder — Task 7 renders the real posting-register PDF and replaces it).
  - `buildCurrentJournal(tx, E)` — finalized invoices/credits (`invoiceDate ≤ E`) → `salesJournal`
    (revenue grouped by the invoice line's snapshot `glAccountId`, TAX lines excluded, A/R + tax GL from
    the plant config); posted non-void payments (`receivedDate ≤ E`) → one `cashJournal` PAYMENT each;
    live DISCOUNT/WRITE_OFF applications (`appliedDate ≤ E`) → one `cashJournal` each. Amounts are
    **magnitudes** — the `kind` + mapper `reverse` flag decides direction, never the stored money sign
    (so a CREDIT posts a proper positive-valued mirror). Keyed on the 2-part `${sourceType}:${sourceId}`.
  - `buildPriorNet(tx, E)` — `GlPosting` with `glDate ≤ E`, grouped by the SAME 2-part key, netted per
    `(glAccountId, side, memo)`; **net-zero groups dropped** so `.has(key)` means "has a live prior
    posting". NEW = live keys not in prior → post; REVERSED = prior keys not live → `reverseLines`.
  - `resolveReadiness(tx, E)` → `ReadinessInput` → `readinessGaps`: `hasTax` iff any in-scope finalized
    invoice has `taxTotal ≠ 0`; `salesTax/discount/writeOff/ar` from `BillingConfig`; step-code /
    surcharge lists from in-scope invoice lines whose snapshot `glAccountId` is null (attributed to the
    step code / surcharge for the fix link); payment-type list from in-scope posted payments whose type
    has no GL account. `readinessForExport(E)` wraps it in its own Serializable tx (the SAME `E` the
    refusal uses, so the UI panel and the refusal never disagree).
  - `getExportBatchFile` / `getExportBatchRegister` — stored bytes + content type, 404 if missing.
- **Routes** (all thin, gated): `close/[id]/export` (POST, `run_qbo_export` on top of `receivables.edit`);
  `close/export/[batchId]/file` (GET, `receivables.view`, streams `text/csv`); `close/readiness` (GET,
  `receivables.view`, period-scoped `?year=&month=`, JSON gap list); `close/readiness/export` (GET,
  `receivables.view`, same scope, `toXlsx` → xlsx). `readiness/period.ts` holds the shared `?year=&month=`
  → month-end parse (400 on missing/invalid).

## Delta correctness

The keying is the crux and it holds: each event maps to a self-balancing line set under one 2-part key,
so the delta reverses one event without touching another, and both sides are bounded by `glDate ≤ E`.
A finalized invoice / posted payment / live application is immutable while in scope (an amount change
requires unlock/void, which drops it out of scope → reversal + fresh post), so an event present in BOTH
maps genuinely needs no change — which is what makes a re-run an empty no-op.

## Tests

- **`tests/gl-export.test.ts` (7)** — first export balanced + non-reversal; re-run empty no-op
  (idempotent); payment cash event balanced alongside the sale; reopen→unlock→re-close→re-export emits a
  **balanced all-reversal delta** and a further re-run is empty; **earlier-month-after-later**: re-export
  July after August closed reverses only July (all `glDate ≤ 2026-07-31`), August's stored postings
  untouched and its re-export empty; readiness **refuses** a taxable-invoice-without-sales-tax-account and
  an unset-A/R-account (both proven end-to-end through `exportClose`); clean-when-configured.
- **`tests/receivables-routes.test.ts` (extended, +6)** — 401/403/200 ladders for all four routes;
  export 403 without `run_qbo_export`; balanced-batch body assert; file route asserts `text/csv` + 404
  on unknown batch; readiness JSON names the A/R gap + 400 on missing month; readiness export asserts the
  xlsx MIME.

## Gate results

- `npx vitest run tests/gl-export.test.ts tests/receivables-routes.test.ts` → 35 passed.
- **Full `npm test`** → 124 files, **1923 passed**.
- `npx tsc --noEmit` → clean. `npx eslint src tests` → clean.
- **`npm run test:e2e` (foreground)** → **all 17 flows PASS** (exit 0).

## Notes / follow-ups

- The register is a deliberate `new Uint8Array()` placeholder; **Task 7** renders the posting-register PDF
  and replaces it, and adds `getExportBatchRegister`'s route.
- Per the brief's core shape, an empty (no-change) export still writes a zero-posting `GlExportBatch` and
  consumes an export number; the delta is a true no-op (no `GlPosting` rows), so idempotency is unaffected.
  If churn-free no-ops are wanted, that is a small follow-up (skip the write when `lines` is empty), not a
  correctness issue.
- Concurrency: two concurrent exports of one period cannot double-post — the `allocateNumber` row lock
  plus Serializable SSI (the prior-posting range read vs the new-posting inserts) abort the loser (409),
  matching the 5A/5B print-bracket shape; no extra advisory lock or retry was added (none in the brief).

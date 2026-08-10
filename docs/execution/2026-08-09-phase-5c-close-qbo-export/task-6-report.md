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

---

## Fix round 1 — two-lens review defects (2026-08-09)

**Commit:** `<pending>` — `fix(5c): gl-export readiness covers all account-bearing lines + balance backstop; strictly-per-period delta`

Three defects the two-lens review found (the original tests missed them because the factory only built
OPERATION lines). All three fixed; nothing in the idempotency/reversal design changed.

### CRITICAL — unbalanced batch from account-less FREIGHT/CHARGE/CERT lines
`resolveReadiness`'s bad-line scan only flagged null-GL lines carrying a `processStepCodeId`/`surchargeId`,
so a null-GL **FREIGHT** (`freightGlAccountId`), **CHARGE** (`otherChargeGlAccountId`), or **CERT** (cert
step code GL) line produced no gap; `buildCurrentJournal` then silently `continue`d past it (dropping its
credit) while `salesJournal` still debited A/R the full `inv.total` → an **unbalanced** `GlExportBatch`
was persisted. Fixed in three layers:
1. **Readiness broadened** (`gl-export.ts` `resolveReadiness` + `gl-mapping.ts` `ReadinessInput`/
   `readinessGaps`): the scan now flags **every** non-`TAX` in-scope line with `glAccountId = null` and a
   nonzero amount, attributed OPERATION→step code, SURCHARGE→surcharge, CERT→config cert step code
   (or a "cert step code not set" plant default), FREIGHT→`freightGlAccountId`, CHARGE→
   `otherChargeGlAccountId`, plus a generic `hasUnattributedLine` safety net for an orphaned line.
2. **Loud-fail:** `buildCurrentJournal` no longer silently drops a null-GL non-`TAX` **nonzero** line — it
   throws (a `$0` PART header still `continue`s).
3. **Balance backstop:** immediately before writing, `exportClose` sums Σdebit/Σcredit in integer cents
   and **throws** on any difference, so an unbalanced batch can never persist.

### IMPORTANT — out-of-order cross-period double-post
Postings are stamped `glDate = periodEnd`, but the delta was scoped cumulatively (`≤ E`). Exporting a
later month first vacuumed an earlier month's events under the later `glDate`; the earlier month's export
then saw them absent from its prior and re-posted them → double-booked. **Fixed:** both `buildCurrentJournal`
(event dates) and `buildPriorNet` (glDate) — and `resolveReadiness` — are now bounded **strictly** to the
period's own month `[monthStart, monthEnd]` (`monthStart = Date.UTC(y, m-1, 1)`, `monthEnd = periodEnd`),
sound because the period lock freezes a closed month's events. New postings stay stamped `glDate = periodEnd`.

### MINOR — missing-year validation
`readiness/period.ts` range-checked month but not year presence: `Number(null)`/`Number('')` = `0` passed
`Number.isInteger`, yielding `Date.UTC(0, m, 0)` = year 1900. Added `year >= 2000`; an absent/blank year
now 400s.

### How each new test fails without its fix (verified by temporary reverts)
- **`gl-export.test.ts` "refuses export when an in-scope CHARGE line has no GL account"** — with the
  readiness broadening reverted (the old `OR: [processStepCodeId, surchargeId]` restriction restored), the
  `/charge/i` gap assertion fails (`expected false to be true`): the CHARGE line is no longer flagged.
  A companion demo (readiness **and** the `buildCurrentJournal` loud-fail **and** the backstop all disabled)
  confirmed `exportClose` then *resolves* and persists an **unbalanced** batch (debit 5000¢, credit 0¢) —
  the concrete Critical repro; any one of the three layers stops it.
- **`gl-export.test.ts` "exporting a later month FIRST does not vacuum or double-post…"** — with the
  cumulative `≤ E` scope restored, August's batch vacuums July's invoice (`expect(...some(july)).toBe(false)`
  fails, `expected true to be false`).
- **`receivables-routes.test.ts` "400s a missing year"** — with the `year >= 2000` guard removed, the route
  returns **200** instead of 400 (`Number(null)=0` → 1900 slips through).

### Gate results (fix round 1)
- `npx vitest run tests/gl-export.test.ts tests/gl-mapping.test.ts tests/receivables-routes.test.ts` →
  **49 passed** (incl. the new account-less-CHARGE/FREIGHT, configured-balances, per-period-ordering,
  freight/charge/cert readiness-mapping, and missing-year tests).
- **Full `npm test`** → 124 files, **1931 passed**.
- `npx tsc --noEmit` → clean (exit 0). `npx eslint src tests` → clean (0/0, exit 0).
- **`npm run test:e2e` (foreground)** → **all 17 flows PASS**.

### Files touched
- `src/server/gl-export.ts` — month-bounds helpers; strictly-per-period scope on
  `buildCurrentJournal`/`buildPriorNet`/`resolveReadiness`; broadened bad-line scan + cert-step resolution;
  `buildCurrentJournal` loud-fail; `exportClose` balance backstop; header/doc comments updated.
- `src/server/gl-mapping.ts` — `ReadinessInput` + `readinessGaps` extended with freight/charge/cert plant
  defaults and the generic safety-net gap.
- `src/app/api/receivables/close/readiness/period.ts` — `year >= 2000` guard.
- `tests/gl-export.test.ts`, `tests/gl-mapping.test.ts`, `tests/receivables-routes.test.ts` — new tests +
  the "earlier-month-untouched" comment updated to the per-period window.

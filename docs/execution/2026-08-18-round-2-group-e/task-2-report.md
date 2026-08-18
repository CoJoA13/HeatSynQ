# Task 2 — #73 + #80: the receipts guards · implementer report

**Commit:** `685417a` on `group-e-close-gl`. **No schema migration** — both guards are
service-level refusals plus one UI attribute, as the brief requires.

## What was built

### #73 — future received date refused (`erp/src/server/receipts.ts`)

Guard in `addPaymentInTx`, immediately after `parseDate` — the column's SOLE writer (the brief's
recon: no `updatePayment` exists; `voidPayment` only stamps `deletedAt`), so one guard covers
every path a `receivedDate` can enter by. One clock sample (`todayDateOnly()`, the
`createCredit`/invoices.ts precedent), compared via `.getTime()`:

> `400 "The received date must be on or before today — payments are entered after the deposit is
> in hand"`

`todayDateOnly` joins the existing `parseDateOnly, formatDateOnly` import from
`src/lib/business-days`. Today and yesterday stay legal — the boundary is on-or-before, pinned in
both directions.

### #73 UI — `erp/src/app/receivables/batches/[id]/BatchDetail.tsx`

The bare `<input type="date">` for the payment received date now carries
`max={formatDateOnly(todayDateOnly())}` (client-safe — `business-days` lives in `src/lib`). One
attribute plus the import; the server guard remains the authority.

### #80 — un-footed batch post refused (`erp/src/server/receipts.ts`)

- `claimBatch`'s select widened with `controlTotal: true`, threaded through `claimLiveBatch`'s
  return type (`Prisma.Decimal | null`) — the figure is read off the claimed row.
- In `postBatchInTx`, after the "already posted" check and BEFORE `assertBatchMonthsOpen`: when
  `controlTotal !== null`, the live payment sum (`deletedAt: null`) is taken in integer cents with
  the file's own `cents()` helper (the same arithmetic `toBatchDetail` uses) and compared under
  the batch claim — `addPayment`/`voidPayment` claim the same row, so the sum cannot move
  mid-check. On mismatch:

  > `400 "This batch does not balance — control total X.XX, payments entered Y.YY (difference
  > Z.ZZ). Enter the missing payments, or void this batch and re-key it with the correct control
  > total."`

  Difference pinned as the **absolute value** (the brief's recommended choice) — over vs under is
  readable from the two figures beside it; the tests pin the exact string in the under case and
  the figure triple in the over/voided/empty cases. The second sentence names the way out
  (§5.14): `controlTotal` is immutable (createBatch is its only writer; the batch header has no
  edit path).
- Null `controlTotal` posts freely (balance is defined 0 — the file header's rule), pinned.

## RED table (every failure watched before implementing)

| Test | RED reason observed |
|---|---|
| #73 tomorrow → 400 exact message | **Promise resolved instead of rejecting** — the payment was created with `receivedDate: 2026-08-19` (tomorrow) |
| #73 today → OK | Green pre-implementation (the stays-legal direction, expected) |
| #73 yesterday → OK | Green pre-implementation (expected) |
| #80 under-entered (500 control / 300 entered) refused | **Promise resolved** — batch posted to `POSTED` |
| #80 over-entered (100 control / 300 entered) refused | **Promise resolved** — batch posted to `POSTED` |
| #80 footed posts | Green pre-implementation (expected — existing behavior) |
| #80 null control total posts | Green pre-implementation (expected) |
| #80 footed-then-voided (300 control, 100 voided) refused | **Promise resolved** — batch posted to `POSTED` |
| #80 empty batch, 500.00 control refused | **Promise resolved** — batch posted to `POSTED` with `enteredTotal: 0` |

All four #80 refusal cases failed as "resolved instead of rejecting" with the returned detail
showing `status: "POSTED"` — the exact hole Q18 closes.

## Fixture adjustments

**None.** Verified per the brief's instruction:

- `receipts.test.ts` postBatch describe (202–230): control 100.00, payment 100 — foots, green.
- The voidBatch/reopenBatch/listBatches posts all use `openBatch()`/`createBatch` with **null**
  control totals — post freely, green. (The reopen-then-void and audit-the-post tests post EMPTY
  null-control batches — legal by design, null defines balance 0.)
- `receivables-routes.test.ts` posts at :99, :150, :164, :193 all come from `createdBatch(cookie)`
  with its `controlTotal: null` default — green. The two `createdBatch(creator, 500)` fixtures
  (:237, :271) are addPayment/voidPayment ladders that never post.
- `period-locks.test.ts` multi-month postBatch fixture: `controlTotal: null` — green.
- `close-periods.test.ts` / `gl-export.test.ts` / `customer-receivables.test.ts` create POSTED
  batches raw via `prisma.receiptBatch.create` — they never pass through `postBatch`, untouched.
- `prisma/demo-seed.ts` (282–287): control 2500.00, one 2500.00 payment, `receivedDate: today` —
  foots and today is legal; `demo-seed.test.ts` green unchanged.
- E2E flows (checked statically; the group-end E2E run will exercise them):
  `receivables-apply-age-statement.mjs` and `close-month-end.mjs` both fill Received date with
  UTC-today (legal under #73) and neither sets a control total (null posts freely under #80).

**No route-level test added**, deliberately: `receivables-routes.test.ts`'s convention is
401/403/200 permission ladders plus payload-shape 400s — service guards (the POSTED refusal, the
closed-month 409) live in `receipts.test.ts`, and these two joined them there.

## Gate results

| Gate | Result |
|---|---|
| `npx vitest run tests/receipts.test.ts tests/receivables-routes.test.ts tests/customer-receivables.test.ts tests/close-periods.test.ts` | **100 passed** (4 files) |
| `npx vitest run tests/period-locks.test.ts tests/gl-export.test.ts tests/demo-seed.test.ts` | **31 passed** (3 files) |
| `npx vitest run tests/allocation-retry.test.ts` (the only other importer of `@/server/receipts`) | **5 passed** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |

E2E owed at group end per the brief's sequencing (UI touched: BatchDetail's date input).

## Reviewer-attention items

1. **The #80 sum is a second read of the same rows `assertBatchMonthsOpen` reads** (both
   `tx.payment.findMany({ where: { batchId, deletedAt: null } })`, different selects). Left as two
   reads deliberately: merging them would entangle the foot check with the month guard's
   dedup/sort logic for a micro-saving on a 1–5-user system, and both run under the same batch
   claim so they cannot disagree.
2. **#73 compares date-only values** — `parseDate` and `todayDateOnly` both produce UTC-midnight
   dates, so `.getTime()` equality at "today" is exact, no timezone skew. A payment keyed at
   23:59 local on the deposit's own day is legal everywhere west of UTC because "today" is UTC
   today; the owner's Q16 answer is about *future* dates, and UTC-today is never in the operator's
   future.
3. **The empty-batch-with-control refusal (0.00 entered)** means an operator who keys a control
   total and no payments can no longer post an empty batch — previously legal. This is the
   brief's explicit test case, and the message's way-out sentence covers it (void and re-key, or
   enter the payments).
4. The over/voided/empty message assertions use `stringContaining` on the figure triple; the
   under-entered case pins the full sentence including the way-out clause — one full-string pin
   per the message, figure pins for the arithmetic.

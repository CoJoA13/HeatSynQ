# Phase 5B — whole-branch review fix report

Applying the confirmed whole-branch review findings: two Important data-integrity/concurrency
defects, one related Minor, and one doc fix. Fixes kept surgical — no redesign. Both DBs up +
migrated; tests run FOREGROUND (host resource-constrained, no dev server started).

## FIX 1 (Important) + Minor #3 — `applyPayment`/`applyCredit` re-validate under the claim

`src/server/applications.ts`. The post-claim re-reads derived balances but never re-checked
kind/status/deletedAt, so a concurrent `unlockInvoice` (invoice → DRAFT) or `voidPayment`
committing between the unlocked stub read and the `FOR UPDATE` claim left the writer applying
against now-editable paper / a voided receipt. The stub's own comment conceded the verdict "cannot
be trusted from here for the WRITE" — that was the bug.

- **`INVOICE_CLAIM_SELECT`** (was ~L214): added `kind: true, status: true, deletedAt: true`
  alongside `total`/`invoiceDate`.
- **`applyPaymentInTx` — payment re-check (Minor #3)** (post-claim payment read, ~L265): the read
  now selects `deletedAt` and refuses `404 "Payment not found"` if the payment was voided between
  stub and claim. Before: `select: { amount, receivedDate }` with no liveness re-check.
- **`applyPaymentInTx` — invoice re-validation** (after the post-claim `findMany`, ~L268): added a
  loop over `invoiceIds` re-asserting, under the invoice-row claim, `deletedAt === null` (else
  `404 "Invoice not found"`), `kind === "INVOICE"` (else the credit-target 400), `status ===
  "FINALIZED"` (else the not-finalized 400). Messages are byte-identical to the stub-pass errors, so
  non-racing callers see no behavior change; only the race now refuses.
- **`applyCreditInTx`** (post-claim re-reads, ~L480): both re-reads now select
  `kind/status/deletedAt`; added re-validation of the TARGET (live FINALIZED INVOICE) AND the CREDIT
  (live FINALIZED CREDIT) under the claim, using the same checks and messages the two stub passes
  throw. Before: the re-reads pulled only `total` + applications/creditApplications.

Header/stub comments updated to say the stub verdict is now RE-VALIDATED under the locks (not merely
"re-read").

### FIX 1 RED evidence

New test `tests/unlock-concurrency.test.ts` — "applyPayment vs a committed unlock" — hand-scripts a
holder that takes ONLY the invoice-row `FOR UPDATE` claim and flips the invoice to DRAFT while
uncommitted (so the competitor's Read-Committed stub still reads FINALIZED and passes the stub; the
DRAFT is visible only to the post-claim re-read). The competitor is `applyPayment` on a manually
opened DEFAULT (Read Committed) transaction, so SSI is off the table and the post-claim
re-validation is the sole discriminator.

RED run (re-validation loop commented out):

```
× applyPayment vs a committed unlock ... never applies against DRAFT
  → promise resolved "undefined" instead of rejecting
AssertionError: promise resolved "undefined" instead of rejecting
```

i.e. with the fix removed the competitor did NOT reject — it wrote a 700 PAYMENT application against
the DRAFT invoice and committed. Loop restored → GREEN (the competitor rejects `400 /not finalized/`,
invoice ends DRAFT with zero live applications). The full-two-transaction race was used (not the
weaker "set DRAFT then apply" form), because a pre-set DRAFT would be caught by the unlocked stub and
would NOT discriminate the post-claim re-validation at all.

## FIX 2 (Important) — `voidPayment` refuses a payment with live applications

`src/server/receipts.ts`, `voidPaymentInTx` (~L311). Under the existing batch/payment claim, before
the soft-delete, added:

```ts
const liveApplication = await tx.application.findFirst({
  where: { paymentId, deletedAt: null }, select: { id: true } });
if (liveApplication) throw new HttpError(400, "This payment has applications — void them first");
```

This is the symmetric guard to `voidBatch`'s "void its payments first" and the invoice side's
A/R-activity refusal — wording matched to the sibling guard. Before, voiding a payment that had live
`Application` rows stranded them (invoice still reads settled) while the payment's cash vanished from
on-account. `applyPayment` was deliberately NOT given a batch-status gate (separate owner ruling).

### FIX 2 test (`tests/receipts.test.ts`)

New case "refuses a payment that still has a live application, then voids cleanly once it is gone":
applies a payment to a finalized invoice, asserts `voidPayment` rejects `400 "This payment has
applications — void them first"` and the payment stays live; then voids the application and asserts
`voidPayment` succeeds with the audit `delete` entry carrying the void reason. Non-vacuous — without
the guard the first `voidPayment` would succeed.

## FIX 3 (doc) — stale composition comment

`src/app/customers/[id]/ReceivablesSection.tsx` (~L5). The header claimed the route "composes Task
10's `agingReport` and Task 13's `openInvoicesForPayer`" — the PRE-FIX family-scoped functions whose
payer-family rollup caused the division-scope leak. The route actually composes the single-customer
`customerOwnAgingRow` (aging.ts) and `openInvoicesForCustomer` (applications.ts) via
`customer-receivables.ts`. Comment rewritten to state that, and to name why (never the family-scoped
pair) so a future reader can't reintroduce the leak.

## Covering-test results (FOREGROUND)

`npx vitest run tests/applications.test.ts tests/applications-concurrency.test.ts
tests/unlock-concurrency.test.ts tests/receipts.test.ts tests/receivables-routes.test.ts`
→ **5 files, 75 tests, all passed.**

Gates:
- `npx tsc --noEmit` → exit 0.
- `npx eslint src tests` → exit 0.
- `npm run build` → exit 0 ("Compiled successfully").

## Concerns

- FIX 2 closes the sequential stranding hole (the confirmed defect). A residual concurrency window
  exists — `applyPayment` claims the payment row while `voidPayment` claims only the batch row, so a
  perfectly-interleaved apply/void could still race — but closing it means gating `applyPayment` on
  batch/payment lifecycle, which the brief explicitly reserves for a separate owner ruling and
  forbids here. Left as-is per instruction; flagged for the record.

# Task 6 implementation report — `receipts.ts`: receipt batches and payments

Commit: `1acfc41` — "feat(5b): receipt batches and payments — create, add, post, void, live balance"

## Files

- `erp/src/server/receipts.ts` (new)
- `erp/src/app/api/receivables/batches/route.ts` (new — POST)
- `erp/src/app/api/receivables/batches/[id]/route.ts` (new — GET/PATCH/DELETE)
- `erp/src/app/api/receivables/batches/[id]/payments/route.ts` (new — POST)
- `erp/src/app/api/receivables/batches/[id]/payments/[paymentId]/route.ts` (new — DELETE)
- `erp/tests/receipts.test.ts` (new — 15 tests)
- `erp/tests/receivables-routes.test.ts` (new — 6 tests)

## Approach, per function

**Types.** `BatchDetail`/`PaymentRow` match the brief's interfaces verbatim.

**`getBatch`/`createBatch` read side (`readBatchDetail`/`toBatchDetail`/`toPaymentRow`).**
`DETAIL_INCLUDE` filters `payments: { where: { deletedAt: null } }` at the Prisma level — a
voided payment simply drops out of the batch view (there's no `deletedAt` field on `PaymentRow`
to render it struck-through; its own audit trail carries the history). `toPaymentRow` maps each
payment's `applications` (always empty pre-Task-7) into `ar-balances.ApplicationLite[]` and calls
`paymentOnAccount(amount, apps)` — with an empty array this returns the full amount, matching the
"no prepayments" brief note. `toBatchDetail` sums live payment amounts in integer cents
(`enteredTotal`), then computes `balance = (controlTotal ?? enteredTotal) − enteredTotal` the same
way, in cents, converting back to dollars once — the `ar-balances.ts` rounding discipline applied
locally since this module isn't itself pure (it reads Decimal columns). `readBatchDetail` never
filters `deletedAt` on the batch itself, so a voided batch stays readable (`getBatch`) — the
`readInvoiceDetail` "frozen paper stays visible" precedent.

**`createBatch`.** `withDbErrors` → Serializable `$transaction` → `allocateNumber
("receipt_batch_number_next", tx)` → `auditedCreate("receiptBatch", …, { tx })`. No FK to guard
(a bare batch carries none) — Serializable here pairs with `allocateNumber`'s own `FOR UPDATE` on
the `Setting` row, not a writer FK.

**`addPayment`.** Claims the batch first (`claimLiveBatch`), refuses if `status === "POSTED"`
(`refusePosted`, shared with `voidPayment`). One deviation from the brief's literal text: the
brief said to use `assertRefExists("customer", customerId, tx)` for the FK-writer guard, but
`"customer"` is not a registered `BlockerTarget`/`ReferenceKind` (`reference-constants.ts`'s
`REFERENCE_KINDS` covers only the ten generic reference-admin lookup tables — glAccount, material,
terms, paymentType, etc. — and `Customer` is a full entity with its own service, never one of
them). Calling it literally throws `"That undefined does not exist"` at runtime (TS doesn't catch
it either, since vitest transpiles without full type-checking) — confirmed by running the failing
test before fixing it. I replaced it with the exact pattern `orders.ts`'s `createOrder` already
uses for the identical FK (`saveNewOrder`, orders.ts:637-638): a direct
`tx.customer.findFirst({ where: { id, deletedAt: null } })`, throwing `HttpError(400, "That
customer does not exist")` on a miss — same message shape `assertRefExists` would have produced
had `customer` been registered. `assertRefExists("paymentType", …, tx)` is used verbatim, since
`paymentType` *is* a registered `ReferenceKind`. Both existence checks additionally fetch
`code`/`name` (customer) and `name` (paymentType) for the audit "after" payload — `auditedCreate`
writes exactly the object passed to it, not a fresh relational snapshot, so the FK-with-live-name
pattern (invoices.ts's own `auditData`) has to be assembled by hand here too.

**`voidPayment`.** Reason trimmed in the service (`discardInvoice` precedent) before the 400
check; then the same batch claim + `refusePosted` as `addPayment` (the brief groups both under the
identical message — see concerns below), a scoped `findFirst({ id, batchId, deletedAt: null })` to
get an accurate "not found" instead of a raw update, then `auditedSoftDelete("payment", …, { tx })`.

**`postBatch`.** Batch claim, `status === "POSTED"` → `HttpError(400, "already posted")` (verbatim,
the `finalizeInvoice` "already finalized" idempotent-refusal shape — a repeat post never re-writes).
Otherwise `auditedUpdate("receiptBatch", id, …, { tx })` flips `status` to `"POSTED"`.

**`voidBatch`.** Reason trimmed and required in the service. Batch claim, then a live-payment scan
(`findFirst({ batchId, deletedAt: null })`) — if any payment is still live, refuses with a message
containing "void its payments first" (the brief gave only that substring, not a full verbatim
sentence the way it did for the other two messages, so I composed
`"This batch has payments — void its payments first"`, matching the em-dash `"<subject> —
<instruction>"` shape the addPayment/postBatch messages already use). With none, `auditedSoftDelete
("receiptBatch", id, reason, tx)`.

## The batch claim (SQL)

```ts
async function claimBatch(tx, id) {
  await tx.$queryRaw`SELECT "id" FROM "ReceiptBatch" WHERE "id" = ${id} FOR UPDATE`;
  return tx.receiptBatch.findFirst({ where: { id }, select: { id: true, status: true, deletedAt: true } });
}
```

Exactly `claimOrder`'s shape (`order-locks.ts`): a raw id-only `FOR UPDATE`, then the ordinary
client reads the row that lock now guards (`status`/`deletedAt` both live ON the claimed row, so
the house rule — "the guarded state must live on, or be locked with, the claimed row" — is
satisfied trivially here; there's no second row like an Order/Invoice pair to worry about).
`claimLiveBatch` wraps it with the standard "not found" check (missing or already voided). Every
mutator (`addPayment`, `voidPayment`, `postBatch`, `voidBatch`) takes this claim FIRST, before
reading `status` or scanning live payments, so a concurrent post-vs-add/void genuinely serializes
on the lock rather than relying on SSI. I did not write a discriminating concurrency test (delete
the lock, watch it go red, competing caller pinned to Read Committed) — the Task 6 brief's 11 TDD
steps don't include one, and this claim guards a single row with no cross-row ordering question
(unlike Task 7's forthcoming multi-invoice claim); I verified it by inspection against the
`claimOrder` precedent instead. Flagging this so the reviewer can decide if it's wanted here too.

## Decimal → number handling

Every Prisma `Decimal` crosses into a plain `number` exactly once, at the read boundary:
`Payment.amount` and `Application.amount` in `toPaymentRow` (`p.amount.toNumber()`,
`a.amount.toNumber()`), `ReceiptBatch.controlTotal` in `toBatchDetail`
(`row.controlTotal.toNumber()`). `ar-balances.paymentOnAccount` is called with those already-converted
numbers. Zod's `decimalField(12, 2, …)` on the write side already normalizes `number | string` input
to a validated `number` before it reaches Prisma, so `data.amount`/`data.controlTotal` are numbers
throughout the write path too — no Decimal ever appears in the audit payload or the returned
`BatchDetail`/`PaymentRow`.

## TDD — RED/GREEN

Wrote `tests/receipts.test.ts` (15 cases across create/read, addPayment/balance, post-locks,
void-payment, void-batch) against a service that didn't exist yet:

```
Cannot find module '@/server/receipts' imported from '.../tests/receipts.test.ts'
```
— confirmed RED (module missing).

Implemented `receipts.ts`. First run: 14/15 passed, one failure —
`refuses an unregistered customer — the FK-writer pattern (assertRefExists)`:
```
AssertionError: expected Error: That undefined does not exist { status: … } to match object { status: 400, … }
```
This is the `assertRefExists("customer", …)` defect described above (`"customer"` isn't a
registered `BlockerTarget`, so `reference-guards.ts`'s label lookup falls through to `undefined`).
Fixed by switching to the direct `customer.findFirst` check (see addPayment section above). Second
run: 15/15 GREEN.

Wrote `tests/receivables-routes.test.ts` (6 cases, one per route file/verb, each asserting a 403
without the matching permission and a 200 with it) against the four new route files, which I wrote
alongside the tests (no separate RED capture for the routes — they're thin `handle` wrappers over
an already-tested service, the same shape every other route file in this codebase takes). All 6
passed on first run once the routes were written.

## Route → permission mapping (the four given files, six functions)

| Route | Method | Permission | Service call |
|---|---|---|---|
| `/api/receivables/batches` | POST | `receivables.create` | `createBatch` |
| `/api/receivables/batches/[id]` | GET | `receivables.view` | `getBatch` |
| `/api/receivables/batches/[id]` | PATCH | `receivables.edit` | `postBatch` (the only header mutation a batch has) |
| `/api/receivables/batches/[id]` | DELETE | `receivables.delete` | `voidBatch` (`reasonFromBody`) |
| `/api/receivables/batches/[id]/payments` | POST | `receivables.create` | `addPayment` |
| `/api/receivables/batches/[id]/payments/[paymentId]` | DELETE | `receivables.delete` | `voidPayment` (`reasonFromBody`) |

No `listBatches`/GET on `/api/receivables/batches` — not among the brief's six function
signatures; left for whatever later task adds an A/R worklist.

## Route 403 coverage

Every one of the 6 routes above has a paired 403-then-200 test: signs in with a permission set
that excludes the route's own gate (but includes a plausible neighboring one, e.g. `receivables
.view` for a `create`-gated route), asserts 403, then signs in with the correct grant and asserts
200 plus a content check (status/enteredTotal/balance/payments length as appropriate).

## Gate results (all foreground)

- `npm test` — 112 files / 1739 tests passed (170.9s), including the new 15 + 6.
- `npx tsc --noEmit` — clean, no output.
- `npx eslint src tests` — clean, no output.
- `npm run build` — succeeded; all four new `/api/receivables/...` routes listed in the route
  manifest as dynamic (`ƒ`) functions.

## Self-review

- **Batch claim is a real `FOR UPDATE`**: yes — raw `$queryRaw` tagged template, id-only,
  mirroring `claimOrder` exactly; verified by reading `order-locks.ts` side-by-side with
  `claimBatch` line for line.
- **Decimal → number everywhere**: yes — traced every `Prisma.Decimal` field (`Payment.amount`,
  `Application.amount`, `ReceiptBatch.controlTotal`) to its single `.toNumber()` call at the read
  boundary; the write boundary is already numbers via `decimalField`.
- **Audit content asserted, not just presence**: yes — `addPayment`'s test checks
  `after.amount`/`after.customerCode`/`after.paymentTypeName`/`after.batchId`; `postBatch`'s test
  checks `before.status`/`after.status`; both void tests check `entry.reason` against the exact
  string passed in.
- **Error messages verbatim**: `"This batch is posted — reopen or void a payment to change it"`
  and `"already posted"` are copied character-for-character from the brief, including the em dash.
  `"void its payments first"` was only given as a substring in the brief — see the voidBatch
  section above for the sentence I composed around it.
- **No over-building**: no `listBatches`, no reopen, no Application/applications wiring — verified
  by re-reading the brief's six signatures against the final export list in `receipts.ts`.

## Concerns

1. **The brief's `assertRefExists("customer", …)` instruction doesn't work as written** — `customer`
   isn't a registered `BlockerTarget`. I resolved this by matching `orders.ts`'s existing precedent
   for the identical FK rather than extending the reference-kind registry (which would have pulled
   `Customer` into the generic reference-admin CRUD system it doesn't belong in — `EXTRA_SCHEMAS`
   there assumes every kind is a simple `{name, active}` lookup table). Flagging in case a later
   task or the brief author wants this recorded as a correction.
2. **`voidPayment` is blocked on a POSTED batch**, per the brief's literal grouping ("addPayment/
   voidPayment on a POSTED batch → refuse"). The refusal message itself says "...reopen or void a
   payment to change it," which reads as though voiding a payment should still be possible on a
   POSTED batch — but there is no `reopen` function in this task's scope (only 6 exports), so as
   implemented a POSTED batch's payments can never be voided until a future "reopen" exists. I
   followed the brief literally rather than guessing a different behavior; flagging so the owner/
   reviewer can confirm this is the intended interim state.
3. No discriminating concurrency test for the batch claim (see the claim section above) — the
   brief's 11 steps didn't call for one and this is a single-row lock, not a multi-row ordering
   question, but noting it since the global constraints doc treats "a passing concurrency test is
   not evidence" as a binding rule elsewhere in the phase.

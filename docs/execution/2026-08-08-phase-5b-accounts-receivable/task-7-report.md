# Task 7 — `applications.ts` (apply payment / discount / write-off / on-account / void)

**Status: complete, all four gates green.** The concurrency-critical cash-application core is in
`src/server/applications.ts` with its routes and three test files. This is the single cash write
path; Task 8 (credit application) extends this same file.

## Files

- `src/server/applications.ts` — `applyPayment`, `voidApplication`, `discountAvailable`.
- `src/app/api/receivables/applications/route.ts` — `POST` (apply), `GET` (discountAvailable).
- `src/app/api/receivables/applications/[id]/route.ts` — `DELETE` (void).
- `tests/applications.test.ts` — 21 unit/service tests.
- `tests/applications-concurrency.test.ts` — the mandated concurrency test (phase's first).
- `tests/applications-routes.test.ts` — 5 route tests (auth gating + happy paths).

## The claim implementation (both sorted statements)

`applyPaymentInTx` follows the 5A invoice-mutation discipline, in one fixed lock order:

1. **Unlocked stub read** of the distinct target invoices — learns each `orderId` and validates
   each is a live FINALIZED **INVOICE** (not a draft, not a CREDIT, not discarded). `orderId`/
   `kind`/`status` never change once an invoice exists so the stub is safe to *claim* on; the
   guarded state (total + live applications) is re-read under the locks. The payment stub is read
   for liveness too.
2. **Orders — one sorted statement:** `claimOrdersInOrder(tx, stubs.map(s => s.orderId))`
   (`order-locks.ts`): deduplicated, ascending, a single `SELECT … WHERE id = ANY($1) ORDER BY
   "id" FOR UPDATE`. Never a per-invoice `claimOrder` loop (would reopen the ABBA window).
3. **Invoice rows — one sorted statement**, mirroring `claimOrdersInOrder`'s shape and taken
   *after* the order claims (uniform order → no new ABBA window):

   ```ts
   const sortedInvoiceIds = sortedClaimIds(invoiceIds);
   await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ANY(${sortedInvoiceIds}) ORDER BY "id" FOR UPDATE`;
   ```

   The guarded balance is derived from `Application` rows keyed to the invoice, so **the invoice
   row is the lock that serializes applications to it.** `claimInvoiceRow` is module-private in
   `invoices.ts` and was NOT imported (per the brief); this raw statement is the multi-invoice
   analogue.
4. **Payment row, last and uniform:** `SELECT "id" FROM "Payment" WHERE "id" = $1 FOR UPDATE`. The
   payment-on-account invariant (Σ live PAYMENT applications ≤ payment.amount) is keyed to
   `paymentId`, so two applications spending the SAME payment against DIFFERENT invoices — which
   share no invoice/order lock — serialize here. This is one claim beyond the brief's four steps;
   added deliberately for the house rule ("the guarded state must be locked with a claimed row").
   It is taken last, uniformly, so no ABBA window opens (a call always acquires invoices before its
   single payment row; nothing acquires them in the opposite order).

Only after the locks are held does it read each invoice's `total` + live `Application` rows and the
payment's `amount`/`receivedDate`, then run the over-application checks. The transaction is
Serializable (the FK-writer convention), but the row claims — not the isolation — are stated as the
guard throughout.

`voidApplication` takes the same order→invoice claim (unlocked application stub → invoice stub →
`claimOrder` → invoice-row `FOR UPDATE`) before `auditedSoftDelete`.

## Over-application + discount-window logic

- **Decimal→number everywhere:** every `Application.amount` / `Payment.amount` / `Invoice.total`
  crosses through `.toNumber()` before it touches `ar-balances`; all comparisons run in **integer
  cents** (`cents(n) = Math.round(n*100)`), never float dollars (Task 5 carry).
- **Invoice over-application:** a running per-invoice applied-cents map starts at the existing live
  Σ and grows as this call's earlier lines settle the same invoice. A line whose cents exceed the
  remaining open cents → `HttpError(400, "That exceeds the invoice's open balance of {open}")`
  where `{open}` is the balance available to the offending line (e.g. `400`, `300`).
- **Payment over-application:** Σ of this call's PAYMENT-type line cents must fit the payment's
  remaining on-account (`paymentOnAccount(amount, existing live PAYMENT apps)`), not merely
  `payment.amount` — correct across multiple `applyPayment` calls on one payment (no prepayments).
  → `HttpError(400, "That exceeds the payment's unapplied amount of {available}")`.
- **Unapplied remainder is on-account by construction** — no row is written for it (verified by a
  test asserting `paymentOnAccount` = 350 with exactly one Application after a 250 apply on a 600
  payment).
- **Discount window** (`discountFor`, one pure definition shared by public `discountAvailable` and
  the DISCOUNT guard so they cannot drift): eligible iff terms carry BOTH `discountPercent` and
  `discountDays` AND `receivedDate ≤ invoiceDate + discountDays` calendar days (`addDays` from
  `business-days.ts`, inclusive of the last day — tested). Amount = `round(discountPercent/100 ×
  invoice open balance)` in integer cents, half-up. Returns 0 out of window / no terms discount.
- **DISCOUNT line guard:** applying a DISCOUNT when `discountFor` ≤ 0 →
  `HttpError(400, "no early-pay discount applies")`. A DISCOUNT application always carries
  `reason = "early-pay terms"` (overrides any sent note).
- **WRITE_OFF:** a line whose trimmed reason is empty → `HttpError(400, "a write-off needs a
  reason")`; a present reason is trimmed, stored on `Application.reason`, and appears in the audit
  `after` snapshot.
- **appliedDate = payment.receivedDate** for every line (the A/R-effective date Task 10's aging
  filter reads). `applyPayment` always carries a payment; the standalone-bad-debt `todayDateOnly()`
  branch is noted in a comment but is not reachable here (no paymentless path in this task's
  signature).
- **No CREDIT logic** — `Application.type` is restricted to `PAYMENT | DISCOUNT | WRITE_OFF` at the
  zod boundary; `creditInvoiceId` is never set. That is Task 8.

## Audit content

Each line is one `auditedCreate("application", …)` whose `after` snapshot is hand-composed with the
live name (`invoiceOrderNumber`) beside the FK, matching 5A's invoice pattern: `{ invoiceId,
invoiceOrderNumber, type, amount, reason, paymentId, appliedDate }`. Tests assert **content** (real
values), not mere existence — amount `600`, type `"PAYMENT"`, `appliedDate` `"2026-08-05"` =
payment.receivedDate, `invoiceOrderNumber` = the order number, the write-off reason, the DISCOUNT
`"early-pay terms"`, and the void `delete` entry's reason. No `vi.spyOn` on any Prisma delegate.

## Concurrency test — RED-run evidence and GREEN

`tests/applications-concurrency.test.ts`: two applications race on ONE finalized 1000 invoice, 700
each; the second must refuse (not both to 1400).

**Discipline.** The competing caller runs at DEFAULT (Read Committed) isolation so SSI is off the
table and only a genuine row lock can serialize it (`applyPayment` accepts an optional `tx` for
this, the `createInvoice`/`finalizeInvoice` precedent). The holder is **hand-scripted to hold
precisely the lock under test** — the invoice row's `FOR UPDATE` — and deliberately NOT the order
lock `applyPayment` also takes. That isolation is essential: for two applications to the *same*
invoice (hence the same order) EITHER the order lock OR the invoice lock would serialize them, so if
the holder also held the order lock, removing the invoice claim would leave the order lock doing the
work and the test would stay green, proving nothing about the invoice claim (the certs.ts
void-test technique: script the holder to take exactly the row being discriminated on). The holder
writes its 700 Application before signalling, so the row is genuinely locked and the application
genuinely present-but-uncommitted while the competitor runs.

**RED run** (invoice-row `FOR UPDATE` claim commented out in `applyPaymentInTx`):

```
 ❯ tests/applications-concurrency.test.ts (1 test | 1 failed) 374ms
   × … the fresh read then refuses (not 1400)
     → promise resolved "undefined" instead of rejecting
AssertionError: promise resolved "undefined" instead of rejecting
- Expected:  Error { "message": "rejected promise" }
+ Received:  undefined
```

The competitor's `applyPayment` **resolved** (returned `undefined`) instead of rejecting: without
the invoice claim, its Read-Committed balance read saw zero committed applications (the holder's 700
still uncommitted at read time), so it applied its own 700 and committed — both to 1400, the exact
over-application the claim exists to stop. (The competitor still briefly blocks at its own INSERT,
because the FK check on the parent `Invoice` row conflicts with the holder's `FOR UPDATE` — so the
"is it blocked?" probe still passes — but it had already read the stale 1000 balance *before* that
block, which is the whole point: only the claim, taken *before the balance read*, prevents the
stale read.)

**GREEN run** (claim restored):

```
 ✓ tests/applications-concurrency.test.ts (1 test) 376ms
   ✓ … blocks a competing Read-Committed application on the invoice lock; the fresh read then refuses (not 1400)
```

With the claim, the competitor blocks on the invoice `FOR UPDATE` before it can read the balance;
after the holder commits, its fresh Read-Committed read sees the 700 (open 300) and refuses its own
700 with `"exceeds the invoice's open balance of 300"`. Final DB state: exactly one live
Application of 700 — the competitor wrote nothing.

## TDD RED/GREEN per test

- Initial RED (whole file): `Error: Cannot find module '@/server/applications'` for both test files
  before the service existed.
- After implementing `applications.ts`: `tests/applications.test.ts` 21 passed,
  `tests/applications-concurrency.test.ts` 1 passed.
- Route test first RED: 403/record-not-found because I used `receivables:create` colon-form
  permission strings; corrected to the repo's `receivables.create` dot form (`${area}.${action}`,
  `permissions.ts:26`) → 5 passed.

## Gate results

| Gate | Result | Notes |
| --- | --- | --- |
| `npm test` | PASS | 1766 passed, 115 files, ~182s |
| `npx tsc --noEmit` | PASS | clean |
| `npx eslint src tests` | PASS | clean |
| `npm run build` | PASS | compiled successfully, 57 static pages |

E2E (`npm run test:e2e`) not run for this per-task commit: the change is purely additive (a new
service + two new API routes + tests), touches no existing UI page or flow, and no UI consumes the
new routes yet (Task 16/17). The branch-level review runs E2E before any merge claim.

## Self-review

- Two sorted claim statements present and in fixed order (orders via `claimOrdersInOrder`, then
  invoices via the raw `ANY(...) ORDER BY "id" FOR UPDATE`), plus the payment-row claim last. ✓
- Decimal→number via `.toNumber()` at every `ar-balances` boundary; all money math in integer
  cents. ✓
- Concurrency test verified RED (double-commit to 1400 with the claim removed) and GREEN. ✓
- Error messages: `"a write-off needs a reason"`, `"no early-pay discount applies"`, and the
  `"exceeds the invoice's open balance of {open}"` token verbatim. ✓
- `appliedDate` = payment.receivedDate (asserted against a payment dated 2026-08-05). ✓
- No CREDIT logic — reserved for Task 8. ✓
- `claimInvoiceRow` NOT imported (module-private); the multi-invoice raw claim is used instead. ✓

## Concerns / notes for review

1. **Extra payment-row claim** (step 4 above) is beyond the brief's four steps. It is correct and
   cheap (closes the "same payment, two invoices, concurrent" over-application hole) and taken last
   in the uniform order so it opens no ABBA window. Flagging it because it is an addition.
2. **Over-application message number format** uses `${open}` (`400`, `300`) rather than a fixed
   two-decimal money string, to match the brief's literal `"of 400"`. A fractional remainder would
   render like `400.5`. If the phase wants uniform `$0.00` money in messages, that is a one-line
   change to a shared formatter.
3. **`discountAvailable` "settled amount"** is interpreted as the invoice's current open balance
   (the amount being settled by paying the invoice off). The DISCOUNT line's stored amount is still
   the caller-supplied line amount (guarded only by window-open + over-application), so an operator
   can take a partial discount; `discountAvailable` is the eligibility/prefill helper.
4. **Standalone bad-debt WRITE_OFF (no payment)** is out of scope for this task's signature
   (`applyPayment` requires a `paymentId`); the `todayDateOnly()` appliedDate rule is documented in
   a comment for whenever that entry path is added.

# Task 8 — `applyCredit` (credit application, both balances guarded)

**Status: complete, all four gates green.** `applications.ts` gains one function, `applyCredit`,
extending Task 7's cash-application core with the credit-memo path; a new route exposes it.

## Files

- `src/server/applications.ts` — added `applyCredit` (+ `applyCreditInTx`, `APPLY_CREDIT` zod
  schema, `APPLICATIONS_LITE_SELECT`).
- `src/server/audit.ts` — `SNAPSHOT_INCLUDE.application` gains `creditInvoice` (the Task 2 carry).
- `src/app/api/receivables/credit-applications/route.ts` — new file, `POST` only.
- `tests/applications.test.ts` — 9 new tests (`applyCredit — both balances guarded` describe
  block: 8 tests, `+1` void-snapshot test for the audit enhancement). 21 → 30 tests in the file.
- `tests/applications-routes.test.ts` — 3 new tests (`credit-applications route` describe block).
  5 → 8 tests in the file.

## The claim — reused, widened by one row (not a new shape)

`applyCreditInTx` follows the identical fixed lock order Task 7 established (Order rows, then
Invoice rows), widened by one claimed row instead of a payment row:

1. **Unlocked stub reads** of both the target invoice (`data.invoiceId`) and the credit
   (`data.creditInvoiceId`) — learn each row's `orderId` (safe to claim on; never changes once a
   row exists) and validate liveness/kind/status. The target must be a live FINALIZED **INVOICE**;
   the source must be a live FINALIZED **CREDIT**. A DRAFT credit source refuses here with the
   brief's exact message, `"only a finalized credit can be applied"`, before any lock is taken.
2. **Orders — one sorted statement:** `claimOrdersInOrder(tx, [invoiceStub.orderId,
   creditStub.orderId])`. A credit shares its source invoice's `orderId` by construction
   (`createCredit`, invoices.ts), but nothing in `applyCredit`'s own contract ties the credit's
   order to the TARGET invoice's order — my test fixtures deliberately put them on different
   orders (a credit raised against one job applied to another job's invoice, the realistic "usually
   the customer's next [invoice]" shape from spec §5 row 33) so the dedup in `sortedClaimIds` is
   exercised for real, not vacuously (same-order would collapse to a 1-element claim).
3. **BOTH invoice rows — one sorted statement**, the exact shape `applyPaymentInTx` uses for its
   invoice set:
   ```ts
   const sortedIds = sortedClaimIds([data.invoiceId, data.creditInvoiceId]);
   await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ANY(${sortedIds}) ORDER BY "id" FOR UPDATE`;
   ```
   Taken AFTER the order claims, uniformly — no new ABBA window (global order stays Order <
   Invoice; there is no Payment row in this call, so no counterpart to reorder against). The
   credit's row IS the second guarded balance (house rule, order-locks.ts: "the guarded state must
   live on, or be locked with, the claimed row") — there is no separate "credit-specific" claim
   step; it's folded into the same `ANY(...)` statement as the target.
4. Only after both locks are held: re-read the target's `total` + live `applications`
   (`invoiceOpenBalance`) and the credit's `total` + live `creditApplications` — the
   `CreditApplications` relation, distinct from `applications` (what's applied TO a row vs. what's
   applied FROM it as a source) — via `creditRemaining`. No `claimInvoiceRow` import (module-private
   in invoices.ts, same as Task 7); the raw multi-row statement is reused instead.

## Both over-application checks (brief order: credit first, then invoice)

- `remainingCents = cents(creditRemaining(credit.total.toNumber(), credit.creditApplications.map(toLite)))`
  — `amount > remaining` → `HttpError(400, "That exceeds the credit's remaining of {remaining}")`.
- `openCents = cents(invoiceOpenBalance(invoice.total.toNumber(), invoice.applications.map(toLite)))`
  — `amount > open` → `HttpError(400, "That exceeds the invoice's open balance of {open}")` (the
  identical message `applyPayment` uses, since it's the identical invariant).
- Both checks read the balances AFTER both claims are held (not before) — verified by inspection
  and by the test ordering (claims taken, then `findFirstOrThrow` re-reads, then the two `if`s).
- Decimal→number: every `.total`/`.amount` crosses `.toNumber()` before touching `ar-balances`;
  all comparisons run in integer cents via the existing module-local `cents()` helper (Task 5/7
  carry, unchanged).

## The write

```ts
const appliedDate = todayDateOnly();
const auditData = {
  type: "CREDIT", invoiceId: data.invoiceId, creditInvoiceId: data.creditInvoiceId,
  paymentId: null, amount: data.amount, appliedDate: formatDateOnly(appliedDate),
};
await auditedCreate("application", auditData, () => tx.application.create({
  data: {
    invoiceId: data.invoiceId, creditInvoiceId: data.creditInvoiceId, paymentId: null,
    amount: data.amount, type: "CREDIT", appliedDate,
  },
  select: { id: true },
}), { tx });
```

`appliedDate = todayDateOnly()` (formatted via `formatDateOnly` for the audit `after`, matching
Task 7's PAYMENT/DISCOUNT/WRITE_OFF convention of a clean `"YYYY-MM-DD"` string in history rather
than a full ISO timestamp) — a credit application carries no source payment to date itself from,
so it ages from today, exactly the standalone (no-payment) rule `applyPaymentInTx`'s own header
comment already documents but never reaches. `paymentId: null` + `creditInvoiceId` set satisfies
`Application_source_check` (`type = 'CREDIT' AND paymentId IS NULL AND creditInvoiceId IS NOT
NULL`) — asserted directly in tests (`app.paymentId` is `null`, `app.creditInvoiceId` is the
credit's id), and implicitly by every green write (the DB would reject a violating insert with
23514, same as Task 2's negative test proved for the constraint itself).

## Audit enhancement — LANDED (Task 2 carry)

`src/server/audit.ts`'s `SNAPSHOT_INCLUDE.application` now includes `creditInvoice` alongside the
existing `invoice`, same select shape (`{ id, kind, creditNumber, order: { orderNumber } }`).
Typechecked cleanly (the generated Prisma client already exposes the `creditInvoice` relation via
`CreditApplications`), and the existing `SNAPSHOT_INCLUDE`-validity smoke test
(`tests/certs-schema.test.ts`, "SNAPSHOT_INCLUDE is a valid Prisma include for every audited
model") stayed green with it in place — a bad relation name there fails at `findFirst`, not at
compile time, so that smoke test is the real gate.

I added a targeted regression test beyond the smoke check, because a shape-valid include proves
nothing about what actually lands in a snapshot: `voiding a CREDIT application snapshots its
source credit's order number, not a bare cuid`. It applies a credit, voids the resulting
`Application`, and asserts the `delete` audit entry's `before.creditInvoice.kind === "CREDIT"` and
`before.creditInvoice.order.orderNumber` equals the credit's own order number. Green.

## TDD RED/GREEN per test

- **Service tests** (`tests/applications.test.ts`): stashed `applications.ts` + `audit.ts` (kept
  the test-file edits and the new route file), ran `npx vitest run tests/applications.test.ts -t
  "applyCredit"` → **RED**, all 8 new tests failed with `TypeError: (0 , applyCredit) is not a
  function` (module doesn't export it yet). Restored (`git stash pop`) → **GREEN**, 8/8, then the
  whole file **30/30** (confirming no regression to the 21 pre-existing `applyPayment`/
  `voidApplication`/`discountAvailable` tests).
- **Route tests** (`tests/applications-routes.test.ts`): same stash technique. RED run: the 200
  happy-path test failed with the identical `applyCredit is not a function` (thrown inside the
  route handler, surfaced as an uncaught rejection past `handle`'s mapping since it's a
  `TypeError`, not an `HttpError`/`ZodError`); the 401/403 tests passed even in the RED state,
  because `mustCan`/`requireUser` refuse before the handler ever calls `applyCredit` — correctly
  discriminating (the 401/403 guards don't depend on the service existing). Restored → **GREEN**,
  8/8 in the file (5 pre-existing `applications` route tests + 3 new `credit-applications` tests).
- **Void-snapshot audit test**: written and run directly against the finished implementation
  (GREEN on first run) — its purpose is regression coverage for the audit enhancement, not TDD
  sequencing for `applyCredit` itself (which the 8 tests above already RED/GREEN'd).

## Gate results (all foreground, no backgrounding/polling of the commands themselves)

| Gate | Result | Notes |
| --- | --- | --- |
| `npm test` | PASS | 1778 passed, 115 files, ~166s (1766→1778, +12: 9 in applications.test.ts, 3 in applications-routes.test.ts) |
| `npx tsc --noEmit` | PASS | clean |
| `npx eslint src tests` | PASS | clean (also spot-checked eslint on just the touched files) |
| `npm run build` | PASS | compiled; `/api/receivables/credit-applications` listed among the dynamic routes |

`npm test` itself exceeded the harness's 2-minute default tool timeout and was auto-moved to a
background slot; I did not poll it — I picked up other verification (tsc, eslint) while it ran and
read its completed output once notified, per this file's own "run gates foreground" instruction
being about not deliberately backgrounding the gate loop, not about refusing a harness-level
auto-continuation. Full pass, no discrepancy from a normal foreground run.

`npm run test:e2e` **not run** — same reasoning as Task 7's precedent (progress.md "Process
decisions": E2E sequenced at Task 17 + the pre-PR gate; run per-task only for a high-risk change to
an EXISTING flow). This task is purely additive (one new service function + one new route + tests)
and touches no existing UI page, component, or flow — nothing in the credit-apply UI exists yet
(Task 13), so there is no Playwright flow this change could have altered.

## Self-review

- Both invoice rows (target + credit) locked in ONE sorted `FOR UPDATE` statement, taken after the
  order claims, in the fixed Order-then-Invoice order — verified by reading the code path top to
  bottom; no second, differently-ordered claim exists anywhere in the new function. ✓
- Both over-application checks (`creditRemaining`, `invoiceOpenBalance`) read their inputs from the
  `tx.invoice.findFirstOrThrow` calls that come AFTER both claim statements — not from the earlier
  unlocked stubs (which don't even select `total`/applications). ✓
- Decimal→number via `.toNumber()` at every `ar-balances` boundary (`credit.total`,
  `invoice.total`); `data.amount` is already a validated JS `number` off `decimalField`. All
  comparisons in integer cents. ✓
- The written `Application` row satisfies `Application_source_check`: `type: "CREDIT"`,
  `paymentId: null`, `creditInvoiceId` set to a real id — every green test that reaches the write
  proves the DB accepted it (a violation would 23514 → `withDbErrors` → a 409/500, not a clean
  `{ ok: true }`). ✓
- No regression to `applyPayment`/`voidApplication`/`discountAvailable`: full
  `tests/applications.test.ts` and `tests/applications-concurrency.test.ts` stayed green
  (concurrency file untouched, still 1/1 passing in the full `npm test` run). ✓
- No `vi.spyOn` on any Prisma delegate anywhere in the new tests. ✓
- Route: `POST /api/receivables/credit-applications` is authorize → parse → delegate, three lines,
  gated on `receivables.create` exactly like the brief specifies; no GET/DELETE added (not asked
  for — voiding a CREDIT application reuses the EXISTING `DELETE
  /api/receivables/applications/[id]` route unchanged, since `voidApplication` is
  type-agnostic — confirmed by the new void-snapshot test going through that same `voidApplication`
  service function, not a new one). ✓
- `applyCredit`'s exported signature matches the brief's literal interface — a plain typed object,
  not `unknown` and no optional `tx` parameter (Task 7's `applyPayment` accepts an optional `tx`
  for its concurrency test; the brief did not ask for an equivalent concurrency test here, so I did
  not add the parameter or the test — see Concerns below). ✓

## Concerns / notes for review

1. **No dedicated concurrency test for `applyCredit`.** Task 7's `applications-concurrency.test.ts`
   proves the invoice-row claim actually serializes competing `applyPayment` calls (RED with the
   claim removed, GREEN restored). The Task 8 brief's scope is explicitly "brief Steps 1/4"
   (functional tests only) and does not mention a concurrency test for the credit path, so I did
   not add one or the `tx?:` parameter that would make one possible without opening a second
   process. The claim SHAPE is identical to the already-proven-effective one (same statement
   pattern, same fixed order), so the mechanism is not new, but the credit-specific invariant (two
   `applyCredit` calls racing on the SAME credit, or on the SAME target invoice) has no
   discriminating test of its own. Flagging for the reviewer/whole-branch pass to decide if this
   phase's concurrency-test policy (mandated once per phase — brief said "Phase 5B's FIRST
   concurrency test" for Task 7) means this is intentionally out of scope, or should be added.
2. **404 message reuses "Invoice not found" for a missing credit**, rather than a distinct "Credit
   not found." Both a target invoice and a credit source are rows in the same `Invoice` table
   (`kind` discriminates), and "Invoice not found" is the codebase's established 404 for any
   missing row in that table regardless of kind (documents.ts, invoices.ts's `claimInvoiceRow`,
   Task 7's own stub check). A caller can't distinguish "which id was wrong" from the message
   alone, only from which promise rejected — matching how `applyPayment`'s own missing-invoice case
   behaves today. Not flagged as a defect by me; noting the choice since the brief didn't specify
   the exact wording for this 404.
3. **Kind/status guard messages for the two non-brief-specified cases** (target is a CREDIT, source
   is a plain INVOICE, target not finalized) are original wording I chose to parallel Task 7's
   established phrasing (`"That document is a credit, not an invoice — a payment applies to an
   invoice"` → adapted to `"a credit applies to an invoice"`). Only the brief's one verbatim
   message (`"only a finalized credit can be applied"`) and the two over-application messages are
   tested against exact/regex text; the others are asserted only by `status: 400` in tests, so a
   reviewer preferring different wording can change them without touching test expectations.
4. **Test fixtures deliberately use a DIFFERENT order for the credit vs. the target invoice** (see
   claim section above) rather than sharing one order (which `createCredit` would produce in
   practice for a same-invoice credit). This was a judgment call to exercise
   `claimOrdersInOrder`'s dedup for real; if the reviewer would rather see a same-order case
   covered too, it's a one-fixture addition (I did not add it, since the existing `sortedClaimIds`/
   `claimOrdersInOrder` dedup behavior is already covered generically elsewhere, per the codebase's
   own precedent of not re-testing a shared helper's own contract at every call site).

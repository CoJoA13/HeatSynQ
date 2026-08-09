# Codex review fixes — Phase 5B Accounts Receivable

## Round 1 — applications

Three confirmed correctness / data-integrity findings from the Codex review of PR #74, all centred
on `src/server/applications.ts` plus one hand-written CHECK constraint. Surgical fixes, no redesign.

---

### FIX #1 (P1) — restrict applications to the payer's / credit's customer family

`applyPaymentInTx` / `applyCreditInTx` validated each target as a live FINALIZED INVOICE but never
checked it belonged to the paying party's family, so a crafted request could settle an unrelated
customer B's invoice with customer A's cash (or a credit).

**`src/server/applications.ts` — `applyPaymentInTx`**
- Stub select (`~L232`): added `customerId` to the invoice stub `select`.
- Payment stub (`~L247`): added `customerId` to the payment stub `select`.
- New guard after the payment-stub validation (`~L251-260`):
  ```ts
  const payerFamily = new Set(await familyCustomerIds(paymentStub.customerId));
  for (const id of invoiceIds) {
    if (!payerFamily.has(stubById.get(id)!.customerId)) {
      throw new HttpError(400, "That invoice belongs to a customer outside this payment's family");
    }
  }
  ```
  Reuses the existing module-level `familyCustomerIds` helper (root = `parentId ?? self`, + live
  children). The invoice's `customerId` is frozen paper, so validating in the unlocked stub pass is
  sufficient — no re-read under the claim.

**`src/server/applications.ts` — `applyCreditInTx`**
- Both stub selects (`~L466`, `~L478`): added `customerId` to the invoice and credit stub `select`s.
- New guard after both stub validations (`~L487-491`):
  ```ts
  const creditFamily = new Set(await familyCustomerIds(creditStub.customerId));
  if (!creditFamily.has(invoiceStub.customerId)) {
    throw new HttpError(400, "That invoice belongs to a customer outside this credit's family");
  }
  ```
  The credit's customer resolves via its own `customerId` column (an Invoice row). Placed AFTER the
  kind/status/deletedAt checks, so the DRAFT-source / wrong-kind / 404 tests still hit their own
  errors first.

**Tests**
- `tests/applications.test.ts`: new `applyPayment — family scoping` block (unrelated → refused;
  sibling division in the same family → allowed); two new `applyCredit` cases (unrelated → refused;
  sibling → allowed). Helpers `finalizedInvoice` / `finalizedCredit` gained an optional `customerId`
  so a credit and invoice can share a family.
- `tests/applications-routes.test.ts`: `POST` payment to an unrelated customer's invoice → 400;
  `POST` credit to an unrelated customer's invoice → 400. Route helpers gained an optional
  `customerId`.
- Updated existing same-scope fixtures that had silently relied on cross-customer application:
  the `applyCredit` suite (credit now created on `inv.customerId`) and
  `applyPayment > settles two invoices from one payment in a single call` (both invoices on the
  same payer). These were exercising a capability the spec never permitted; they now use a realistic
  same-family shape.

---

### FIX #2 (P1) — cap a DISCOUNT line at the terms-derived eligible amount

`resolveReason`'s DISCOUNT branch only checked `discountFor(...) > 0`; it never capped `line.amount`,
so a 2/10 $1000 invoice accepted a $1000 "discount", waiving the whole receivable.

**`src/server/applications.ts` — `resolveReason` (`~L367-378`)**
Before:
```ts
if (discountFor(invoice.customer.terms, invoice.invoiceDate, receivedDate, open) <= 0) {
  throw new HttpError(400, "no early-pay discount applies");
}
```
After:
```ts
const elig = discountFor(invoice.customer.terms, invoice.invoiceDate, receivedDate, open);
if (elig <= 0) {
  throw new HttpError(400, "no early-pay discount applies");
}
if (cents(line.amount) > cents(elig)) {
  throw new HttpError(400, `discount exceeds the eligible early-pay amount of ${elig}`);
}
```
Integer cents; a discount ≤ elig is still allowed (operator may take part of it).

**Tests** (`tests/applications.test.ts`, DISCOUNT block): a DISCOUNT of 1000 on a 2/10 $1000 invoice
→ refused, naming `20`; a DISCOUNT of exactly 20 → allowed (open drops to 980).

---

### FIX #8 (P2) — tighten `Application_source_check` so PAYMENT/DISCOUNT require a payment source

The prior CHECK allowed a source-less PAYMENT/DISCOUNT (both FKs null) — a row that reduces an
invoice while identifying no receipt, hence unreconcilable. Only a standalone bad-debt WRITE_OFF
should be source-less.

**New migration dir:** `prisma/migrations/20260809120000_application_source_requires_payment/`
DROPs and re-ADDs the constraint (the accounts_receivable migration that first defined it was left
untouched — a hook blocks editing it):
```sql
ALTER TABLE "Application" DROP CONSTRAINT "Application_source_check";
ALTER TABLE "Application" ADD CONSTRAINT "Application_source_check" CHECK (
  ("type" IN ('PAYMENT','DISCOUNT') AND "paymentId" IS NOT NULL AND "creditInvoiceId" IS NULL)
  OR ("type" = 'WRITE_OFF' AND "creditInvoiceId" IS NULL)
  OR ("type" = 'CREDIT' AND "paymentId" IS NULL AND "creditInvoiceId" IS NOT NULL)
);
```
Applied to BOTH DBs via `prisma migrate deploy` (erp + erp_test), then `prisma generate`. Both DBs
held zero Application rows, so the re-ADD validated cleanly; `migrate status` clean on both.

- `prisma/schema.prisma`: updated the `Application` model doc comment to state the tightened rule and
  point at the new migration dir.
- `tests/schema.test.ts`: new negative case — a raw insert of a PAYMENT with a null `paymentId` now
  throws 23514 (`P2010` / `originalCode: "23514"`).
- `tests/statements.test.ts`: the `payInvoice` helper created a source-less PAYMENT (the only
  pre-existing raw insert that violated the tightened CHECK); rewritten to attach a real
  batch/paymentType/payment for the invoice's own customer. No assertions changed.

---

## Results

- `npx vitest run tests/applications.test.ts tests/applications-routes.test.ts tests/applications-concurrency.test.ts tests/schema.test.ts tests/statements.test.ts` → **82 passed** (5 files).
- Affected callers of `applyPayment`/`applyCredit` (verified same-customer by inspection, then run):
  `tests/invoices.test.ts tests/orders.test.ts tests/receipts.test.ts tests/unlock-concurrency.test.ts`
  → **207 passed** (4 files).
- `npx tsc --noEmit` → clean (exit 0).
- `npx eslint src tests` → clean (exit 0).
- `npx prisma migrate status` → "Database schema is up to date!" on both erp and erp_test.

Full suite intentionally not run here (host resource-constrained; owner runs it at merge).

---

# Round 2 — reporting (PR #74 Codex findings #6, #12, #13, #14)

Four surgical fixes in the aging/statement reporting path. The point-in-time model is unchanged.

## Fix #6 (P2) — statements omit on-account payments

Spec §8 requires every open item, including on-account payments as negatives. `buildStatement` emitted
only INVOICE (positive) and CREDIT (negative) lines, so a $1000 invoice + $200 on-account showed one
$1000 line but Total Due $800 — the paper didn't reconcile.

- `src/server/pdf/statement.ts:36` — `StatementOpenItem.kind` widened `"INVOICE" | "CREDIT"` →
  `"INVOICE" | "CREDIT" | "PAYMENT"` (the open-item table renderer is already generic; a null due date
  prints blank, same as a credit).
- `src/server/statements.ts` — `SnapshotPayment` gained `reference` + `receivedDate`;
  `readFamilySnapshot`'s payment `select` now pulls both. After the invoice/credit loop, a new loop
  pushes a NEGATIVE `kind: "PAYMENT"` line per payment whose on-account (`paymentOnAccount(amount,
  [{ amount: appliedPaymentTotal, type: "PAYMENT", … }])`) is > 0 — the SAME on-account basis
  `bucketAging` folds into `aging.unapplied` (`appliedPaymentTotal` is already the `appliedDate ≤ asOf`
  PAYMENT total; `receivedDate ≤ asOf` is guaranteed by the snapshot filter). Label = check reference,
  else "Payment on account"; date = receivedDate.
- Before: `openItems = [invoice 400]`, totalDue 100 (with a $300 on-account) — no reconcile.
  After: `openItems = [invoice 400, payment −300]`, Σ open = 100 = totalDue.
- Tests: `tests/statements.test.ts` — `onAccountPayment` helper + a $1000-invoice-partly-paid-plus-
  $300-on-account case asserting the −300 line and `Σ open === totalDue`. `tests/statement-pdf.test.ts`
  — a PAYMENT line pinned on the pdfmake DEFINITION (`allText`): "CHK-4711" and "$-300.00".

## Fix #12 (P2) — aging Excel export ignored the screen's zero-row filter

`AgingReport.tsx` hides all-zero rows; `aging/export/route.ts` exported the unfiltered `agingReport`
result, so a past as-of showed onscreen-hidden customers as $0 rows in the workbook.

- `src/lib/ar-constants.ts` — added client-safe `AGING_MONEY_FIELDS` + `isAgingRowAllZero(row)` (the
  7 money fields), so screen and export share ONE predicate and can't drift.
- `src/app/api/receivables/aging/export/route.ts:16` — `.filter((r) => !isAgingRowAllZero(r))` before
  `toXlsx`.
- `src/app/receivables/aging/AgingReport.tsx` — local `isAllZero`/`MONEY_FIELDS` replaced by the shared
  imports (behavior identical).

## Fix #13 (P1) — aging family footer double-counted children

`agingReport({ customerId: parent })` returns `[...childRows, totalRow]` where `totalRow` already sums
parent + every child; `AgingReport.tsx`'s footer summed ALL rows → parent $100 + child $200 rendered
rows [$200] with a $300 total but a $500 footer.

- `src/server/aging.ts:26` — `AgingRow` gained optional `isFamilyTotal?: boolean`; set `true` ONLY on
  the synthesized family-total row (`agingReport` children branch, ~line 256). No row VALUES changed.
  `sumRows` excludes the new key.
- `src/app/receivables/aging/AgingReport.tsx` — the family-total row is pulled out and used AS the
  footer (labeled "Family total"); leaf rows render on their own; other views sum their leaf rows. The
  displayed total now equals the family total, not the sum-of-everything. All-zero filter still applies.
- Tests: `tests/aging.test.ts` — roll-up asserts `totalRow.isFamilyTotal === true` and child rows
  `undefined`; standalone-row test asserts `undefined`.

## Fix #14 (P2) — aging snapshot read across inconsistent DB views

`readSnapshot` (aging.ts) issued its invoice/application/payment reads as separate autocommit queries;
a commit landing mid-read could mix states (cash off-account seen, the invoice reduction missed),
transiently mis-stating net.

- `src/server/aging.ts` — reads moved into `readSnapshotIn(tx, …)`; `readSnapshot` now wraps them in
  ONE `prisma.$transaction(…, { isolationLevel: RepeatableRead })`. Read-only, no writes/claims. All
  four call sites (report, family roll-up, unfiltered, `customerOwnAgingRow`) are unchanged.
- `src/server/statements.ts` — `buildStatement`'s preview reads now run inside one RepeatableRead
  transaction (the print path's Serializable bracket is strictly stronger, unchanged); `runStatements`'
  discovery (who-has-history + `readFamilySnapshot`) likewise wrapped in one RepeatableRead transaction.
- `src/server/customer-receivables.ts` — UNCHANGED: its net comes from `customerOwnAgingRow` (now
  wrapped at the source), and `openInvoicesForCustomer` pulls each invoice's applications nested in ONE
  query (atomic — no multi-read mixing shape). Verified, no wrapper needed.

## Results

- `npx vitest run tests/aging.test.ts tests/statements.test.ts tests/receivables-routes.test.ts
  tests/customer-routes.test.ts tests/statement-pdf.test.ts` → **57 passed** (5 files).
- `npx tsc --noEmit` → clean (exit 0).
- `npx eslint src tests` → clean (exit 0).
- `npm run build` → clean (exit 0; UI touched).

Full suite intentionally not run here (host resource-constrained; owner runs it at merge).

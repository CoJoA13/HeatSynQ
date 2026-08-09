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

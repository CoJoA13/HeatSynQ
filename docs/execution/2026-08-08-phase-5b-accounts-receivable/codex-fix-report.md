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

---

# Round 3 — Terms validation

## FIX #17 (P2) — validate the RESULTING Terms row when clearing a discount

`requireDiscountPair` (`src/server/reference.ts`) validates only the fields PRESENT in a PATCH, not
the row that results from applying it. On an existing `2/10 Net 30` Terms row,
`updateReference("terms", id, { discountPercent: null })` set `hasPercent = false` (explicit null)
and `hasDays = false` (key omitted, so invisible to a refine that only sees the patch) — both looked
identical to "no discount" from inside the refine, so the PATCH passed and persisted
`discountPercent = null` while the stored `discountDays = 10` was left untouched: a row violating the
advertised both-or-neither invariant.

**`src/server/reference.ts`**
- `EXTRA_SCHEMAS.terms` (`~L39-46`): `discountDays` gained `.nullable()` — before this fix an explicit
  `{ discountDays: null }` failed generic zod type validation ("expected number, received null")
  before ever reaching a discount-pair check, so clearing `discountDays` (alone or paired with
  `discountPercent: null`) had no valid input shape at all. `discountPercent` (via `decimalField`)
  was already nullable; this makes the pair symmetric.
- New `assertDiscountPairAfterUpdate(tx, id, patch)` (`~L225-251`): runs only when the parsed patch
  contains `"discountPercent"` or `"discountDays"` as an own key. Reads the current row's
  `discountPercent`/`discountDays` on the caller's own `tx`, then merges: a key ABSENT from `patch`
  (`in` false) keeps the stored value; a key PRESENT — including an explicit `null` — overrides it.
  `in`, not `?? current`, because `??` cannot distinguish "omitted" from "explicitly null" and zod's
  `.partial()` omits untouched optional keys from its parsed output entirely (verified against the
  repo's zod 4.4.3: `z.object({a,b}).partial().parse({a:null})` → `{a: null}`, no `b` key at all).
  Throws the same `"an early-pay discount needs both a percent and a day count"` 400 as
  `requireDiscountPair` when the merged `percent`/`days` presence disagrees.
- `updateReference` (`~L268`): `if (kind === "terms") await assertDiscountPairAfterUpdate(tx, id, data);`
  — placed inside the existing transaction, after the FK-link checks and before `auditedUpdate`, so a
  rejected merge never reaches the write.
- `requireDiscountPair`'s doc comment updated to describe the now-closed gap instead of documenting it
  as accepted; the create path and its call to `requireDiscountPair` are unchanged (it already
  validates the full row there, since create has no "existing row" to merge against). No other
  reference kind is touched — the new check is gated on `kind === "terms"` and the schema change
  (`discountDays.nullable()`) only affects a field that exists solely on the `terms` entry.

**Before/after** (on a stored `2/10 Net 30` row):
- Before: `updateReference("terms", id, { discountPercent: null })` → succeeded, row became
  `discountPercent: null, discountDays: 10` (broken pair).
- After: same call → `HttpError(400, "an early-pay discount needs both a percent and a day count")`;
  row unchanged (`discountPercent: 2, discountDays: 10`).
- `{ discountPercent: null, discountDays: null }` → still succeeds (both cleared together, no
  discount).
- A patch touching only `netDays` or `active` → unaffected (the new check no-ops when the patch
  contains neither discount key).

**Tests** (`tests/reference-tables.test.ts`, new `describe` block under the existing "terms: netDays +
early-pay discount" suite): on a seeded `2/10 Net 30` row — clearing only `discountPercent` → 400 and
row unchanged; clearing only `discountDays` → 400 and row unchanged; clearing both → succeeds, row
becomes no-discount; an update touching only `netDays`/`active` → unaffected, discount pair intact.
All four are non-vacuous — each reproduced a real "passes and corrupts the row" or wrong-schema-error
failure before `assertDiscountPairAfterUpdate` and the `discountDays.nullable()` change existed.

## Results

- `npx vitest run tests/reference-tables.test.ts` → **26 passed**.
- `npx vitest run tests/reference-blockers.test.ts tests/reference-gl.test.ts
  tests/reference-guards.test.ts tests/reference-links-sweep.test.ts tests/reference-names.test.ts`
  (collateral check on the shared module and the `EXTRA_SCHEMAS` schema change) → **64 passed**
  (5 files).
- `npx tsc --noEmit` → clean (exit 0).
- `npx eslint src tests` → clean (exit 0).

Full suite intentionally not run here (host resource-constrained; owner runs it at merge).

---

# Round 4 — correction-path UI

Two confirmed findings on the operator's correction path on the batch apply screen
(`src/app/receivables/batches/[id]/BatchDetail.tsx`), both about a payment that has already been
(mis-)applied. The whole-branch fix made `voidPayment` refuse a payment with live applications, so
correcting a mis-application needs both a way to SEE what a payment settled and a way to VOID it — and
separately, on-account cash must stay appliable after its batch posts.

## FIX #11 (P1-workflow) — add a UI path to void (correct) an application

A `DELETE /api/receivables/applications/[id]` route (`voidApplication`, gated `receivables.delete`)
already existed, but no screen listed or voided applications — the only way to unwind a mis-applied
payment before this fix was a direct API call.

**Server read extension — `src/server/receipts.ts`**
- New exported type `PaymentApplicationRow = { id, type, amount, invoiceId, invoiceDocumentNumber }`;
  `PaymentRow` gained `applications: PaymentApplicationRow[]`.
- `DETAIL_INCLUDE`'s `payments.applications` select widened from `{ amount, type, deletedAt }` to also
  pull `id`, `invoiceId`, and `invoice.order.orderNumber` (needed for the document number) — still
  UNFILTERED (no `where: { deletedAt: null }`), because `paymentOnAccount` still needs every
  application, live or voided, to filter internally.
- `toPaymentRow(p, prefix)` now takes the `invoice_number_prefix` setting and builds the LIVE-only
  `applications` list by filtering the same fetched array to `deletedAt === null` and mapping in the
  `invoices.ts`/`applications.ts` document-number rule (`prefix === "" ? String(orderNumber) :
  "${prefix} - ${orderNumber}"`, duplicated here per that established precedent) — a DISCOUNT/WRITE_OFF
  targets an invoice the same way a PAYMENT does, so all three read it identically (never a CREDIT —
  `applyPayment`/`applyCredit` both require the target to be `kind: "INVOICE"`).
- `readBatchDetail` reads the prefix alongside the batch row (`Promise.all`, the `statements.ts`/
  `customers.ts`/`parts.ts` parallel-tx-read precedent) and threads it into `toBatchDetail`/
  `toPaymentRow`.

**UI — `src/app/receivables/batches/[id]/BatchDetail.tsx`**
- `ApplyPanel` renders a small table under the "Payment … Applied … On account …" summary line, listing
  each live application (invoice document number, `APPLICATION_TYPE_LABELS[type]`, amount) with a
  per-row "Void" button.
- `voidApplicationAction` prompts for a reason (the `voidPaymentAction` shape), calls
  `DELETE /api/receivables/applications/<id>` with `{ reason }`, then calls the parent's `onApplied()`
  (batch refresh — the invoice's open balance and the payment's on-account are both derived, so both
  update from that one call) and its own `load()` (this payment's own apply-panel candidates).
- New prop `voidApplicationGate: Gate = gate(perms, "receivables.delete")`, computed in `BatchDetail`
  and passed down — disabled-with-tooltip (§5.16), not hidden. Deliberately NOT run through
  `statusLocked`: `voidApplication` performs no batch-status check, and correcting a misapplication is
  not editing the payment list (see FIX #7 below).

**Tests** (`tests/receipts.test.ts`, new `readBatchDetail — a payment's live applications` block): adds
a payment, finalizes an invoice, applies 100 of it as a PAYMENT, then asserts `getBatch` returns exactly
one application with the right `type`/`amount`/`invoiceId`/`invoiceDocumentNumber` (bare order number —
default blank prefix); voids it via `voidApplication` and asserts the list empties and `onAccount`
returns to 300.

## FIX #7 (P1) — allow applying on-account cash on a POSTED batch

`statusLocked` wrapped the apply controls (`moneyGate`, `writeOffGate`) with the POSTED lock, but spec
§5.2 says on-account cash "is appliable to a later invoice from the same payment at any time (even
after its batch is POSTED)" — and `applyPayment` itself performs no batch-status check, so only the UI
was blocking it.

**`src/app/receivables/batches/[id]/BatchDetail.tsx`**
- `moneyGate`/`writeOffGate` no longer wrapped in `statusLocked(..., posted)` — they are now exactly
  `applyGateRaw`/`writeOffGateCombined` (`receivables.create`, plus `write_off` for a write-off line),
  so apply/discount/write-off stay available on a POSTED batch subject only to their normal permission
  gates.
- `createPaymentGate` and `deletePaymentGate` (add-payment, void-payment) KEEP the `statusLocked` wrap —
  matching `receipts.ts`'s `refusePosted`, which does refuse those two.
- `statusLocked`'s doc comment rewritten: it locks EDITING THE PAYMENT LIST (add/void-payment) only —
  no more citing task-13-brief.md's unqualified "read-only"; now cites spec §5.2 and explains why apply
  and void-application are both deliberately excluded.

No new automated test for this one (a UI gating change with no service-layer behavior change — the
service already permitted it, per the brief's own framing); verified by reading the gate wiring and by
`npm run build` succeeding with no type errors across the removed `statusLocked` calls.

## Results

- `npx vitest run tests/receipts.test.ts tests/receivables-routes.test.ts` → **38 passed** (2 files).
- `npx tsc --noEmit` → clean (exit 0).
- `npx eslint src tests` → clean (exit 0).
- `npm run build` → clean (exit 0; UI touched).

Full suite intentionally not run here (host resource-constrained; owner runs it at merge).

### Round 2 follow-up — aging export also excludes the family-total row (re-review of #12/#13)

The export analog of the #13 screen double-count: `aging/export/route.ts` still emitted the synthesized
`isFamilyTotal` roll-up row as a flat data row beside the child rows, so summing a family-filtered
export's column double-counted the children.

- `src/app/api/receivables/aging/export/route.ts:16` — filter now drops the family-total row too:
  `.filter((r) => !r.isFamilyTotal && !isAgingRowAllZero(r))`. Export is leaf rows only, matching the
  screen's body (leaf rows + a distinct footer total). `agingReport`'s output is unchanged.
- Test: `tests/receivables-routes.test.ts` — new family-filtered export case parses the .xlsx and
  asserts the child (leaf) row is present, the parent-keyed family-total row is absent, and the sheet
  holds leaf rows only. `npx vitest run tests/receivables-routes.test.ts` → **18 passed**; `tsc` /
  `eslint src tests` clean.

# Phase 5B — Accounts Receivable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Phase 5A's finalized invoices and credits into a working A/R ledger — receive payments in balanced deposit batches, apply them to invoices (partials, terms discounts, write-offs, on-account, and credit memos, across a parent's divisions), age the open balances at any as-of date, and print/archive open-item statements with an aging summary and an optional finance-charge line.

**Architecture:** The A/R document is 5A's `Invoice`; 5B **never restates its totals**. A new **`ReceiptBatch → Payment → Application`** trio records money; a **single unified `Application` table** (typed `PAYMENT` / `DISCOUNT` / `WRITE_OFF` / `CREDIT`, source = a payment XOR a credit, enforced by a hand-written `CHECK`) is the one write path. Every balance — invoice open balance, payment on-account, credit remaining — is **derived** from live `Application` rows in a pure `ar-balances.ts`, never cached. Aging (`aging.ts`), finance charges (`finance-charges.ts`) and statement assembly (`statements.ts`) are pure over a snapshot read. Every application **claims the invoice row (order-first) before it reads the balance it guards**, exactly as 5A's invoice mutators do. Spec: `docs/superpowers/specs/2026-08-08-phase-5b-accounts-receivable-design.md` — **all bare § references below are to it; its prisma blocks are the schema contract.**

**Tech Stack:** Next.js 16 / React 19 client pages against guarded APIs, Prisma 7 (+pg adapter), zod 4, pdfmake (`PdfPrinter` Node entry), vitest against the real `erp_test` database, the bespoke Playwright harness in `e2e/`.

## Global Constraints

- All commands run from `erp/`. Quality gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` (plus `npm run build` before review rounds) — or just `/gates`. Node 26 (`nvm use 26`); `npm install`'s five skipped-install-scripts warning is expected and must not be "fixed".
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution trailers** (owner instruction; a PreToolUse hook blocks them). Attribution goes in the PR body.
- Every mutation through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete` — `tx` is REQUIRED. Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`. **This phase adds three auditable models (`ReceiptBatch`, `Payment`, `Application`) and no audit exceptions.**
- **Row locks, never isolation levels, guard cross-transaction invariants.** Every application claims the target invoice through 5A's discipline: `claimOrder(tx, orderId)` then `SELECT "id" FROM "Invoice" WHERE "id" = $1 FOR UPDATE`, before reading the open balance it acts on. A payment settling several invoices claims them all through **one sorted statement** — `claimOrdersInOrder(tx, orderIds)` (`order-locks.ts`) over the orders behind the invoices, deduplicated and ascending — never a per-invoice loop. A credit application also `FOR UPDATE`s the credit's own row, uniformly after the order claims. Transactions run Serializable because they assign registered FKs via `assertRefExists(kind, id, tx)` — **the FK-writer pattern, NOT what protects the claim.** Never present isolation as the lock.
- Never `findUnique` / `upsert` / `update` / `delete` keyed on a partial-unique column; use `findFirst({ where: { …, deletedAt: null } })`. Partial `@@unique(...)` attributes stay on **ONE line** (the sweep's regexes assume it). `ReceiptBatch.batchNumber` is deliberately plain `@unique` (allocation-only, never reissued — the `Invoice.creditNumber` precedent); add its documented exemption to the sweep in Task 1, do not "fix" it.
- `npx prisma migrate dev` refuses without a TTY. Use the `/create-migration` skill, or by hand: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output **IN FULL**, hand-write `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` **and** `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`, then `npx prisma generate`. A PreToolUse hook blocks edits to already-applied migrations. **Prisma has no `CHECK` syntax** — `Application_source_check` and the `StoredDocument` kind→owner extension are hand-written into the migration SQL (the 5A `StoredDocument_kind_owner_check` precedent).
- Client components never import from `src/server/**`; shared pure code goes in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; first line `mustCan(requireUser(), "receivables", action)` (or `mustDo(requireUser(), "write_off")` for write-offs). **`requireUser()` takes no arguments** — `handle()` publishes the session through `AsyncLocalStorage`. `assertRecord(body)` before key checks; DELETE/void reasons via `reasonFromBody`. Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored. Dates cross the wire as `"yyyy-mm-dd"` strings; use `parseDateOnly` / `formatDateOnly` / `todayDateOnly` from `src/lib/business-days.ts` and store `Date` in `@db.Date` columns.
- Tests share one database: `truncateAll()` in `beforeEach`, `signInWith(permissions)` from the test helpers. `fileParallelism: false` — do not parallelize. **Assert audit content (real diffs), not just that entries exist.**
- **A concurrency test that passes is not evidence.** Verify each by deleting the guard and watching it go red, and pin the **competing** caller to Read Committed — two Serializable transactions are ordered by SSI whether or not your lock exists (Phase 4 lesson 1).
- **Never `vi.spyOn` a Prisma model delegate** — `mockRestore()` corrupts the shared singleton for the rest of the run. Save and restore the property by hand.
- **`renderPdf` output is not byte-deterministic across calls.** Compare *stored* bytes on reprint with `Buffer.compare`; never `Buffer.compare` two fresh renders. Content pins go on the DEFINITION, not the rendered bytes; copy `allText` (`tests/cert-pdf.test.ts:25-35`) for content and `pageCount` (`tests/traveler.test.ts:61`) plus the `%PDF-` header for structure.
- Money `Decimal(12, 2)` via `decimalField(12, 2, …)`; percentages: `discountPercent` `Decimal(5, 2)` (`2` = 2%), `financeChargeRate` `Decimal(6, 4)` monthly percent (`1.5` = 1.5%/month). Quantities `z.number().int()`. **Rounding is half-up to cents; compute in integer cents where a float would bite.** Totals are sums of already-rounded lines.
- **Reads of an invoice are snapshot-first, unconditionally** (5A §5.4) — an invoice is frozen paper. A/R records against its id and its own `total`; a payment/application never re-derives or rewrites an invoice-side snapshot field.
- **When a fix lands on one member of a sibling group, enumerate the whole group in the report.** This phase's grids: the batch-apply grid, the aging report, and the statement run.
- Owner rulings binding this plan (spec §3): all four cash-application primitives; one payment → many invoices, and across a parent's children; check/card/ACH via `PaymentType`; **no prepayments** (on-account = unapplied receipt only); a credit applies to an invoice or sits on account; **a credit takes its own date**; terms-based early-pay discounts; standard aging by due date with a **separate unapplied column**; finance charges **informational-only, opt-in per run**; open-item statements, family on demand, **archived**.

## File Structure

**New server modules**

| File | Responsibility |
|---|---|
| `src/lib/ar-constants.ts` | Pure constants safe for client import: `APPLICATION_TYPES`, `RECEIPT_BATCH_STATUSES`, `AGING_BUCKETS` + their label maps |
| `src/server/ar-balances.ts` | **Pure over a snapshot read.** Invoice open balance, payment on-account, credit remaining — the one place balances are derived |
| `src/server/receipts.ts` | `ReceiptBatch` + `Payment` CRUD, post, void; the live batch balance |
| `src/server/applications.ts` | Apply/void a payment, discount, write-off, credit application under the invoice claim; the over-application and discount-window rules |
| `src/server/aging.ts` | **Pure.** Point-in-time aging into buckets + the unapplied column, per customer and per family |
| `src/server/finance-charges.ts` | **Pure.** The informational finance-charge computation |
| `src/server/statements.ts` | Assemble a statement's data, render, archive; the run |
| `src/server/pdf/statement.ts` | The statement layout builder: plain data in, pdfmake definition out |

**Modified server modules:** `prisma/schema.prisma`, `src/lib/permission-constants.ts`, `src/server/settings.ts`, `src/server/audit.ts`, `src/server/documents.ts`, `src/server/invoice-guards.ts`, `src/server/invoices.ts` (the `createCredit` date change + `dueDate` at finalize), `src/server/orders.ts` / `src/server/shippers.ts` (the new A/R-activity refusals), `src/lib/reference-links.ts`, `src/server/terms.ts`, `src/server/billing-config.ts`.

**New pages/routes:** `src/app/receivables/{page.tsx,ReceivablesList.tsx}`, `src/app/receivables/batches/[id]/{page.tsx,BatchDetail.tsx}`, `src/app/receivables/aging/{page.tsx,AgingReport.tsx}`, `src/app/receivables/statements/{page.tsx,Statements.tsx}`, `src/app/customers/[id]/ReceivablesSection.tsx`, and the API routes under `src/app/api/receivables/*` and `src/app/api/customers/[id]/receivables`.

**Task ordering rationale:** constants + schema first (everything typechecks against the generated client), then the pure leaves (`ar-balances.ts`, `aging.ts`, `finance-charges.ts`) whose exhaustive tests must exist before a database fixture can paper over a math bug, then the services that consume them (`receipts.ts`, `applications.ts`), then the cross-phase guards, then statements + the PDF, then pages, then E2E and docs.

**Task map (17):** 1 constants/permissions/settings · 2 schema + migration + registry/audit/sweeps · 3 `createCredit` date + `Invoice.dueDate` at finalize · 4 Terms & BillingConfig columns + admin UIs · 5 `ar-balances.ts` (pure) · 6 `receipts.ts` + routes · 7 `applications.ts` payment/discount/write-off/on-account + routes · 8 credit application · 9 `invoice-guards` A/R-activity + unlock/discard/void refusals · 10 `aging.ts` (pure) + route · 11 `finance-charges.ts` (pure) · 12 `statements.ts` + `pdf/statement.ts` + STATEMENT document + route · 13 `/receivables` batch entry + apply UI · 14 aging report UI · 15 statements UI + customer A/R section · 16 routes 401/403 sweep · 17 E2E + demo + docs.

---

### Task 1: `ar-constants.ts`, the `receivables` permission area, and the batch-number counter

**Files:**
- Create: `src/lib/ar-constants.ts`
- Modify: `src/lib/permission-constants.ts` (add area + special action), `src/server/settings.ts` (add the counter)
- Test: `tests/permissions.test.ts`, `tests/permissions-sweep.test.ts`, `tests/settings.test.ts`, `tests/allocate-number.test.ts`, `tests/partial-unique-sweep.test.ts`

**Interfaces:**
- Consumes: `AREAS`, `SPECIAL_ACTIONS` (`src/lib/permission-constants.ts`); `numberSeed`, `allocateNumber(key: NumberSettingKey, tx)` (`src/server/settings.ts`).
- Produces:
```ts
// src/lib/ar-constants.ts — pure, client-safe
export const APPLICATION_TYPES = ["PAYMENT", "DISCOUNT", "WRITE_OFF", "CREDIT"] as const;
export type ApplicationTypeValue = (typeof APPLICATION_TYPES)[number];
export const APPLICATION_TYPE_LABELS: Record<ApplicationTypeValue, string> = {
  PAYMENT: "Payment", DISCOUNT: "Discount", WRITE_OFF: "Write-off", CREDIT: "Credit applied",
};
export const RECEIPT_BATCH_STATUSES = ["OPEN", "POSTED"] as const;
export type ReceiptBatchStatusValue = (typeof RECEIPT_BATCH_STATUSES)[number];
export const AGING_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucketValue = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucketValue, string> = {
  CURRENT: "Current", D1_30: "1–30", D31_60: "31–60", D61_90: "61–90", D90_PLUS: "90+",
};
```
`AREAS` gains `"receivables"`; `SPECIAL_ACTIONS` gains `"write_off"`; `SettingKey` gains `"receipt_batch_number_next"` (the `_number_next` suffix is REQUIRED — `NumberSettingKey = Extract<SettingKey, \`${string}_number_next\`>` is what makes it valid for `allocateNumber`; the spec's shorthand "receipt_batch_next" maps to this).

- [ ] **Step 1: Write the failing permission test.** In `tests/permissions.test.ts`, add:
```ts
it("has a receivables area and a write_off special action", () => {
  expect(AREAS).toContain("receivables");
  expect(SPECIAL_ACTIONS).toContain("write_off");
});
```
- [ ] **Step 2: Run it — Expected: FAIL** (`AREAS` does not contain "receivables").
Run: `npx vitest run tests/permissions.test.ts -t "receivables area"`
- [ ] **Step 3: Add the area and action.** In `src/lib/permission-constants.ts` append `"receivables"` to the `AREAS` array (keep one entry per line) and `"write_off"` to `SPECIAL_ACTIONS`.
- [ ] **Step 4: Run it — Expected: PASS.**
- [ ] **Step 5: Write the failing settings test.** In `tests/allocate-number.test.ts`, add a case allocating `receipt_batch_number_next` twice and asserting it returns `1000` then `1001` (the `order_number_next` precedent already in that file).
- [ ] **Step 6: Run it — Expected: FAIL** (unknown setting key).
- [ ] **Step 7: Register the counter + create `ar-constants.ts`.** Add to `settings.ts`'s registry: `receipt_batch_number_next: { schema: numberSeed, default: 1000, label: "Next receipt-batch number", group: "Numbering" }`. Create `src/lib/ar-constants.ts` with the block above.
- [ ] **Step 8: Run it — Expected: PASS.**
- [ ] **Step 9: Extend the partial-unique sweep exemption.** `ReceiptBatch.batchNumber` (Task 2) will be plain `@unique`. In `tests/partial-unique-sweep.test.ts`, add `"ReceiptBatch.batchNumber"` to the documented allow-list beside `Invoice.creditNumber`, with the comment "allocation-only, never reissued — a voided batch keeps its number".
- [ ] **Step 10: Run the sweeps + gates.** `npx vitest run tests/permissions-sweep.test.ts tests/partial-unique-sweep.test.ts`, then `/gates`. Expected: PASS.
- [ ] **Step 11: Commit.**
```bash
git add src/lib/ar-constants.ts src/lib/permission-constants.ts src/server/settings.ts tests/
git commit -m "feat(5b): A/R constants, receivables permission area, receipt-batch counter"
```

---

### Task 2: Schema — three tables, the column additions, two `CHECK`s, registry/audit/sweeps

**Files:**
- Modify: `prisma/schema.prisma`, `src/server/audit.ts`, `src/lib/reference-links.ts`, `src/server/documents.ts`
- Create: `prisma/migrations/<timestamp>_accounts_receivable/migration.sql` (hand-written)
- Test: `tests/schema.test.ts`, `tests/reference-links-sweep.test.ts`, `tests/documents.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (the schema contract is spec §4 — copy its prisma blocks verbatim):
  - New models `ReceiptBatch`, `Payment`, `Application`; new enum `ApplicationType { PAYMENT DISCOUNT WRITE_OFF CREDIT }`.
  - `Terms` +`netDays Int @default(30)`, +`discountPercent Decimal? @db.Decimal(5,2)`, +`discountDays Int?`.
  - `Invoice` +`dueDate DateTime? @db.Date`, +`financeChargeExempt Boolean @default(false)`.
  - `BillingConfig` +`financeChargeRate Decimal? @db.Decimal(6,4)`.
  - `StoredDocument` +`customerId String?` (+ relation) for the `STATEMENT` owner; `DocumentKind` gains `STATEMENT`.
  - `ReceiptBatch.batchNumber Int @unique`; `Application` FKs `invoiceId`, `paymentId?`, `creditInvoiceId?`.

- [ ] **Step 1: Write the failing schema test.** In `tests/schema.test.ts` add a test that creates a `ReceiptBatch` → `Payment` → `Application` (type `PAYMENT`, a finalized invoice target) through `prisma`, and asserts the row reads back; and a second test asserting the `Application_source_check` rejects `type: "CREDIT"` with a `paymentId` set (expect a raw insert to throw). Use `prisma.$executeRaw` for the negative case.
- [ ] **Step 2: Run it — Expected: FAIL** (model `receiptBatch` does not exist on the client).
- [ ] **Step 3: Edit `schema.prisma`.** Paste spec §4's prisma blocks: the enum, the three models, and the column additions to `Terms`/`Invoice`/`BillingConfig`/`StoredDocument`/`DocumentKind`. Give `Application` `@@index([invoiceId])`, `@@index([paymentId])`, `@@index([creditInvoiceId])`; `Payment` `@@index([batchId])`, `@@index([customerId])`; `ReceiptBatch` `@@index([depositDate])`. Keep every `@@unique(...)` on one line.
- [ ] **Step 4: Generate the migration by hand** (no TTY — Global Constraints). Run `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read it IN FULL, and write `prisma/migrations/<timestamp>_accounts_receivable/migration.sql` from it, **appending two hand-written statements the diff cannot express**:
```sql
-- Exactly one source per application type (the StoredDocument_kind_owner_check precedent)
ALTER TABLE "Application" ADD CONSTRAINT "Application_source_check" CHECK (
  ("type" IN ('PAYMENT','DISCOUNT','WRITE_OFF') AND "creditInvoiceId" IS NULL)
  OR ("type" = 'CREDIT' AND "paymentId" IS NULL AND "creditInvoiceId" IS NOT NULL)
);
-- Extend the document kind→owner CHECK for STATEMENT (owner = customer)
ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_kind_owner_check";
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  /* …copy the existing TRAVELER/SHIPPER/BOL/CERT/INVOICE/CREDIT arms verbatim from
     20260804122700_certs_and_shipping/migration.sql, then add: */
  ("kind" = 'STATEMENT' AND "customerId" IS NOT NULL AND "orderId" IS NULL
     AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL)
);
```
Also add `UPDATE "Terms" SET "netDays" = 30 WHERE "netDays" IS NULL;` is unnecessary (the `@default(30)` covers new rows and the `ADD COLUMN … DEFAULT 30` backfills existing) — verify the diff emitted `DEFAULT 30` and, if it added the column nullable-then-default, that existing rows are backfilled.
- [ ] **Step 5: Apply to BOTH databases + regenerate.**
```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npx prisma generate
```
- [ ] **Step 6: Register the new auditable models.** In `src/server/audit.ts` add `ReceiptBatch`, `Payment`, `Application` to `AuditableModel`, and to `SNAPSHOT_INCLUDE` pull the relations that must travel in history: `Payment` → `{ paymentType: true }`; `Application` → `{ invoice: { select: { id, ... } } }` (the FK-with-live-name pattern used by 5A's invoice snapshot).
- [ ] **Step 7: Register FKs in the reference-link sweep.** In `src/lib/reference-links.ts` add `Application.invoiceId`, `Application.paymentId`, `Application.creditInvoiceId`, `Payment.batchId`, `Payment.customerId`, `Payment.paymentTypeId` so `tests/reference-links-sweep.test.ts` passes.
- [ ] **Step 8: Wire `STATEMENT` into `documents.ts`.** Add `STATEMENT: "receivables"` to `AREA_FOR_KIND`; add `| { kind: "STATEMENT"; customerId: string }` to `DocumentOwner`; extend `ownerColumns()` to map it to the `customerId` column.
- [ ] **Step 9: Run the schema test + sweeps — Expected: PASS** (both the positive round-trip and the `CHECK` rejection).
- [ ] **Step 10: Run `/gates`. Commit.**
```bash
git add prisma/ src/server/audit.ts src/lib/reference-links.ts src/server/documents.ts tests/
git commit -m "feat(5b): A/R schema — receipt batch, payment, application, terms/invoice/billing columns, STATEMENT document"
```

---

### Task 3: The two 5A invoice changes — credit date, and `dueDate` at finalize

**Files:**
- Modify: `src/server/invoices.ts` (`createCredit`, `finalizeInvoiceInTx`)
- Test: `tests/invoices.test.ts`

**Interfaces:**
- Consumes: `todayDateOnly()` (`src/lib/business-days.ts`); the customer's `terms.netDays` (Task 2 column).
- Produces: a credit's `invoiceDate` = its own creation date; a finalized `INVOICE`'s `dueDate` = `invoiceDate + terms.netDays`.

- [ ] **Step 1: Failing test — credit date.** In `tests/invoices.test.ts` `createCredit` describe, add: raise a credit against an invoice whose `invoiceDate` is 30 days ago; assert `credit.invoiceDate === formatDateOnly(todayDateOnly())`, not the source's date. (Amends the existing "copies the header" test — that one currently expects the source date; update its assertion in the same step and note the change in the commit.)
- [ ] **Step 2: Run — Expected: FAIL** (credit still carries the source's date).
- [ ] **Step 3: Change `createCredit`.** In the `invoice.create` data and the `auditData`, set `invoiceDate: todayDateOnly()` (import already present as `todayDateOnly` via `deps.today` in create; `createCredit` has no `deps`, so call `todayDateOnly()` directly at the service boundary). Everything else copies verbatim.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — dueDate.** Add: a customer on Net 30 terms, finalize an invoice dated `2026-08-01`; assert `invoice.dueDate === "2026-08-31"`. A customer with no terms → `dueDate` null.
- [ ] **Step 6: Run — Expected: FAIL** (`dueDate` is null / column unread).
- [ ] **Step 7: Compute `dueDate` in `finalizeInvoiceInTx`.** After the `needsPrice` guard, read `order.customer.terms.netDays` (extend the customer select already in the claim path), and for an `INVOICE` (not a `CREDIT`) set `data: { status: "FINALIZED", finalizedAt, finalizedById, dueDate: addDays(invoice.invoiceDate, netDays) }`. Add a small `addDays(date, n)` to `business-days.ts` if absent (a date-only add, no business-day skipping — a due date is a calendar date). `netDays` null → `dueDate` stays null.
- [ ] **Step 8: Run — Expected: PASS.** Then `/gates`.
- [ ] **Step 9: Commit.**
```bash
git add src/server/invoices.ts src/lib/business-days.ts tests/invoices.test.ts
git commit -m "feat(5b): credit takes its own date; invoice dueDate set at finalize from terms.netDays"
```

---

### Task 4: `Terms` and `BillingConfig` columns wired through their admin screens

**Files:**
- Modify: `src/server/terms.ts` (or the reference service that owns Terms), `src/server/billing-config.ts`, `src/app/admin/billing/page.tsx`, the Terms admin page/section
- Test: `tests/settings.test.ts` (or `tests/billing-config.test.ts`), the reference/terms test

**Interfaces:**
- Consumes: the existing reference/Terms CRUD and `getBillingConfig`/`updateBillingConfig`.
- Produces: Terms carrying `netDays` (required, default 30) + optional `discountPercent`/`discountDays`; `BillingConfig.financeChargeRate` read/written.

- [ ] **Step 1: Failing test — Terms discount validation.** A Terms zod schema test: `netDays` required int ≥ 0; a discount is all-or-nothing — supplying `discountPercent` without `discountDays` (or vice versa) is a 400 "an early-pay discount needs both a percent and a day count"; `2/10/30` round-trips.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Extend the Terms schema/service.** Add `netDays` (`z.number().int().min(0)`, default 30), `discountPercent`/`discountDays` (`decimalField(5,2)` / `z.number().int().min(1)`, both optional) with a `.refine` enforcing both-or-neither. Persist through the existing audited path.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — plant FC rate.** `billing-config.test.ts`: set `financeChargeRate` to `1.5`, read it back as `1.5`; reject a negative.
- [ ] **Step 6: Run — Expected: FAIL.**
- [ ] **Step 7: Add `financeChargeRate` to the `BillingConfig` zod registry** (`decimalField(6,4,{min:"nonnegative"})`, optional) and its read/write.
- [ ] **Step 8: Run — Expected: PASS.**
- [ ] **Step 9: Add the UI fields.** Terms admin gains `netDays` + the two discount inputs (with the both-or-neither hint); Admin → Billing gains a "Finance charge (monthly %)" input bound to `financeChargeRate`. Follow the existing field patterns on those pages; no new components.
- [ ] **Step 10: `/gates`, then verify in the browser** (preview: Admin → Billing shows and saves the rate; Terms saves `2/10 Net 30`). Commit.
```bash
git add src/server/terms.ts src/server/billing-config.ts src/app/admin/ tests/
git commit -m "feat(5b): terms netDays + early-pay discount, plant finance-charge rate, and their admin fields"
```

---

### Task 5: `ar-balances.ts` — the pure balance derivations

**Files:**
- Create: `src/server/ar-balances.ts`
- Test: `tests/ar-balances.test.ts`

**Interfaces:**
- Consumes: `ApplicationTypeValue` (`src/lib/ar-constants.ts`).
- Produces (pure, integer-cent math, no Prisma):
```ts
export type ApplicationLite = { amount: number; type: ApplicationTypeValue; deletedAt: Date | null };
/** Invoice open balance = total − Σ live applications against it. */
export function invoiceOpenBalance(total: number, apps: ApplicationLite[]): number;
/** Payment on-account = amount − Σ live PAYMENT-type applications sourced from it. */
export function paymentOnAccount(amount: number, apps: ApplicationLite[]): number;
/** Credit remaining = |total| − Σ live applications sourced from it. */
export function creditRemaining(total: number, apps: ApplicationLite[]): number;
```

- [ ] **Step 1: Write the failing tests** (exhaustive — the money core):
```ts
const live = (amount: number, type: ApplicationTypeValue): ApplicationLite => ({ amount, type, deletedAt: null });
it("open balance subtracts every live application type", () => {
  expect(invoiceOpenBalance(1000, [live(300, "PAYMENT"), live(50, "DISCOUNT"), live(20, "WRITE_OFF"), live(100, "CREDIT")])).toBe(530);
});
it("open balance ignores voided applications", () => {
  expect(invoiceOpenBalance(1000, [{ amount: 400, type: "PAYMENT", deletedAt: new Date() }])).toBe(1000);
});
it("on-account counts only live PAYMENT applications", () => {
  expect(paymentOnAccount(500, [live(300, "PAYMENT"), live(50, "DISCOUNT")])).toBe(200);
});
it("credit remaining uses the credit's absolute total", () => {
  expect(creditRemaining(-937.44, [live(100, "CREDIT")])).toBe(837.44);
});
it("rounds in cents — no float drift", () => {
  expect(invoiceOpenBalance(0.3, [live(0.1, "PAYMENT")])).toBe(0.2);
});
```
- [ ] **Step 2: Run — Expected: FAIL** (module not found).
- [ ] **Step 3: Implement** with a shared `cents = (n) => Math.round(n * 100)` helper and integer-cent sums, dividing by 100 once at the end.
- [ ] **Step 4: Run — Expected: PASS** (all five).
- [ ] **Step 5: Commit.**
```bash
git add src/server/ar-balances.ts tests/ar-balances.test.ts
git commit -m "feat(5b): pure A/R balance derivations (open balance, on-account, credit remaining)"
```

---

### Task 6: `receipts.ts` — batches and payments, post and void

**Files:**
- Create: `src/server/receipts.ts`, `src/app/api/receivables/batches/route.ts`, `src/app/api/receivables/batches/[id]/route.ts`, `src/app/api/receivables/batches/[id]/payments/route.ts`, `src/app/api/receivables/batches/[id]/payments/[paymentId]/route.ts`
- Test: `tests/receipts.test.ts`, `tests/receivables-routes.test.ts`

**Interfaces:**
- Consumes: `allocateNumber("receipt_batch_number_next", tx)`, `auditedCreate/Update/SoftDelete`, `withDbErrors`, `assertRefExists`, `parseDate`.
- Produces:
```ts
export type BatchDetail = { id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number; notes: string;
  payments: PaymentRow[]; deletedAt: string | null };
export type PaymentRow = { id: string; customerId: string; customerCode: string; customerName: string;
  paymentTypeId: string; paymentTypeName: string; amount: number; reference: string; receivedDate: string;
  onAccount: number };
export async function createBatch(input: unknown): Promise<BatchDetail>;
export async function getBatch(id: string): Promise<BatchDetail>;
export async function addPayment(batchId: string, input: unknown): Promise<BatchDetail>;   // refuses a POSTED batch
export async function voidPayment(batchId: string, paymentId: string, reason: string): Promise<BatchDetail>;
export async function postBatch(id: string): Promise<BatchDetail>;   // OPEN→POSTED, refuses if already POSTED
export async function voidBatch(id: string, reason: string): Promise<void>;   // refuses if it has live payments — void those first
```
`enteredTotal` = Σ live payment amounts; `balance` = `(controlTotal ?? enteredTotal) − enteredTotal` (zero when it foots or no control total set).

- [ ] **Step 1: Failing test — create + add payment + live balance.** Create a batch with `controlTotal 500`; add a payment of `300`; assert `enteredTotal 300`, `balance 200`. Add another of `200`; assert `balance 0`.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `createBatch`/`getBatch`/`addPayment`** — Serializable `$transaction`, `allocateNumber` under the transaction for `batchNumber`, `assertRefExists("customer", …)` / `assertRefExists("paymentType", …)` on a payment (the FK-writer pattern), audited. On-account per payment via `ar-balances.paymentOnAccount` over its (initially empty) applications.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — post locks payment entry.** Post an OPEN batch; assert `status POSTED`; `addPayment` on it now throws 400 "This batch is posted — reopen or void a payment to change it". A second `postBatch` throws 400 "already posted".
- [ ] **Step 6: Run — Expected: FAIL.**
- [ ] **Step 7: Implement `postBatch`** under the batch claim (`SELECT … FROM "ReceiptBatch" WHERE id=$1 FOR UPDATE`), audited; `addPayment`/`voidPayment` refuse a POSTED batch read under the claim.
- [ ] **Step 8: Failing test — void.** `voidPayment` with a reason soft-deletes it and drops it from `enteredTotal`; `voidBatch` with live payments throws "void its payments first"; with none, soft-deletes with the reason in the audit entry.
- [ ] **Step 9: Implement the voids** (`auditedSoftDelete`, reason trimmed in the service — the `discardInvoice` precedent). Run — Expected: PASS.
- [ ] **Step 10: Routes.** Thin `handle` wrappers gating on `receivables.create`/`edit`/`delete`; `reasonFromBody` for the voids. Add the happy-path + 403 cases to `receivables-routes.test.ts`.
- [ ] **Step 11: `/gates`. Commit.**
```bash
git add src/server/receipts.ts src/app/api/receivables/batches/ tests/
git commit -m "feat(5b): receipt batches and payments — create, add, post, void, live balance"
```

---

### Task 7: `applications.ts` — apply a payment, discount, write-off, and on-account

**Files:**
- Create: `src/server/applications.ts`, `src/app/api/receivables/applications/route.ts`, `src/app/api/receivables/applications/[id]/route.ts`
- Test: `tests/applications.test.ts`, `tests/applications-concurrency.test.ts`

**Interfaces:**
- Consumes: `claimInvoiceRow`/`claimOrdersInOrder` (`invoices.ts`/`order-locks.ts`), `ar-balances.*`, the payment's terms (for the discount window), `auditedCreate/SoftDelete`.
- Produces:
```ts
// one call applies a payment across one or more invoices in a single claim
export async function applyPayment(input: {
  paymentId: string;
  lines: { invoiceId: string; type: "PAYMENT" | "DISCOUNT" | "WRITE_OFF"; amount: number; reason?: string }[];
}): Promise<void>;
export async function voidApplication(id: string, reason: string): Promise<void>;   // restores balances
export async function discountAvailable(paymentId: string, invoiceId: string): Promise<number>;   // 0 when out of window / no terms discount
```

- [ ] **Step 1: Failing test — partial payment + open balance.** A finalized invoice of `1000`; a payment of `600`; `applyPayment` one `PAYMENT` line of `600`; assert the invoice open balance is `400` and the payment on-account is `0`. Apply another `600` → **refused** 400 "exceeds the invoice's open balance of 400".
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement the claim + write.** Serializable `$transaction`; collect the target invoices' order ids and `claimOrdersInOrder(tx, orderIds)` (one sorted statement), then `FOR UPDATE` each invoice row; read each invoice's live applications; refuse if a line would push `Σ applications > invoice.total` (over-application) or `Σ PAYMENT lines > payment.amount`; `auditedCreate` each `Application` with `appliedDate = payment.receivedDate` (the A/R-effective date aging's point-in-time filter reads — Task 10; a standalone bad-debt write-off with no payment uses `todayDateOnly()`). The unapplied remainder is on-account by construction (no write).
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — discount window.** Terms `2/10 Net 30`; invoice dated today; a payment received today; `discountAvailable` returns `2% × the settled amount`; the same invoice with a payment received 20 days later returns `0`. Applying a `DISCOUNT` line outside the window is refused 400 "no early-pay discount applies".
- [ ] **Step 6: Run — Expected: FAIL.**
- [ ] **Step 7: Implement `discountAvailable` + the DISCOUNT guard** — eligible iff the terms carry a discount and `payment.receivedDate ≤ invoice.invoiceDate + discountDays`; amount = `round(discountPercent/100 × settledAmount)`.
- [ ] **Step 8: Failing test — write-off needs a reason and the `write_off` action.** A `WRITE_OFF` line with no reason → 400 "a write-off needs a reason"; with a reason it reduces the open balance and the reason is in the audit entry. (Route-level `write_off` gating is Task 16's sweep; assert the service records the reason here.)
- [ ] **Step 9: Implement WRITE_OFF** (reason required, trimmed). Run — Expected: PASS.
- [ ] **Step 10: Failing test — void restores.** `voidApplication` on the `600` PAYMENT restores the invoice to `1000` open and the payment to `600` on-account.
- [ ] **Step 11: Implement `voidApplication`** (`auditedSoftDelete` under the invoice claim). Run — Expected: PASS.
- [ ] **Step 12: Concurrency test — two applications on one invoice.** In `applications-concurrency.test.ts`: open two manual transactions, both apply against a `1000` invoice with `700` each; the second must see the first's committed row and refuse (not both succeed to `1400`). **Verify RED** by commenting out the `FOR UPDATE` claim and pinning the competing tx to Read Committed (Global Constraints). Run — Expected: PASS with the claim, FAIL without.
- [ ] **Step 13: Routes + `/gates`. Commit.**
```bash
git add src/server/applications.ts src/app/api/receivables/applications/ tests/
git commit -m "feat(5b): apply payments, discounts, write-offs across invoices under one sorted claim"
```

---

### Task 8: Credit application

**Files:**
- Modify: `src/server/applications.ts`, `src/app/api/receivables/credit-applications/route.ts`
- Test: `tests/applications.test.ts`

**Interfaces:**
- Produces:
```ts
export async function applyCredit(input: { creditInvoiceId: string; invoiceId: string; amount: number }): Promise<void>;
```

- [ ] **Step 1: Failing test.** A finalized credit of `-500` (remaining `500`); a finalized invoice of `1000`; `applyCredit` `300` → invoice open `700`, credit remaining `200`. Over the credit's remaining → refused "exceeds the credit's remaining of 200". Over the invoice's open balance → refused. A DRAFT credit source → refused "only a finalized credit can be applied".
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `applyCredit`.** Claim the target invoice's order+row AND the credit's own row `FOR UPDATE` (uniformly after the order claims — the credit is a second guarded balance, Global Constraints); read both live-application sums; refuse over-application on either side; `auditedCreate` an `Application` `{ type: "CREDIT", invoiceId, creditInvoiceId, paymentId: null, amount, appliedDate: todayDateOnly() }` (the `Application_source_check` enforces the null payment).
- [ ] **Step 4: Run — Expected: PASS.** Route gates on `receivables.create`.
- [ ] **Step 5: `/gates`. Commit.**
```bash
git add src/server/applications.ts src/app/api/receivables/credit-applications/ tests/
git commit -m "feat(5b): apply a finalized credit memo to an invoice, both balances guarded"
```

---

### Task 9: `invoice-guards` A/R-activity + the unlock / discard / void refusals

**Files:**
- Modify: `src/server/invoice-guards.ts`, `src/server/invoices.ts` (`unlockInvoice`, `discardInvoice`), `src/server/orders.ts` (`voidOrder`)
- Test: `tests/invoice-guards.test.ts`, `tests/invoices.test.ts`, `tests/orders.test.ts`

**Interfaces:**
- Produces:
```ts
export async function hasReceivableActivity(tx: Prisma.TransactionClient, invoiceId: string): Promise<boolean>;
```
A live `Application` exists whose `invoiceId` = this OR whose `creditInvoiceId` = this (a credit that has been applied is also "active" paper).

- [ ] **Step 1: Failing test.** Finalize an invoice, apply a payment; `unlockInvoice` now throws 400 "Invoice #N has payments applied — void them before unlocking"; `discardInvoice` (after unlock is blocked, test a draft-with-activity path via a credit) similarly refuses; `voidOrder` on the order throws "an invoice on this order has A/R activity". Voiding the application re-permits all three.
- [ ] **Step 2: Run — Expected: FAIL** (unlock still succeeds).
- [ ] **Step 3: Implement `hasReceivableActivity`** as a dependency-free query in the leaf (no import of `invoices.ts`), then call it under the existing order claim in `unlockInvoice`/`discardInvoice`/`voidOrder`, throwing the field-anchored 400.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Concurrency test — apply racing unlock.** Two transactions: one applies a payment, one unlocks; the unlock must refuse or the apply must, never both commit. Verify RED with the guard removed, competing caller Read Committed.
- [ ] **Step 6: `/gates`. Commit.**
```bash
git add src/server/invoice-guards.ts src/server/invoices.ts src/server/orders.ts tests/
git commit -m "feat(5b): refuse unlock/discard/void-order once an invoice has live A/R activity"
```

---

### Task 10: `aging.ts` — point-in-time aging into buckets + the unapplied column

**Files:**
- Create: `src/server/aging.ts`, `src/app/api/receivables/aging/route.ts`, `src/app/api/receivables/aging/export/route.ts`
- Test: `tests/aging.test.ts`, `tests/receivables-routes.test.ts`

**Interfaces:**
- Consumes: `ar-balances.*`, `AGING_BUCKETS`, `parseDate`/`formatDateOnly`.
- Produces:
```ts
export type AgingRow = { customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number };   // net = buckets − unapplied
type Snapshot = {
  invoices: { id: string; customerId: string; kind: "INVOICE" | "CREDIT"; total: number;
    dueDate: string | null; finalizedAt: string | null }[];
  applications: { invoiceId: string; creditInvoiceId: string | null; type: ApplicationTypeValue;
    amount: number; appliedDate: string }[];
  payments: { customerId: string; amount: number; appliedPaymentTotal: number }[]; };
/** PURE. Buckets each finalized INVOICE's open balance by dueDate vs asOf; open credit remaining +
 *  payment on-account go to `unapplied`. Only invoices finalized ≤ asOf and applications
 *  appliedDate ≤ asOf are counted (point-in-time reconstruction). */
export function bucketAging(snap: Snapshot, asOf: string, customers: CustomerRef[]): AgingRow[];
export async function agingReport(filter: { customerId?: string; asOf?: string }): Promise<AgingRow[]>;
```

- [ ] **Step 1: Failing test — buckets by due date.** Two finalized invoices for one customer: one due 15 days before `asOf` (→ `d1_30`), one due 40 days before (→ `d31_60`), each open `1000`; assert the row's buckets. An invoice due after `asOf` → `current`.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `bucketAging`** — pure, integer-cent. `daysPastDue = asOf − dueDate`; `≤0 → current`, `1..30 → d1_30`, …, `>90 → d90_plus`. Open credit remaining and payment on-account sum into `unapplied`; `net = Σ buckets − unapplied`.
- [ ] **Step 4: Failing test — point-in-time.** An invoice finalized AFTER `asOf` is excluded entirely; an application dated after `asOf` doesn't reduce the balance. Re-running with `asOf = today` includes both. Assert the same fixture ages differently at two `asOf` dates.
- [ ] **Step 5: Run both — Expected: PASS** (add the finalized-≤-asOf and appliedDate-≤-asOf filters).
- [ ] **Step 6: Failing test — family roll-up.** A parent + two children each with a `500` past-due invoice; `agingReport({ customerId: parent })` returns the family combined into the parent's row (or a per-child breakdown with a family total — return per-child rows plus a synthesized family total row keyed on the parent). Assert the family total.
- [ ] **Step 7: Implement `agingReport`** — read the snapshot (finalized invoices, live applications, payments for the customer/family), call `bucketAging`. Run — Expected: PASS.
- [ ] **Step 8: Routes** (JSON + an Excel export via the existing tsv/export helper, the `parts/export` precedent), gated on `receivables.view`. `/gates`. Commit.
```bash
git add src/server/aging.ts src/app/api/receivables/aging/ tests/
git commit -m "feat(5b): point-in-time aging into buckets with a separate unapplied column, family roll-up"
```

---

### Task 11: `finance-charges.ts` — the informational computation

**Files:**
- Create: `src/server/finance-charges.ts`
- Test: `tests/finance-charges.test.ts`

**Interfaces:**
- Produces (pure):
```ts
export type FinanceChargeInput = { pastDueBalances: { open: number; exempt: boolean }[]; rate: number };
/** FC = round( Σ(non-exempt, past-due open) × rate/100 ). rate is a monthly percent. Zero when rate
 *  is null/0 or nothing is past due. */
export function financeCharge(input: FinanceChargeInput): number;
export function financeChargeRateFor(customerRate: number | null, plantRate: number | null): number | null;
```

- [ ] **Step 1: Failing tests.** `financeCharge({ pastDueBalances: [{open:1000,exempt:false},{open:500,exempt:true}], rate: 1.5 })` → `15.00` (only the non-exempt 1000 × 1.5%). Rate `null` → `0`. `financeChargeRateFor(2, 1.5)` → `2` (override wins); `financeChargeRateFor(null, 1.5)` → `1.5`; `financeChargeRateFor(null, null)` → `null`.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** — integer-cent, exempt filtered, override-else-plant.
- [ ] **Step 4: Run — Expected: PASS. Commit.**
```bash
git add src/server/finance-charges.ts tests/finance-charges.test.ts
git commit -m "feat(5b): pure informational finance-charge computation with per-customer rate override"
```

---

### Task 12: `statements.ts` + `pdf/statement.ts` + the STATEMENT document + route

**Files:**
- Create: `src/server/statements.ts`, `src/server/pdf/statement.ts`, `src/app/api/receivables/statements/route.ts`, `src/app/api/receivables/statements/run/route.ts`
- Test: `tests/statements.test.ts`, `tests/statement-pdf.test.ts`

**Interfaces:**
- Consumes: `aging.agingReport`, `ar-balances.*`, `finance-charges.*`, `invoicePrintSettings` (remit-to/company, 5A §10), `renderPdf`, `storeDocument({ kind: "STATEMENT", customerId }, pdf)`, `getDocument` (reprint).
- Produces:
```ts
export type StatementData = { asOf: string; company: {...}; remitTo: {...};
  customer: { code: string; name: string; billTo: string[] };
  openItems: { documentNumber: string; date: string; dueDate: string | null; kind: "INVOICE" | "CREDIT";
    original: number; open: number }[];
  aging: AgingRow; financeCharge: number | null; totalDue: number };
export async function buildStatement(customerId: string, opts: { asOf?: string; combineFamily: boolean; assessFinanceCharges: boolean }): Promise<StatementData>;
export async function printStatement(customerId: string, opts): Promise<{ documentId: string; pdf: Buffer }>;  // render + archive
export async function runStatements(opts: { asOf?: string; assessFinanceCharges: boolean }): Promise<{ customerId: string; documentId: string }[]>;  // everyone with an open balance
```

- [ ] **Step 1: Failing test — open-item assembly.** A customer with a finalized `1000` invoice partly paid (`open 400`), an open credit (`remaining 200`), on a Net-30 term 40 days past due; `buildStatement` returns the open item with `open 400`, an unapplied `−200`, the aging summary (`d31_60 400`, `unapplied 200`, `net 200`), `totalDue 200`, and `financeCharge null` (not assessed).
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `buildStatement`** — read the customer's (or family's, `combineFamily`) finalized invoices + live applications + payments; compose open items via `ar-balances`; the aging via `agingReport`; `financeCharge` only when `assessFinanceCharges` and non-exempt past-due exists; remit-to via `invoicePrintSettings`.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — FC assessed.** Same fixture with `assessFinanceCharges: true` and a plant rate `1.5` → `financeCharge = round(400 × 1.5%) = 6.00` on the statement.
- [ ] **Step 6: Run — Expected: PASS.**
- [ ] **Step 7: Failing test — print archives + reprint is byte-exact.** `printStatement` stores a `STATEMENT` document owned by the customer; a second call to `getDocument` returns the SAME stored bytes (`Buffer.compare === 0`). Pin content on the pdfmake DEFINITION (`allText`), never on two fresh renders (Global Constraints).
- [ ] **Step 8: Implement `pdf/statement.ts`** (plain data → pdfmake definition: header, remit-to, open-item table, aging strip, optional FC line, total due) and `printStatement` (the 5A four-print bracket: settings outside the tx → render → `storeDocument` on `tx`). `runStatements` iterates customers with a nonzero net.
- [ ] **Step 9: Run — Expected: PASS.** Routes gate on `receivables.view` (build/print) — the run on `receivables.create`. `/gates`. Commit.
```bash
git add src/server/statements.ts src/server/pdf/statement.ts src/app/api/receivables/statements/ tests/
git commit -m "feat(5b): open-item statements — assemble, render, archive, run; family and finance-charge options"
```

---

### Task 13: `/receivables` — the batch worklist and the batch-entry + apply screen

**Files:**
- Create: `src/app/receivables/{page.tsx,ReceivablesList.tsx}`, `src/app/receivables/batches/[id]/{page.tsx,BatchDetail.tsx}`
- Modify: `src/components/Shell.tsx` (nav entry, gated on `receivables.view`)
- Test: covered by the E2E flow (Task 17); no unit test for the client component (the 5A `InvoicingList`/`InvoiceDetail` precedent — client pages are exercised by E2E, not vitest)

**Interfaces:** consumes the Task 6/7/8 routes. Follows 5A's `InvoiceDetail.tsx` binding-state model verbatim (the `key={id}` remount, `useMutationGate`, `useEditGuard`, `useBulkGrid`, `gate`/`gateDo` from `permission-ui`).

- [ ] **Step 1: Worklist.** `ReceivablesList.tsx` (client): open batches + a filter, each row linking to `/receivables/batches/[id]`; a "New batch" action (deposit date + optional control total) gated on `gate(perms, "receivables.create")`.
- [ ] **Step 2: Batch detail + apply grid.** `BatchDetail.tsx`: the batch header with the **live balance**; a payments table (add payment: payer customer, payment type, amount, check #); per payment an **apply panel** listing the payer's — and, when the payer has a parent/children, the family's — open finalized invoices, with an amount input, a "take discount" affordance shown only when `discountAvailable > 0`, and a write-off input (reason required) gated additionally on `gateDo(perms, "write_off")`; the unapplied remainder shown as on-account. Money controls gated on `receivables.edit`; a POSTED batch renders read-only (the 5A `statusLocked` shape). Post and void buttons with reason prompts.
- [ ] **Step 3: Nav.** Add "Receivables" to `Shell.tsx`, gated on `receivables.view`.
- [ ] **Step 4: Verify in the browser** (preview: create a batch, add a payment, apply a partial + a discount + a write-off, watch the balance and on-account update). Screenshot for the report.
- [ ] **Step 5: Commit.**
```bash
git add src/app/receivables/ src/components/Shell.tsx
git commit -m "feat(5b): receivables worklist + batch entry and apply screen"
```

---

### Task 14: The aging report screen

**Files:**
- Create: `src/app/receivables/aging/{page.tsx,AgingReport.tsx}`
- Test: E2E (Task 17)

- [ ] **Step 1: Report.** `AgingReport.tsx` (client, gated on `receivables.view`): an as-of date picker (default today) + a customer/family filter; a table of `AgingRow`s (the five buckets + Unapplied + Net), a totals footer, and an **Excel export** button hitting the export route. Reuse the parts/customers list styling.
- [ ] **Step 2: Verify in the browser** (preview: the fixture from Task 10 ages correctly; changing the as-of date re-buckets). Screenshot.
- [ ] **Step 3: Commit.**
```bash
git add src/app/receivables/aging/
git commit -m "feat(5b): A/R aging report screen with as-of date and Excel export"
```

---

### Task 15: The statements screen + the customer A/R section

**Files:**
- Create: `src/app/receivables/statements/{page.tsx,Statements.tsx}`, `src/app/customers/[id]/ReceivablesSection.tsx`
- Modify: `src/app/customers/[id]/page.tsx` (mount the section)
- Test: E2E (Task 17)

- [ ] **Step 1: Statements screen.** `Statements.tsx` (client, `receivables.view`): pick a customer/family + as-of date + the **combined/per-division** choice + the **assess-finance-charges** toggle (off by default); Print (single) and a "Run for everyone with a balance" action; a documents list of archived statements (the 5A `InvoiceDocumentsList` precedent, links to `/api/documents/<id>`).
- [ ] **Step 2: Customer A/R section.** `ReceivablesSection.tsx` on the customer page: the customer's net balance and open items, with an inline aging strip and a "Statement" / "Apply payment" link — the order-hub `InvoicesSection` precedent (5A).
- [ ] **Step 3: Verify in the browser** (preview: print a combined family statement with an FC line; confirm it archives and reprints from Documents). Screenshot.
- [ ] **Step 4: Commit.**
```bash
git add src/app/receivables/statements/ src/app/customers/
git commit -m "feat(5b): statements screen (single + run, family, FC toggle) and customer A/R section"
```

---

### Task 16: Routes — the 401/403 permission sweep

**Files:**
- Modify: the `src/app/api/receivables/**` routes as needed
- Test: `tests/receivables-routes.test.ts`, `tests/permissions-sweep.test.ts`

- [ ] **Step 1: Sweep test.** For every `receivables` route assert: no session → 401; a session lacking the area/action → 403; write-off routes additionally 403 without `write_off`. The `permissions-sweep` (routes call `requireUser`, admin/area gating, `audit.ts` sole writer) stays green with the new module.
- [ ] **Step 2: Run — Expected: FAIL** on any gap; fix the offending route's `mustCan`/`mustDo` first line.
- [ ] **Step 3: Run — Expected: PASS. `/gates`. Commit.**
```bash
git add src/app/api/receivables/ tests/
git commit -m "test(5b): 401/403 sweep across the receivables routes"
```

---

### Task 17: E2E flow, demo walkthrough, and docs

**Files:**
- Create: `e2e/flows/receivables-apply-age-statement.mjs`
- Modify: `e2e/run.mjs` (register the flow), `e2e/lib/db-fixtures.ts` (A/R fixtures)
- Create: `docs/2026-08-08-phase-5b-demo.md`
- Modify: `docs/HANDOFF.md` (§4 current-phase note while in flight; the merged paragraph waits for the PR)
- Test: `npm run test:e2e`

- [ ] **Step 1: The north-star flow.** `receivables-apply-age-statement.mjs`: seed a shipped→invoiced order, finalize the invoice; create a batch, add a check, apply a **partial payment + an early-pay discount + a small write-off** leaving an **on-account** remainder; open the **aging** report and assert the invoice sits in the right bucket with the unapplied column populated; **print a statement** (combined family, FC assessed) and confirm it archives and reappears in Documents. Clean the A/R fixtures in teardown (the harness rule).
- [ ] **Step 2: Run `npm run test:e2e` — Expected: the new flow + all prior flows PASS** (16 + 1).
- [ ] **Step 3: Demo doc.** `docs/2026-08-08-phase-5b-demo.md` in the 5A demo's shape: what it delivers, how to watch it live, and any deviations that need an owner ruling (e.g. the batch POSTED lifecycle if the owner wants it trimmed; discount-on-partial-payment basis).
- [ ] **Step 4: HANDOFF note.** Update §4's current-phase block to "Phase 5B in flight" with the three binding docs (spec, this plan, the execution ledger `docs/execution/2026-08-08-phase-5b-accounts-receivable/`).
- [ ] **Step 5: Commit.**
```bash
git add e2e/ docs/2026-08-08-phase-5b-demo.md docs/HANDOFF.md
git commit -m "test(5b): E2E apply→age→statement flow; demo doc; handoff current-phase note"
```

---

## Review and merge

After Task 17, run the plan's own closing sequence — the process that has held for five phases:

1. **Whole-branch review on the strongest model** — spec compliance (§3 rulings, §16 non-goals, §17 5C hooks all honored) + code quality; verdict recorded in the execution ledger.
2. **One fix wave**, then a scoped re-review. The owner-ratified **stopping rule** (CLAUDE.md): from round 6 on, findings triage to issues unless they are correctness, concurrency, or data-integrity defects.
3. **The owner demo** (`docs/2026-08-08-phase-5b-demo.md`) — rule on any flagged deviations.
4. **Gates green** (`npm test`, `tsc`, `eslint`, `build`, `npm run test:e2e`), then the **PR** with attribution in the body (never a commit trailer), squash-merged.
5. **Post-merge:** condense §4a into HANDOFF's "Merged, in build order" as one paragraph, move the narrative to `docs/history/2026-08-08-phase-5b-accounts-receivable.md`, and activate §9 as the **5C** kickoff (month-end close + QBO export).

**Watch-items carried from the design (verify these did not regress at review):**
- No balance is ever cached on `Invoice` — every figure derives from live `Application` rows (spec §4.2).
- Every application claims the invoice row before reading the balance it guards; multi-invoice writes use one sorted `claimOrdersInOrder` statement (`EXPLAIN` shows `LockRows` above `Sort`).
- The `Application_source_check` and the extended `StoredDocument` kind→owner `CHECK` match their schema comments.
- Finance charges are never posted — informational only; 5C inherits nothing to post (spec §17).
- Concurrency tests were verified RED with their guard removed and the competing caller pinned to Read Committed.

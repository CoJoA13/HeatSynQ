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


## Task 1: Data model, migration, audit + counter registration

**Files:**
- Modify: `erp/prisma/schema.prisma`
- Create: `erp/prisma/migrations/<timestamp>_phase_5c_close_and_gl_export/migration.sql`
- Modify: `erp/src/server/audit.ts`, `erp/src/server/settings.ts`
- Modify: `erp/tests/partial-unique-sweep.test.ts`
- Test: `erp/tests/close-periods.test.ts` (smoke only in this task)

**Interfaces:**
- Produces: models `ClosePeriod`, `GlExportBatch`, `GlPosting`; `BillingConfig.arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId`; the `gl_export_batch_number_next` `NumberSettingKey`. Statuses are plain `String` columns (the `ReceiptBatch.status` precedent), values defined in `gl-constants.ts` (Task 3) — **no Prisma enum**.

- [ ] **Step 1: Add the three models + BillingConfig columns to `schema.prisma`.** Append the models and extend `BillingConfig` + `GlAccount`:

```prisma
model ClosePeriod {
  id             String    @id @default(cuid())
  year           Int
  month          Int // 1-12
  status         String    @default("CLOSED") // CLOSED | REOPENED (gl-constants.ts)
  // Frozen continuity schedule (§4.1). Beginning = prior close's ending; first = 0.
  beginningAr    Decimal   @db.Decimal(12, 2)
  invoicedTotal  Decimal   @db.Decimal(12, 2)
  creditTotal    Decimal   @db.Decimal(12, 2)
  paymentTotal   Decimal   @db.Decimal(12, 2)
  discountTotal  Decimal   @db.Decimal(12, 2)
  writeOffTotal  Decimal   @db.Decimal(12, 2)
  endingAr       Decimal   @db.Decimal(12, 2)
  agingEndingAr  Decimal   @db.Decimal(12, 2) // aging net at period end, for the §6 variance
  closedAt       DateTime  @default(now())
  closedById     String?
  closedBy       User?     @relation(fields: [closedById], references: [id])
  reopenedAt     DateTime?
  reopenReason   String    @default("")
  notes          String    @default("")
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  exportBatches  GlExportBatch[]

  @@unique([year, month]) // plain unique — not soft-deletable, so no partial index
}

model GlExportBatch {
  id                 String        @id @default(cuid())
  exportNumber       Int           @unique // gl_export_batch_number_next; allocation-only, never reissued
  closePeriodId      String
  closePeriod        ClosePeriod   @relation(fields: [closePeriodId], references: [id])
  periodEnd          DateTime      @db.Date // the JE date stamped on every line in this batch (§ ruling 7)
  emittedAt          DateTime      @default(now())
  emittedById        String?
  emittedBy          User?         @relation(fields: [emittedById], references: [id])
  fileName           String
  fileContentType    String        @default("text/csv")
  file               Bytes
  registerContentType String       @default("application/pdf")
  register           Bytes
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  postings           GlPosting[]

  @@index([closePeriodId])
}

model GlPosting {
  id            String        @id @default(cuid())
  batchId       String
  batch         GlExportBatch @relation(fields: [batchId], references: [id])
  sourceType    String // INVOICE | CREDIT | PAYMENT | DISCOUNT | WRITE_OFF (gl-constants.ts)
  sourceId      String
  glDate        DateTime      @db.Date // the event's GL date (§4.3)
  glAccountId   String?
  glAccount     GlAccount?    @relation(fields: [glAccountId], references: [id], onDelete: SetNull)
  glAccountName String        @default("") // frozen account-number text
  debit         Decimal       @default(0) @db.Decimal(12, 2)
  credit        Decimal       @default(0) @db.Decimal(12, 2)
  side          String // SALES | CASH
  memo          String        @default("") // the line's memo (preserved so reversals reproduce it)
  isReversal    Boolean       @default(false)
  createdAt     DateTime      @default(now())

  @@index([sourceType, sourceId])
  @@index([batchId])
  @@index([glDate])
}
```

Add to `model BillingConfig` (mirror the existing `BillingSalesTaxGl` pair exactly — each FK needs a UNIQUE relation name):

```prisma
  arGlAccountId       String?
  arGlAccount         GlAccount?       @relation("BillingArGl", fields: [arGlAccountId], references: [id])
  discountGlAccountId String?
  discountGlAccount   GlAccount?       @relation("BillingDiscountGl", fields: [discountGlAccountId], references: [id])
  writeOffGlAccountId String?
  writeOffGlAccount   GlAccount?       @relation("BillingWriteOffGl", fields: [writeOffGlAccountId], references: [id])
```

Add to `model GlAccount` the back-relations (a `GlAccount` is referenced by `BillingConfig` many-named and by `GlPosting`):

```prisma
  billingAr       BillingConfig[]   @relation("BillingArGl")
  billingDiscount BillingConfig[]   @relation("BillingDiscountGl")
  billingWriteOff BillingConfig[]   @relation("BillingWriteOffGl")
  glPostings      GlPosting[]
```

Add the `closedBy`/`emittedBy` back-relations on `model User` (find the `User` model and add):

```prisma
  closedPeriods ClosePeriod[]
  glExports     GlExportBatch[]
```

- [ ] **Step 2: Generate the migration SQL (TTY-less).** Run from `erp/`:

```bash
npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script
```

Read the full output. It will emit `CREATE TABLE "ClosePeriod"/"GlExportBatch"/"GlPosting"`, their indexes and FKs, and three `ALTER TABLE "BillingConfig" ADD COLUMN ... TEXT` + three `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE`. Paste it verbatim into `prisma/migrations/<timestamp>_phase_5c_close_and_gl_export/migration.sql`. No hand-written CHECK or enum is needed (statuses are plain strings; no new Prisma enum). Confirm the `BillingConfig` FK add matches the precedent:

```sql
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_arGlAccountId_fkey" FOREIGN KEY ("arGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply to both databases and regenerate the client.**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 4: Register the three models in the audit layer.** In `erp/src/server/audit.ts`, extend the `AuditableModel` union (last line) and `SNAPSHOT_INCLUDE`:

```ts
// AuditableModel — append to the final line:
  | "receiptBatch" | "payment" | "application"
  | "closePeriod" | "glExportBatch";
```

```ts
// SNAPSHOT_INCLUDE — add:
  closePeriod: undefined,
  glExportBatch: { postings: true }, // the export's audit trail is its batch + the postings it emitted
```

`GlPosting` is **not** in `AuditableModel`: it is never independently created/updated/deleted — it is written only inside the `glExportBatch` create's transaction and snapshotted through the `{ postings: true }` include.

- [ ] **Step 5: Add the export-batch counter to the settings registry.** In `erp/src/server/settings.ts`, add to the `SETTINGS` object, beside `receipt_batch_number_next`:

```ts
  gl_export_batch_number_next: {
    schema: numberSeed, default: 1000, label: "Next GL-export batch number", group: "Numbering",
  },
```

The key **must** end in `_number_next` or it won't satisfy `NumberSettingKey` and `allocateNumber` won't accept it.

- [ ] **Step 6: Exempt `GlExportBatch.exportNumber` in the partial-unique sweep.** In `erp/tests/partial-unique-sweep.test.ts`, add to the `ALLOWED` set with a comment:

```ts
  "ReceiptBatch.batchNumber",
  // Allocation-only from gl_export_batch_number_next, never reissued (a discarded/reversed export
  // must never free a number a batch already carries) — the creditNumber/batchNumber precedent.
  "GlExportBatch.exportNumber",
```

`ClosePeriod` and `GlPosting` carry no soft-delete column, so their `@unique`/`@@unique` need no exemption.

- [ ] **Step 7: Write a smoke test proving the models exist and type.** Create `erp/tests/close-periods.test.ts`:

```ts
import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);

it("can create a ClosePeriod, GlExportBatch, and GlPosting", async () => {
  const period = await prisma.closePeriod.create({
    data: {
      year: 2026, month: 7, beginningAr: 0, invoicedTotal: 100, creditTotal: 0,
      paymentTotal: 40, discountTotal: 0, writeOffTotal: 0, endingAr: 60, agingEndingAr: 60,
    },
  });
  const batch = await prisma.glExportBatch.create({
    data: {
      exportNumber: 1000, closePeriodId: period.id, periodEnd: new Date("2026-07-31"),
      fileName: "gl-2026-07.csv", file: new Uint8Array([1]), register: new Uint8Array([2]),
    },
  });
  await prisma.glPosting.create({
    data: {
      batchId: batch.id, sourceType: "INVOICE", sourceId: "x", glDate: new Date("2026-07-15"),
      debit: 100, credit: 0, side: "SALES",
    },
  });
  expect(await prisma.glPosting.count({ where: { batchId: batch.id } })).toBe(1);
});
```

- [ ] **Step 8: Run gates.**

```bash
npx vitest run tests/close-periods.test.ts tests/partial-unique-sweep.test.ts
npx tsc --noEmit
```

Expected: PASS. (`partial-unique-sweep` proves the `exportNumber` exemption is accepted.)

- [ ] **Step 9: Commit.**

```bash
git add erp/prisma/schema.prisma erp/prisma/migrations erp/src/server/audit.ts erp/src/server/settings.ts erp/tests/partial-unique-sweep.test.ts erp/tests/close-periods.test.ts
git commit -m "feat(5c): close + GL-export data model, migration, audit + counter registration"
```

---


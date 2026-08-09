# Phase 5B — Task 2 report: A/R schema

**Task:** the A/R schema — three new tables (`ReceiptBatch` → `Payment` → `Application`), the
`ApplicationType` enum, column additions to four existing models, two hand-written CHECK
constraints, the two-directory migration, and the registry/audit/sweep wiring.

**Status:** DONE_WITH_CONCERNS (one deliberate, documented deviation from the brief's Step 7 — see
§7 below). All four gates green (§9).

---

## 1. Schema diff summary (`prisma/schema.prisma`)

New enum `ApplicationType { PAYMENT DISCOUNT WRITE_OFF CREDIT }`.

New models (all soft-deletable, `createdAt`/`updatedAt`, money `@db.Decimal(12,2)`, dates `@db.Date`):
- **`ReceiptBatch`** — `batchNumber Int @unique`, `depositDate @db.Date`, `controlTotal Decimal? @db.Decimal(12,2)`, `status String @default("OPEN")`, `notes`, `deletedAt`, `@@index([depositDate])`. `status` is a plain `String` (allowed values in `ar-constants.ts`'s `RECEIPT_BATCH_STATUSES`), **not** a Prisma enum — the brief's "Produces" lists only `ApplicationType` as a new enum, and Task 1 modelled the statuses as a TS const.
- **`Payment`** — FKs `batchId → ReceiptBatch`, `customerId → Customer`, `paymentTypeId → PaymentType`; `amount`, `reference`, `receivedDate @db.Date`, `notes`, `deletedAt`; `@@index([batchId])`, `@@index([customerId])`.
- **`Application`** — `invoiceId → Invoice` (required), `paymentId → Payment?`, `creditInvoiceId → Invoice?`; `type ApplicationType`, `reason String @default("")`, `amount`, `appliedDate @db.Date`, `deletedAt`; `@@index([invoiceId])`, `@@index([paymentId])`, `@@index([creditInvoiceId])`. Two named relations to `Invoice` (`InvoiceApplications` / `CreditApplications`).

Column additions:
- `Terms` +`netDays Int @default(30)`, +`discountPercent Decimal? @db.Decimal(5,2)`, +`discountDays Int?`.
- `Invoice` +`dueDate DateTime? @db.Date`, +`financeChargeExempt Boolean @default(false)`; + back-relations `applications`/`creditApplications`.
- `BillingConfig` +`financeChargeRate Decimal? @db.Decimal(6,4)`.
- `StoredDocument` +`customerId String?` (+ `customer Customer?` relation, `@@index([customerId])`); `DocumentKind` +`STATEMENT`.
- Back-relations: `PaymentType.payments`, `Customer.payments` + `Customer.documents`.

## 2. Migration directories (two, per the enum-split rule)

1. **`prisma/migrations/20260808230000_document_kind_statement_value/migration.sql`** — ONLY `ALTER TYPE "DocumentKind" ADD VALUE 'STATEMENT';` (Postgres refuses to USE a new enum value in the transaction that added it; the re-stated CHECK names `'STATEMENT'`, so it must run in a later transaction). Mirrors the 5A INVOICE/CREDIT split header.
2. **`prisma/migrations/20260808230100_accounts_receivable/migration.sql`** (ts strictly greater) — `CREATE TYPE "ApplicationType"`, the four `ALTER TABLE` column additions (incl. `Terms."netDays" INTEGER NOT NULL DEFAULT 30`, which backfills existing rows), the three `CREATE TABLE`s, all indexes, all FKs, and the two hand-written CHECKs:
   - `Application_source_check` — `PAYMENT/DISCOUNT/WRITE_OFF ⇒ creditInvoiceId IS NULL`; `CREDIT ⇒ paymentId IS NULL AND creditInvoiceId IS NOT NULL`. Deliberately does **not** require `paymentId IS NOT NULL` (a standalone bad-debt WRITE_OFF may carry a null paymentId).
   - `StoredDocument_kind_owner_check` — DROP + re-ADD, `AND "customerId" IS NULL` added to every prior arm, plus the `STATEMENT` arm (`customerId IS NOT NULL` and all others null). SHIPPER arm left loose on `orderId` (optional sub-scope).

`CREATE TYPE "ApplicationType"` and its use in the same migration is safe — only `ALTER TYPE ... ADD VALUE` on an existing enum triggers the split.

## 3. `migrate deploy` output (both DBs)

Applied to **`erp_test`** first (disposable), then dev **`erp`** — both applied the two new directories cleanly:

```
Applying migration `20260808230000_document_kind_statement_value`
Applying migration `20260808230100_accounts_receivable`
The following migration(s) have been applied: … (both dirs)
All migrations have been successfully applied.
```

## 4. `migrate status` — clean on both

- `erp_test`: `28 migrations found … Database schema is up to date!`
- `erp`: `28 migrations found … Database schema is up to date!`
- Drift check on `erp_test`: `migrate diff --from-config-datasource --to-schema … --exit-code` → **"No difference detected."** (exit 0), so the hand-written SQL reproduces the schema exactly.
- `npx prisma generate` regenerated the client (7.9.1).

## 5. TDD evidence (`tests/schema.test.ts`)

- **RED:** before the schema/client existed, both new cases failed with `TypeError: Cannot read properties of undefined (reading 'create')` (`prisma.receiptBatch` undefined). (2 failed | 2 passed.)
- **GREEN (after schema + generate):** 4 passed. Cases:
  - positive: `ReceiptBatch → Payment → Application` (type `PAYMENT`, against a FINALIZED invoice), read back nested — `status OPEN`, `controlTotal 100`, application `type PAYMENT`, `invoiceId` correct, `creditInvoiceId` null, `amount 100`.
  - negative: a **raw** `$executeRaw` insert of a `CREDIT` application carrying a `paymentId` is rejected by `Application_source_check` (P2010 / `originalCode 23514`); `application.count()` stays 0.

## 6. Wiring

- **`src/server/audit.ts`** — `receiptBatch`/`payment`/`application` added to `AuditableModel` and `SNAPSHOT_INCLUDE` (`receiptBatch: undefined`; `payment: { paymentType: true }`; `application: { invoice: { select: { id, kind, creditNumber, order: { orderNumber } } } }`, the 5A FK-with-live-name pattern). `SNAPSHOT_SELECT.storedDocument` gains `customerId`. Validated by the `certs-schema.test.ts` SNAPSHOT_INCLUDE smoke test (issues a real `findFirst({ include })` per model — green).
- **`src/server/documents.ts`** — `AREA_FOR_KIND.STATEMENT = "receivables"`; `DocumentOwner` +`{ kind: "STATEMENT"; customerId }`; `DocumentMeta`/`DOCUMENT_SELECT` +`customerId`; `ownerColumns` maps STATEMENT → customerId; `documentFilename`/`resolveDocumentFilename` gain a STATEMENT arm (named by the customer's code, `statement-<code>.pdf`, one optional `customerCode` param mirroring `creditNumber`). Four hand-built `DocumentMeta` literals (cert print, shipper print ×2, `travelerFilename`) updated with `customerId: null`.
- **`src/lib/reference-links.ts`** — see §7.

## 7. DEVIATION from brief Step 7 (register FKs in the reference-link sweep)

The brief and the controller's note both say to register all six new FKs (`Application.invoiceId`, `.paymentId`, `.creditInvoiceId`, `Payment.batchId`, `.customerId`, `.paymentTypeId`). **Only `Payment.paymentTypeId` can be — and needs to be — registered.** Two independent reasons:

1. `ReferenceLink.targetKind` is typed `BlockerTarget = ReferenceKind | "processStepCode" | "surcharge"`. The other five FKs target `Invoice`/`Payment`/`ReceiptBatch`/`Customer`, none of which is a `BlockerTarget`, so registering them is a **`tsc` compile error**.
2. The sweep (`schemaLinks` in `tests/reference-links-sweep.test.ts`) only surfaces FKs whose **target** is a reference kind, and the "every registered link targets a real reference kind" test would fail on any of the five. `Payment.paymentTypeId → paymentType` is the sole new FK the sweep sees, so it is the only one that must be registered for the suite to pass.

Registered one entry (`payment.paymentTypeId → paymentType`, entityLabel "Payment", names itself by its check reference, no detailPath), added `"payment"` to `ReferenceLinkModel`, and added `"payment.paymentTypeId -> paymentType"` to the sweep's enumerated "finds every known reference FK" list. `tests/reference-links-sweep.test.ts` is green. This is a correction, not a gap: the intent — "make the sweep pass" — is satisfied, and the other five FKs are outside the delete-guard registry by the registry's own design.

## 8. Per-file change rationale (why each non-obvious file changed)

- **`prisma/schema.prisma`** — the models/columns/enum of §1.
- **two migration dirs** — §2.
- **`src/server/audit.ts`** — §6 (register three auditable models + SNAPSHOT_SELECT customerId).
- **`src/lib/reference-links.ts`** — §7 (the one registrable new FK).
- **`src/server/documents.ts`** — §6. `DocumentMeta` (and its query projection `DOCUMENT_SELECT`) gained a **required** `customerId: string | null`, the same full wiring `invoiceId` got in 5A — a STATEMENT document's owner is its customer, and a listed statement must carry it. That required field is what rippled to the three files below.
- **`src/app/api/certs/[id]/print/route.ts`, `src/app/api/shippers/[id]/print/route.ts` (×2), `src/server/traveler.ts`** — each **hand-builds a `DocumentMeta` object literal** to feed `documentFilename`. Making `customerId` required in `DocumentMeta` made those literals fail `tsc` ("Property 'customerId' is missing"). Fix: add `customerId: null` to each (a TRAVELER/CERT/BOL/SHIPPER document genuinely has no customer owner). This is honest type-completion of a widened type, **not** a workaround for the stricter CHECK — the CHECK never touches these paths.
- **`tests/invoicing-schema.test.ts`** — pins the exact ordered `DocumentKind` labels via `pg_enum`. Adding `STATEMENT` to the enum (the intended schema change) made the expected array 6→7; updated it to append `"STATEMENT"` after `CREDIT` (matching `enumsortorder`) and renamed the case. This **reflects the intended enum widening**, not a papered-over break — the two `document_kind_*_value` split migrations are exactly what land the value in that order.
- **`tests/documents.test.ts`** — the `base` `DocumentMeta` literal used by the filename tests needed `customerId: null` (same `DocumentMeta`-widening reason as the print/traveler files).
- **`tests/reference-links-sweep.test.ts`** — the enumerated "finds every known reference FK" list needed `"payment.paymentTypeId -> paymentType"` added (§7).
- **`tests/schema.test.ts`** — the new TDD round-trip + CHECK-rejection cases (§5).
- **`CLAUDE.md`** — mandatory docs-in-step update: the `StoredDocument` kind→owner CHECK bullet now names the `_accounts_receivable` migration as the current definition (STATEMENT owns `customerId` alone; every arm now also asserts `customerId IS NULL` where not owned) and adds the `_document_kind_statement_value` split to the ADD-VALUE list.

## 9. Gates (all foreground)

| Gate | Result |
|---|---|
| `npm test` (full suite) | PASS — **1696 passed**, 109 files |
| `npx tsc --noEmit` | PASS (clean) |
| `npx eslint src tests` | PASS (clean) |
| `npm run build` | PASS (clean) |

## 10. Concerns / notes

- The one deviation (§7) is deliberate and forced by the type system + sweep design.
- `documentFilename`/`resolveDocumentFilename` gained a STATEMENT arm because the switches are exhaustive over `DocumentKind` and would not compile otherwise; kept minimal (customer code → `statement-<code>.pdf`). The statements print/archive flow itself is a later task.
- No E2E run: this task is schema + wiring with no UI/flow change; `npm run test:e2e` not applicable (nothing the Playwright flows exercise changed).

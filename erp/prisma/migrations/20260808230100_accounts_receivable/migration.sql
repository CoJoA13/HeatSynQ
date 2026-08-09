-- Phase 5B Task 2, part 2 of 2 — accounts receivable (design spec §4.1–§4.3).
--
-- Part 1 (20260808230000_document_kind_statement_value) added DocumentKind's STATEMENT in its own
-- transaction; this migration is the first that may USE it, which is what the re-stated
-- StoredDocument_kind_owner_check at the bottom of this file does.
--
-- ApplicationType is a BRAND-NEW enum, so CREATE TYPE and using it in the same transaction is
-- safe — only ALTER TYPE ... ADD VALUE on an existing enum triggers the "must be committed first"
-- rule that forced STATEMENT into its own directory.
--
-- Terms."netDays" is added NOT NULL DEFAULT 30, which backfills every existing Terms row to 30 in
-- one statement (design spec §4.3: "the migration backfills existing rows to 30").

-- CreateEnum
CREATE TYPE "ApplicationType" AS ENUM ('PAYMENT', 'DISCOUNT', 'WRITE_OFF', 'CREDIT');

-- AlterTable
ALTER TABLE "BillingConfig" ADD COLUMN     "financeChargeRate" DECIMAL(6,4);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "dueDate" DATE,
ADD COLUMN     "financeChargeExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StoredDocument" ADD COLUMN     "customerId" TEXT;

-- AlterTable
ALTER TABLE "Terms" ADD COLUMN     "discountDays" INTEGER,
ADD COLUMN     "discountPercent" DECIMAL(5,2),
ADD COLUMN     "netDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "ReceiptBatch" (
    "id" TEXT NOT NULL,
    "batchNumber" INTEGER NOT NULL,
    "depositDate" DATE NOT NULL,
    "controlTotal" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notes" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "paymentTypeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "receivedDate" DATE NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "ApplicationType" NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "paymentId" TEXT,
    "creditInvoiceId" TEXT,
    "appliedDate" DATE NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptBatch_batchNumber_key" ON "ReceiptBatch"("batchNumber");

-- CreateIndex
CREATE INDEX "ReceiptBatch_depositDate_idx" ON "ReceiptBatch"("depositDate");

-- CreateIndex
CREATE INDEX "Payment_batchId_idx" ON "Payment"("batchId");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Application_invoiceId_idx" ON "Application"("invoiceId");

-- CreateIndex
CREATE INDEX "Application_paymentId_idx" ON "Application"("paymentId");

-- CreateIndex
CREATE INDEX "Application_creditInvoiceId_idx" ON "Application"("creditInvoiceId");

-- CreateIndex
CREATE INDEX "StoredDocument_customerId_idx" ON "StoredDocument"("customerId");

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReceiptBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentTypeId_fkey" FOREIGN KEY ("paymentTypeId") REFERENCES "PaymentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_creditInvoiceId_fkey" FOREIGN KEY ("creditInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Hand-written CHECK constraints ─────────────────────────────────────────────────────────
-- Prisma's schema language has no check-constraint syntax (the Part.loadQty and
-- StoredDocument_kind_owner_check precedents), so both constraints below live only here.

-- Exactly one source per application type (spec §4.1; the StoredDocument_kind_owner_check
-- precedent). PAYMENT/DISCOUNT/WRITE_OFF draw on a payment (or, for a standalone bad-debt
-- WRITE_OFF, nothing) and never a credit; a CREDIT draws on a credit memo and never a payment.
-- Deliberately does NOT require paymentId IS NOT NULL for the non-credit types — a standalone
-- bad-debt WRITE_OFF may carry a null paymentId.
ALTER TABLE "Application" ADD CONSTRAINT "Application_source_check" CHECK (
  ("type" IN ('PAYMENT','DISCOUNT','WRITE_OFF') AND "creditInvoiceId" IS NULL)
  OR ("type" = 'CREDIT' AND "paymentId" IS NULL AND "creditInvoiceId" IS NOT NULL)
);

-- The kind→owner rule, extended for STATEMENT (owner = customer). Keep this in step with the
-- schema comment on StoredDocument and with DocumentOwner/AREA_FOR_KIND in src/server/documents.ts.
-- This DROPs then re-ADDs — the constraint already exists (last stated in
-- 20260806221500_pricing_and_invoicing). Following that precedent, every prior arm gains
-- AND "customerId" IS NULL, and a STATEMENT arm is added.
--
-- The SHIPPER arm stays deliberately LOOSE on "orderId": it is an optional SUB-scope (which one
-- order's ticket this is, null = the whole set), not an alternate owner. Do not "tighten" it.
ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_kind_owner_check";
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL)                      OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL) OR
  (kind IN ('INVOICE','CREDIT')
                     AND "invoiceId" IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "customerId" IS NULL) OR
  (kind = 'STATEMENT'
                     AND "customerId" IS NOT NULL AND "orderId" IS NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL)
);

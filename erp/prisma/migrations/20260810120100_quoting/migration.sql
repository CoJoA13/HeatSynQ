-- Phase 6 Task 1, part 2 of 2 — the quoting data layer (design spec §4.1–§4.2, §9).
--
-- Part 1 (20260810120000_quote_enum_values) added DocumentKind's and PriceSource's QUOTE in its
-- own transaction; this migration is the first that may USE either, which is what the re-stated
-- StoredDocument_kind_owner_check at the bottom of this file does.
--
-- Quote.quoteNumber is a plain (not live-rows-only) unique on a soft-deletable model,
-- deliberately: allocation-only from quote_number_next, never reused or re-entered — a deleted
-- quote keeps its number forever (the Order.orderNumber precedent; sweep exemption in
-- tests/partial-unique-sweep.test.ts). The QuotePrice/QuotePriceBreak/EndingStatement uniques
-- are the usual live-rows-only partial indexes.

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "sourceQuoteNumber" INTEGER;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "quoteLineId" TEXT;

-- AlterTable
ALTER TABLE "StoredDocument" ADD COLUMN     "quoteId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "quoteNumber" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closeReason" TEXT NOT NULL DEFAULT '',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "quoteDate" DATE NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "expiryDate" DATE NOT NULL,
    "followUpDate" DATE,
    "rfqNumber" TEXT NOT NULL DEFAULT '',
    "quotedById" TEXT NOT NULL,
    "endingStatementId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "internalNotes" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "partId" TEXT,
    "partNumberText" TEXT NOT NULL DEFAULT '',
    "partNameText" TEXT NOT NULL DEFAULT '',
    "partDescriptionText" TEXT NOT NULL DEFAULT '',
    "materialText" TEXT NOT NULL DEFAULT '',
    "eachWeight" DECIMAL(10,4),
    "quotedQty" INTEGER,
    "quotedUnlimited" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotePrice" (
    "id" TEXT NOT NULL,
    "quoteLineId" TEXT NOT NULL,
    "processStepCodeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "setupCharge" DECIMAL(12,2),
    "unitPrice" DECIMAL(12,4),
    "minimumCharge" DECIMAL(12,2),
    "pricePer" "PricePer" NOT NULL DEFAULT 'EACH',
    "notes" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotePriceBreak" (
    "id" TEXT NOT NULL,
    "quotePriceId" TEXT NOT NULL,
    "threshold" DECIMAL(12,2) NOT NULL,
    "price" DECIMAL(12,4) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotePriceBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndingStatement" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndingStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quote_quoteNumber_key" ON "Quote"("quoteNumber");

-- CreateIndex
CREATE INDEX "Quote_customerId_idx" ON "Quote"("customerId");

-- CreateIndex
CREATE INDEX "QuoteLine_quoteId_idx" ON "QuoteLine"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteLine_partId_idx" ON "QuoteLine"("partId");

-- CreateIndex
CREATE INDEX "QuotePrice_quoteLineId_idx" ON "QuotePrice"("quoteLineId");

-- CreateIndex
CREATE INDEX "QuotePrice_processStepCodeId_idx" ON "QuotePrice"("processStepCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "QuotePrice_quoteLineId_processStepCodeId_key" ON "QuotePrice"("quoteLineId", "processStepCodeId") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "QuotePriceBreak_quotePriceId_threshold_key" ON "QuotePriceBreak"("quotePriceId", "threshold") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "EndingStatement_name_key" ON "EndingStatement"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "OrderLine_quoteLineId_idx" ON "OrderLine"("quoteLineId");

-- CreateIndex
CREATE INDEX "StoredDocument_quoteId_idx" ON "StoredDocument"("quoteId");

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_quoteLineId_fkey" FOREIGN KEY ("quoteLineId") REFERENCES "QuoteLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_quotedById_fkey" FOREIGN KEY ("quotedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_endingStatementId_fkey" FOREIGN KEY ("endingStatementId") REFERENCES "EndingStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotePrice" ADD CONSTRAINT "QuotePrice_quoteLineId_fkey" FOREIGN KEY ("quoteLineId") REFERENCES "QuoteLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotePrice" ADD CONSTRAINT "QuotePrice_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES "ProcessStepCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotePriceBreak" ADD CONSTRAINT "QuotePriceBreak_quotePriceId_fkey" FOREIGN KEY ("quotePriceId") REFERENCES "QuotePrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written CHECK constraint ──────────────────────────────────────────────────────────
-- The kind→owner rule, extended for QUOTE (owner = quote). Prisma's schema language has no
-- check-constraint syntax, so this lives only in migrations. Keep it in step with the schema
-- comment on StoredDocument and with DocumentOwner/AREA_FOR_KIND in src/server/documents.ts.
-- This DROPs then re-ADDs — the constraint already exists (last stated in
-- 20260808230100_accounts_receivable). Following that precedent, every prior arm gains
-- AND "quoteId" IS NULL, and a QUOTE arm is added requiring "quoteId" alone.
--
-- The SHIPPER arm stays deliberately LOOSE on "orderId": it is an optional SUB-scope (which one
-- order's ticket this is, null = the whole set), not an alternate owner. Do not "tighten" it.
ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_kind_owner_check";
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL AND "quoteId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL AND "quoteId" IS NULL)                      OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL AND "quoteId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL AND "quoteId" IS NULL) OR
  (kind IN ('INVOICE','CREDIT')
                     AND "invoiceId" IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "customerId" IS NULL AND "quoteId" IS NULL) OR
  (kind = 'STATEMENT'
                     AND "customerId" IS NOT NULL AND "orderId" IS NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL AND "quoteId" IS NULL)   OR
  (kind = 'QUOTE'
                     AND "quoteId"   IS NOT NULL AND "orderId"  IS NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL AND "customerId" IS NULL)
);

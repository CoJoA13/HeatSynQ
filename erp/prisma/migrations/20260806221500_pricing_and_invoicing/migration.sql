-- Phase 5A Task 2, part 2 of 2 — pricing and invoicing (design spec §4.1–§4.5).
--
-- Part 1 (20260806221400_document_kind_invoice_values) added DocumentKind's INVOICE and CREDIT in
-- its own transaction; this migration is the first that may USE them, which is what the re-stated
-- StoredDocument_kind_owner_check at the bottom of this file does.
--
-- No backfill anywhere in this file, and none is possible to write: the Part column drops and the
-- PartPriceBreak re-parent below destroy keyed pricing outright. Both databases were verified
-- EMPTY of Part, PartPriceBreak, Customer, Order and ProcessStepCode rows immediately before this
-- migration was written (design spec §3.4). Applying it to a database that has parts would silently
-- discard every price on file — that is an owner decision, not a migration's to make.

-- CreateEnum
CREATE TYPE "SurchargeKind" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "SurchargeScope" AS ENUM ('ALL', 'INCLUDE', 'EXCLUDE');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('INVOICE', 'CREDIT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('PART', 'OPERATION', 'SURCHARGE', 'FREIGHT', 'CHARGE', 'CERT', 'TAX');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('PART_PRICE', 'MANUAL');

-- DropForeignKey
ALTER TABLE "PartPriceBreak" DROP CONSTRAINT "PartPriceBreak_partId_fkey";

-- DropIndex
DROP INDEX "PartPriceBreak_partId_threshold_key";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "certChargeSuppressed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "salesTaxRate" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "Part" DROP COLUMN "minimumCharge",
DROP COLUMN "pricePer",
DROP COLUMN "setupCharge",
DROP COLUMN "unitPrice",
ADD COLUMN     "billForCert" BOOLEAN,
ADD COLUMN     "certCharge" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "PartPriceBreak" DROP COLUMN "partId",
ADD COLUMN     "partPriceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Shipper" ADD COLUMN     "reversesShipperId" TEXT;

-- AlterTable
ALTER TABLE "StoredDocument" ADD COLUMN     "invoiceId" TEXT;

-- CreateTable
CREATE TABLE "PartPrice" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "processStepCodeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "setupCharge" DECIMAL(12,2),
    "unitPrice" DECIMAL(12,4),
    "minimumCharge" DECIMAL(12,2),
    "pricePer" "PricePer" NOT NULL DEFAULT 'EACH',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Surcharge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SurchargeKind" NOT NULL DEFAULT 'PERCENT',
    "rate" DECIMAL(9,6),
    "amount" DECIMAL(12,2),
    "minimumAmount" DECIMAL(12,2),
    "glAccountId" TEXT,
    "scope" "SurchargeScope" NOT NULL DEFAULT 'ALL',
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Surcharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurchargeStepCode" (
    "id" TEXT NOT NULL,
    "surchargeId" TEXT NOT NULL,
    "processStepCodeId" TEXT NOT NULL,

    CONSTRAINT "SurchargeStepCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSurcharge" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "surchargeId" TEXT NOT NULL,
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "rate" DECIMAL(9,6),
    "amount" DECIMAL(12,2),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSurcharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL DEFAULT 'INVOICE',
    "orderId" TEXT NOT NULL,
    "sourceInvoiceId" TEXT,
    "creditNumber" INTEGER,
    "customerId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceDate" DATE NOT NULL,
    "poNumber" TEXT NOT NULL DEFAULT '',
    "termsName" TEXT NOT NULL DEFAULT '',
    "billTo" TEXT NOT NULL DEFAULT '',
    "shipTo" TEXT NOT NULL DEFAULT '',
    "materialName" TEXT NOT NULL DEFAULT '',
    "processNames" TEXT NOT NULL DEFAULT '',
    "taxRate" DECIMAL(9,6),
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "surchargeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "chargeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "certTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "freightTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "clientRequestId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL,
    "parentLineId" TEXT,
    "orderLineId" TEXT,
    "processStepCodeId" TEXT,
    "surchargeId" TEXT,
    "orderChargeId" TEXT,
    "glAccountId" TEXT,
    "partNumber" TEXT NOT NULL DEFAULT '',
    "partName" TEXT NOT NULL DEFAULT '',
    "partDescription" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "glAccountName" TEXT NOT NULL DEFAULT '',
    "qty" INTEGER,
    "weight" DECIMAL(12,2),
    "eachWeight" DECIMAL(10,4),
    "pricePer" "PricePer",
    "unitPrice" DECIMAL(12,4),
    "setupCharge" DECIMAL(12,2),
    "minimumCharge" DECIMAL(12,2),
    "breakThreshold" DECIMAL(12,2),
    "minimumApplied" BOOLEAN NOT NULL DEFAULT false,
    "rate" DECIMAL(9,6),
    "priceSource" "PriceSource",
    "needsPrice" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "salesTaxRate" DECIMAL(9,6),
    "salesTaxGlAccountId" TEXT,
    "freightGlAccountId" TEXT,
    "otherChargeGlAccountId" TEXT,
    "certChargeStepCodeId" TEXT,
    "certChargeDefault" DECIMAL(12,2),
    "billForCertDefault" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartPrice_partId_idx" ON "PartPrice"("partId");

-- CreateIndex
CREATE INDEX "PartPrice_processStepCodeId_idx" ON "PartPrice"("processStepCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PartPrice_partId_processStepCodeId_key" ON "PartPrice"("partId", "processStepCodeId") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Surcharge_name_key" ON "Surcharge"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "SurchargeStepCode_surchargeId_processStepCodeId_key" ON "SurchargeStepCode"("surchargeId", "processStepCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSurcharge_customerId_surchargeId_key" ON "CustomerSurcharge"("customerId", "surchargeId") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_creditNumber_key" ON "Invoice"("creditNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_clientRequestId_key" ON "Invoice"("clientRequestId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "Invoice_orderId_idx" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId") WHERE ("deletedAt" IS NULL AND "kind" = 'INVOICE'::"InvoiceKind");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLine_orderLineId_idx" ON "InvoiceLine"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "PartPriceBreak_partPriceId_threshold_key" ON "PartPriceBreak"("partPriceId", "threshold") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "StoredDocument_invoiceId_idx" ON "StoredDocument"("invoiceId");

-- AddForeignKey
ALTER TABLE "PartPriceBreak" ADD CONSTRAINT "PartPriceBreak_partPriceId_fkey" FOREIGN KEY ("partPriceId") REFERENCES "PartPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipper" ADD CONSTRAINT "Shipper_reversesShipperId_fkey" FOREIGN KEY ("reversesShipperId") REFERENCES "Shipper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartPrice" ADD CONSTRAINT "PartPrice_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartPrice" ADD CONSTRAINT "PartPrice_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES "ProcessStepCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Surcharge" ADD CONSTRAINT "Surcharge_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurchargeStepCode" ADD CONSTRAINT "SurchargeStepCode_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES "Surcharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurchargeStepCode" ADD CONSTRAINT "SurchargeStepCode_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES "ProcessStepCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSurcharge" ADD CONSTRAINT "CustomerSurcharge_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSurcharge" ADD CONSTRAINT "CustomerSurcharge_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES "Surcharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sourceInvoiceId_fkey" FOREIGN KEY ("sourceInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_parentLineId_fkey" FOREIGN KEY ("parentLineId") REFERENCES "InvoiceLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES "ProcessStepCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES "Surcharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_orderChargeId_fkey" FOREIGN KEY ("orderChargeId") REFERENCES "OrderCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_salesTaxGlAccountId_fkey" FOREIGN KEY ("salesTaxGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_freightGlAccountId_fkey" FOREIGN KEY ("freightGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_otherChargeGlAccountId_fkey" FOREIGN KEY ("otherChargeGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_certChargeStepCodeId_fkey" FOREIGN KEY ("certChargeStepCodeId") REFERENCES "ProcessStepCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Hand-written CHECK constraints ─────────────────────────────────────────────────────────
-- Prisma's schema language has no check-constraint syntax (the Part.loadQty and
-- StoredDocument_kind_owner_check precedents), so both constraints below live only here.

-- The kind→owner rule, extended for invoices and credits. Keep this in step with the schema
-- comment on StoredDocument and with DocumentOwner/AREA_FOR_KIND in src/server/documents.ts.
--
-- The SHIPPER arm stays deliberately LOOSE on "orderId": it is an optional SUB-scope (which one
-- order's ticket this is, null = the whole set), not an alternate owner. Do not "tighten" it.
ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_kind_owner_check";
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL AND "invoiceId" IS NULL)                      OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL AND "certId" IS NULL AND "invoiceId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "invoiceId" IS NULL) OR
  (kind IN ('INVOICE','CREDIT')
                     AND "invoiceId" IS NOT NULL AND "orderId"   IS NULL AND "shipperId" IS NULL AND "certId" IS NULL)
);

-- BillingConfig is a singleton by construction, not by convention.
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_singleton_check" CHECK ("id" = 'singleton');

-- Seed the one row here rather than lazily on first read, so getBillingConfig is a plain
-- findFirst and setBillingConfig is a plain audited update with a real before-snapshot.
INSERT INTO "BillingConfig" ("id", "billForCertDefault", "updatedAt")
VALUES ('singleton', false, now())
ON CONFLICT ("id") DO NOTHING;

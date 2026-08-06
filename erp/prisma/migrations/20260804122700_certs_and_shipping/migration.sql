-- Phase 4 Task 2, part 2 of 2 — certifications and shipments (design spec §4).
--
-- Eight new tables in two graphs:
--   Cert -> CertRequirement -> CertReading
--   Shipper -> ShipperOrder -> ShipperLine / ShipperContainer / ShipperSerial
-- plus two new enums, the §4.4 columns on four existing tables, and the widening of
-- StoredDocument from one owner (order) to three (order, shipper, cert).
--
-- Runs AFTER 20260804122600_document_kind_values because the CHECK at the bottom of this file
-- names 'SHIPPER', 'BOL' and 'CERT', and Postgres refuses to use an enum value in the same
-- transaction that added it. See that migration's own header.
--
-- Purely additive. The one non-additive-looking statement is the StoredDocument_orderId_fkey
-- drop-and-recreate: `orderId` becomes nullable (a SHIPPER/BOL/CERT document has no order of its
-- own), and Prisma's referential action for an OPTIONAL relation is ON DELETE SET NULL rather
-- than the RESTRICT an optional-but-required column got. No `onDelete` is declared anywhere in
-- schema.prisma for these relations — these are Prisma's defaults, left alone deliberately.
-- Nothing in this application hard-deletes an Order (deletion is always soft, CLAUDE.md), so the
-- action never fires in practice; if one ever did, the CHECK below would refuse to let a stored
-- TRAVELER be orphaned, which is the outcome we want.

-- CreateEnum
CREATE TYPE "CertScope" AS ENUM ('ORDER', 'LOAD', 'SHIPMENT');

-- CreateEnum
CREATE TYPE "FreightTerms" AS ENUM ('PREPAID', 'COLLECT');

-- DropForeignKey
ALTER TABLE "StoredDocument" DROP CONSTRAINT "StoredDocument_orderId_fkey";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "certRequiredDefault" BOOLEAN,
ADD COLUMN     "certScopeDefault" "CertScope";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "certRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "certScope" "CertScope" NOT NULL DEFAULT 'ORDER',
ADD COLUMN     "customerJobNo" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "OrderContainer" ADD COLUMN     "customerContainerId" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "certRequired" BOOLEAN,
ADD COLUMN     "certScope" "CertScope";

-- AlterTable
ALTER TABLE "StoredDocument" ADD COLUMN     "certId" TEXT,
ADD COLUMN     "shipperId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Cert" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "scope" "CertScope" NOT NULL,
    "loadNumber" INTEGER,
    "shipperId" TEXT,
    "freeform" TEXT NOT NULL DEFAULT '',
    "internalNotes" TEXT NOT NULL DEFAULT '',
    "printedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertRequirement" (
    "id" TEXT NOT NULL,
    "certId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "inspectionCodeId" TEXT NOT NULL,
    "scaleId" TEXT,
    "min" DECIMAL(10,4),
    "max" DECIMAL(10,4),
    "sampleQty" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CertRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertReading" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "value" DECIMAL(10,4),
    "passed" BOOLEAN,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CertReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipper" (
    "id" TEXT NOT NULL,
    "shipperNumber" INTEGER NOT NULL,
    "bolNumber" INTEGER,
    "clientRequestId" TEXT,
    "customerId" TEXT NOT NULL,
    "shipToAddressId" TEXT,
    "shipDate" DATE NOT NULL,
    "carrierId" TEXT,
    "route" TEXT NOT NULL DEFAULT '',
    "comments" TEXT NOT NULL DEFAULT '',
    "billFreight" BOOLEAN NOT NULL DEFAULT false,
    "freightAmount" DECIMAL(12,2),
    "freightTerms" "FreightTerms" NOT NULL DEFAULT 'PREPAID',
    "freightClass" TEXT NOT NULL DEFAULT '',
    "freightDescription" TEXT NOT NULL DEFAULT '',
    "packageCount" INTEGER,
    "proNumber" TEXT NOT NULL DEFAULT '',
    "scacCode" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipperOrder" (
    "id" TEXT NOT NULL,
    "shipperId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ShipperOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipperLine" (
    "id" TEXT NOT NULL,
    "shipperOrderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "weight" DECIMAL(12,2) NOT NULL,
    "lineComplete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ShipperLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipperContainer" (
    "id" TEXT NOT NULL,
    "shipperOrderId" TEXT NOT NULL,
    "orderContainerId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ShipperContainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipperSerial" (
    "id" TEXT NOT NULL,
    "shipperOrderId" TEXT NOT NULL,
    "orderSerialId" TEXT NOT NULL,
    "printOnShipper" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ShipperSerial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cert_orderId_idx" ON "Cert"("orderId");

-- CreateIndex
CREATE INDEX "Cert_shipperId_idx" ON "Cert"("shipperId");

-- CreateIndex
CREATE INDEX "CertRequirement_orderLineId_idx" ON "CertRequirement"("orderLineId");

-- CreateIndex
CREATE INDEX "CertRequirement_inspectionCodeId_idx" ON "CertRequirement"("inspectionCodeId");

-- CreateIndex
CREATE INDEX "CertRequirement_scaleId_idx" ON "CertRequirement"("scaleId");

-- CreateIndex
CREATE UNIQUE INDEX "CertRequirement_certId_position_key" ON "CertRequirement"("certId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CertReading_requirementId_position_key" ON "CertReading"("requirementId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Shipper_shipperNumber_key" ON "Shipper"("shipperNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Shipper_bolNumber_key" ON "Shipper"("bolNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Shipper_clientRequestId_key" ON "Shipper"("clientRequestId");

-- CreateIndex
CREATE INDEX "Shipper_customerId_idx" ON "Shipper"("customerId");

-- CreateIndex
CREATE INDEX "Shipper_shipDate_idx" ON "Shipper"("shipDate");

-- CreateIndex
CREATE INDEX "Shipper_carrierId_idx" ON "Shipper"("carrierId");

-- CreateIndex
CREATE INDEX "ShipperOrder_orderId_idx" ON "ShipperOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperOrder_shipperId_orderId_key" ON "ShipperOrder"("shipperId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperOrder_shipperId_position_key" ON "ShipperOrder"("shipperId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperOrder_orderId_sequence_key" ON "ShipperOrder"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "ShipperLine_orderLineId_idx" ON "ShipperLine"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperLine_shipperOrderId_position_key" ON "ShipperLine"("shipperOrderId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperLine_shipperOrderId_orderLineId_key" ON "ShipperLine"("shipperOrderId", "orderLineId");

-- CreateIndex
CREATE INDEX "ShipperContainer_orderContainerId_idx" ON "ShipperContainer"("orderContainerId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperContainer_shipperOrderId_position_key" ON "ShipperContainer"("shipperOrderId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperContainer_shipperOrderId_orderContainerId_key" ON "ShipperContainer"("shipperOrderId", "orderContainerId");

-- CreateIndex
CREATE INDEX "ShipperSerial_orderSerialId_idx" ON "ShipperSerial"("orderSerialId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipperSerial_shipperOrderId_orderSerialId_key" ON "ShipperSerial"("shipperOrderId", "orderSerialId");

-- CreateIndex
CREATE INDEX "StoredDocument_shipperId_idx" ON "StoredDocument"("shipperId");

-- CreateIndex
CREATE INDEX "StoredDocument_certId_idx" ON "StoredDocument"("certId");

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES "Shipper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_certId_fkey" FOREIGN KEY ("certId") REFERENCES "Cert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cert" ADD CONSTRAINT "Cert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cert" ADD CONSTRAINT "Cert_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES "Shipper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertRequirement" ADD CONSTRAINT "CertRequirement_certId_fkey" FOREIGN KEY ("certId") REFERENCES "Cert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertRequirement" ADD CONSTRAINT "CertRequirement_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertRequirement" ADD CONSTRAINT "CertRequirement_inspectionCodeId_fkey" FOREIGN KEY ("inspectionCodeId") REFERENCES "InspectionCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertRequirement" ADD CONSTRAINT "CertRequirement_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES "InspectionScale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertReading" ADD CONSTRAINT "CertReading_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "CertRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipper" ADD CONSTRAINT "Shipper_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipper" ADD CONSTRAINT "Shipper_shipToAddressId_fkey" FOREIGN KEY ("shipToAddressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipper" ADD CONSTRAINT "Shipper_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperOrder" ADD CONSTRAINT "ShipperOrder_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES "Shipper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperOrder" ADD CONSTRAINT "ShipperOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperLine" ADD CONSTRAINT "ShipperLine_shipperOrderId_fkey" FOREIGN KEY ("shipperOrderId") REFERENCES "ShipperOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperLine" ADD CONSTRAINT "ShipperLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperContainer" ADD CONSTRAINT "ShipperContainer_shipperOrderId_fkey" FOREIGN KEY ("shipperOrderId") REFERENCES "ShipperOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperContainer" ADD CONSTRAINT "ShipperContainer_orderContainerId_fkey" FOREIGN KEY ("orderContainerId") REFERENCES "OrderContainer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperSerial" ADD CONSTRAINT "ShipperSerial_shipperOrderId_fkey" FOREIGN KEY ("shipperOrderId") REFERENCES "ShipperOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperSerial" ADD CONSTRAINT "ShipperSerial_orderSerialId_fkey" FOREIGN KEY ("orderSerialId") REFERENCES "OrderSerial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written, not produced by `migrate diff`: Prisma's schema language has no check-constraint
-- syntax (no `@@check` — the same situation as Part.loadQty, whose CHECKs live in
-- migrations/20260803044035_part_load_cap_checks/migration.sql). StoredDocument now has three
-- possible owners and which one is REQUIRED is decided by `kind`; without this, a CERT row could
-- carry a shipperId, a BOL could be filed against an order, or a row could name no owner at all,
-- and the order hub's document union query would quietly return the wrong papers.
--
-- The SHIPPER line is deliberately looser than the other three: `orderId` does DOUBLE DUTY there
-- as the sub-scope — which order's ticket this is, null = the whole set — exactly as `loadNumber`
-- already does for a TRAVELER. Printing one order's ticket out of a five-order shipment is the
-- same shape as printing one load's traveler (design spec §4.3). That asymmetry is the design,
-- not an omission: do not "tighten" SHIPPER to `"orderId" IS NULL`.
--
-- Validates against existing data on the way in: every row today is a TRAVELER with orderId set,
-- and the two new owner columns are NULL everywhere.
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_kind_owner_check" CHECK (
  (kind = 'TRAVELER' AND "orderId"   IS NOT NULL AND "shipperId" IS NULL     AND "certId" IS NULL) OR
  (kind = 'SHIPPER'  AND "shipperId" IS NOT NULL AND "certId"    IS NULL)                          OR
  (kind = 'BOL'      AND "shipperId" IS NOT NULL AND "orderId"   IS NULL     AND "certId" IS NULL) OR
  (kind = 'CERT'     AND "certId"    IS NOT NULL AND "orderId"   IS NULL     AND "shipperId" IS NULL)
);

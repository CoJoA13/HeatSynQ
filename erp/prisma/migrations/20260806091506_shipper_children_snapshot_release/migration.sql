-- Snapshot + release (owner ruling 2026-08-06, PR #47 review round 2): shipper children snapshot
-- the identity they print; their FKs to the order-side rows become nullable ON DELETE SET NULL so
-- order-correction APIs (removeLine after void, replaceContainers, replaceSerials) stop hitting
-- raw RESTRICT errors. Snapshot columns are added NULLABLE, backfilled from the joins (every
-- existing row still has its FK — RESTRICT guaranteed that until this migration), then SET NOT
-- NULL. The hand-written shape, NOT the bare `migrate diff` output, which added the NOT NULL
-- columns with no backfill and would fail on any populated database.

-- DropForeignKey
ALTER TABLE "ShipperContainer" DROP CONSTRAINT "ShipperContainer_orderContainerId_fkey";

-- DropForeignKey
ALTER TABLE "ShipperLine" DROP CONSTRAINT "ShipperLine_orderLineId_fkey";

-- DropForeignKey
ALTER TABLE "ShipperSerial" DROP CONSTRAINT "ShipperSerial_orderSerialId_fkey";

-- AlterTable: release the FKs, add the snapshot columns nullable-first
ALTER TABLE "ShipperLine" ADD COLUMN "partNumber" TEXT,
ADD COLUMN "partName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "partDescription" TEXT NOT NULL DEFAULT '',
ADD COLUMN "orderedQty" INTEGER,
ADD COLUMN "orderedWeight" DECIMAL(12,2),
ALTER COLUMN "orderLineId" DROP NOT NULL;

ALTER TABLE "ShipperContainer" ADD COLUMN "typeName" TEXT,
ADD COLUMN "customerContainerId" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "orderContainerId" DROP NOT NULL;

ALTER TABLE "ShipperSerial" ADD COLUMN "serial" TEXT,
ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "orderSerialId" DROP NOT NULL;

-- Backfill every existing row from the joins the RESTRICT constraints kept intact
UPDATE "ShipperLine" sl
SET "partNumber" = p."partNumber", "partName" = p."name", "partDescription" = p."description",
    "orderedQty" = ol."qty", "orderedWeight" = ol."weight"
FROM "OrderLine" ol
JOIN "Part" p ON p."id" = ol."partId"
WHERE ol."id" = sl."orderLineId";

UPDATE "ShipperContainer" sc
SET "typeName" = ct."name", "customerContainerId" = oc."customerContainerId"
FROM "OrderContainer" oc
JOIN "ContainerType" ct ON ct."id" = oc."typeId"
WHERE oc."id" = sc."orderContainerId";

UPDATE "ShipperSerial" ss
SET "serial" = os."serial", "description" = os."description"
FROM "OrderSerial" os
WHERE os."id" = ss."orderSerialId";

-- Enforce the columns the code treats as required
ALTER TABLE "ShipperLine" ALTER COLUMN "partNumber" SET NOT NULL,
ALTER COLUMN "orderedQty" SET NOT NULL,
ALTER COLUMN "orderedWeight" SET NOT NULL;

ALTER TABLE "ShipperContainer" ALTER COLUMN "typeName" SET NOT NULL;

ALTER TABLE "ShipperSerial" ALTER COLUMN "serial" SET NOT NULL;

-- AddForeignKey: same references, now SET NULL on delete
ALTER TABLE "ShipperLine" ADD CONSTRAINT "ShipperLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperContainer" ADD CONSTRAINT "ShipperContainer_orderContainerId_fkey" FOREIGN KEY ("orderContainerId") REFERENCES "OrderContainer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipperSerial" ADD CONSTRAINT "ShipperSerial_orderSerialId_fkey" FOREIGN KEY ("orderSerialId") REFERENCES "OrderSerial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

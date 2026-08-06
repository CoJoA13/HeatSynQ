-- #57 review: a RELEASED ShipperSerial (orderSerialId nulled by snapshot + release) lost its line
-- linkage, so the serialization warning falsely fired for a line whose serial still displays and
-- prints. Plain snapshot column (never an FK), backfilled from the join for every row still live;
-- rows released BEFORE this migration keep '' (their linkage is unrecoverable) and simply don't
-- credit a line — exactly the pre-fix behavior, never worse.

-- AlterTable
ALTER TABLE "ShipperSerial" ADD COLUMN "orderLineIdAtSave" TEXT NOT NULL DEFAULT '';

-- Backfill from rows whose order-side serial still exists
UPDATE "ShipperSerial" ss
SET "orderLineIdAtSave" = os."lineId"
FROM "OrderSerial" os
WHERE os."id" = ss."orderSerialId";

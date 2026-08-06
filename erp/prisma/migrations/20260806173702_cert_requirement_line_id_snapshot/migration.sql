-- #57 review: composite (linePosition, partNumber, partName) is still reusable when the SAME
-- part is re-added at a freed position — the seeding line's cuid is not. Plain snapshot column
-- (never an FK), backfilled from rows whose FK is still live; rows released before this
-- migration keep '' and consumers fall back to the composite identity for them.

-- AlterTable
ALTER TABLE "CertRequirement" ADD COLUMN "orderLineIdAtSeed" TEXT NOT NULL DEFAULT '';

-- Backfill from rows whose order line still exists
UPDATE "CertRequirement" SET "orderLineIdAtSeed" = "orderLineId" WHERE "orderLineId" IS NOT NULL;

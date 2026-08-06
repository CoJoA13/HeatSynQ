-- Ruling 23 extended (2026-08-06, PR #47 round 3): CertRequirement snapshots the line identity it
-- prints and releases its OrderLine FK, so a frozen requirement never blocks removeLine. Snapshot
-- columns added nullable-first, backfilled from the join the old RESTRICT kept intact, then SET
-- NOT NULL — the same hand-written shape as 20260806091506.

-- DropForeignKey
ALTER TABLE "CertRequirement" DROP CONSTRAINT "CertRequirement_orderLineId_fkey";

-- AlterTable
ALTER TABLE "CertRequirement" ADD COLUMN "linePosition" INTEGER,
ADD COLUMN "partNumber" TEXT,
ADD COLUMN "partName" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "orderLineId" DROP NOT NULL;

-- Backfill from the joins
UPDATE "CertRequirement" cr
SET "linePosition" = ol."position", "partNumber" = p."partNumber", "partName" = p."name"
FROM "OrderLine" ol
JOIN "Part" p ON p."id" = ol."partId"
WHERE ol."id" = cr."orderLineId";

-- Enforce
ALTER TABLE "CertRequirement" ALTER COLUMN "linePosition" SET NOT NULL,
ALTER COLUMN "partNumber" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "CertRequirement" ADD CONSTRAINT "CertRequirement_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

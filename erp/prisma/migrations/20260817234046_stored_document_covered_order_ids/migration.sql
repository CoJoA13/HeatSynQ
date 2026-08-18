-- #52 (owner ruling 2026-08-17): whole-shipment paper records at PRINT time which member orders
-- its render actually covered; `listDocumentsForOrder` reads this recorded coverage, never the
-- shipment's editable current membership. Per-order tickets and every other kind stay '{}'.
-- NOT an owner column — the hand-written kind→owner CHECK is deliberately untouched (the
-- `templateVersionId` precedent: present on every kind, identifies nothing).

-- AlterTable
ALTER TABLE "StoredDocument" ADD COLUMN     "coveredOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: every pre-existing whole-set document (a BOL, a whole-set SHIPPER ticket) predates
-- print-time coverage — the true at-print member set was never recorded and cannot be recovered.
-- The shipment's CURRENT member order ids are the best available approximation for pre-existing
-- paper (membership edits between the print and this migration are indistinguishable after the
-- fact); a fresh print records the real set from here on. Ordered by ticket position, the order
-- the paper itself prints in. This UPDATE stays the LAST statement in this file —
-- tests/documents.test.ts executes it verbatim to pin the backfill's shape.
UPDATE "StoredDocument" AS sd
SET "coveredOrderIds" = COALESCE(
  (SELECT array_agg(so."orderId" ORDER BY so."position")
     FROM "ShipperOrder" AS so
    WHERE so."shipperId" = sd."shipperId"),
  '{}')
WHERE sd."kind" IN ('SHIPPER', 'BOL')
  AND sd."shipperId" IS NOT NULL
  AND sd."orderId" IS NULL;

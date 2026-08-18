-- Codex PR #141 round 4: the two #65/#52 array columns were added with a DEFAULT but WITHOUT
-- NOT NULL — Prisma's client contract types them as required lists, so a NULL smuggled in by a
-- raw/import write would make coverage queries silently omit documents and `voidShipper` throw on
-- `.length`. The defensive UPDATEs cost nothing when no NULLs exist (none should) and make the
-- SET NOT NULL unconditionally safe.
UPDATE "Shipper" SET "reversalClearedLineIds" = '{}' WHERE "reversalClearedLineIds" IS NULL;
ALTER TABLE "Shipper" ALTER COLUMN "reversalClearedLineIds" SET NOT NULL;

UPDATE "StoredDocument" SET "coveredOrderIds" = '{}' WHERE "coveredOrderIds" IS NULL;
ALTER TABLE "StoredDocument" ALTER COLUMN "coveredOrderIds" SET NOT NULL;

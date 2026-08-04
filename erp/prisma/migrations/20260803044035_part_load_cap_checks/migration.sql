-- Defense-in-depth, folded into Phase 3 Task 6 from the Task 4 review: splitLoads
-- (src/lib/load-split.ts) loops `while (remainingQty > 0)`, dividing the order's totals by a
-- piece count derived from Part.loadQty/loadWeight each iteration. A loadQty of 0 (or a
-- non-positive loadWeight) would never shrink remainingQty and hang the request forever.
--
-- parts.ts's zod schema already refuses 0/negative loadQty and non-positive loadWeight at the
-- app layer before either value reaches Prisma, so under normal operation this CHECK should never
-- fire — it is a DB-level backstop against anything that bypasses the app layer (a raw SQL
-- script, a future migration, a manual edit), not a constraint the service is expected to trip.
--
-- Prisma's schema language has no native check-constraint syntax (no `@@check` — verified against
-- the Prisma docs; CHECK constraints must be added via raw SQL outside schema.prisma), so this
-- lives only here. schema.prisma's Part.loadQty/loadWeight fields carry a comment pointing back
-- at this file.
--
-- Explicitly spelling out "IS NULL OR" rather than relying on SQL's NULL-passes-a-CHECK
-- three-valued-logic behavior: both columns are optional (no cap is legal), and the intent should
-- read as obviously correct rather than depend on a reader already knowing that nuance.
ALTER TABLE "Part" ADD CONSTRAINT "Part_loadQty_check" CHECK ("loadQty" IS NULL OR "loadQty" >= 1);

ALTER TABLE "Part" ADD CONSTRAINT "Part_loadWeight_check" CHECK ("loadWeight" IS NULL OR "loadWeight" > 0);

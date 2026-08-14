-- Phase 7 Task 14 — retire the four standing-text Settings (design spec §8/§9).
--
-- Every document builder is now a config-consumer, and each standing text is owned by its
-- template's own text block: cert_statement (CERT), shipper_liability_text (SHIPPER and
-- MOS_SHIPPER), quote_intro_text and quote_liability_text (QUOTE). The four keys leave
-- settings.ts this task, so these Setting rows are now orphaned data.
--
-- Task 3's seed migration (20260812233950_seed_standard_templates) already COALESCE-copied every
-- one of these values FROM these Setting rows INTO the seeded template configs (jsonb_set +
-- COALESCE, code default as the fallback), so deleting the rows strands nothing: an owner-edited
-- value is already carried on the seeded template. On any real deployment the seed migration and
-- THIS deletion ship in one release, so no production install ever sees a customizable-then-
-- retired window — the whole-branch stranded-Setting check (Task 11 review).
--
-- Data-only, idempotent: no schema change (the Setting table is untouched), and a fresh install
-- that never wrote these rows is a harmless no-op.
DELETE FROM "Setting" WHERE "key" IN (
  'cert_statement',
  'shipper_liability_text',
  'quote_intro_text',
  'quote_liability_text'
);

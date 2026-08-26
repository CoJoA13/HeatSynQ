-- Issue #211 (owner ruling, 2026-08-25) — `action.apply_payments` becomes ENFORCED. The special
-- action was declared in Phase 5B (SPECIAL_ACTIONS, the roles editor, the spec's named-dangerous-
-- actions list) but no route ever checked it: applying cash was gated on `receivables.create`
-- alone. The companion code change adds `mustDo(apply_payments)` to
-- POST /api/receivables/applications and POST /api/receivables/credit-applications.
--
-- THE RULE: grant `action.apply_payments` to any LIVE role holding `receivables.create`. Before
-- the companion change, such a role could already apply cash — so this migration preserves what
-- every role could already do and confers nothing new (the owner's intent for the
-- `20260816130000_grant_manage_backups_to_admin_roles` backfill, and that migration's
-- predicate-that-does-not-decay lesson applied from the start: key on the ONE permission that
-- carried the ability, never on a snapshot of the whole permission set).
--
-- Per-user overrides are deliberately untouched, as they were for manage_backups: the admin UI
-- has never written overrides (they are an API-only surface), and a DENY override on
-- `action.apply_payments` that someone did set can only have MEANT "deny applying" — after this
-- migration it finally does exactly that.
--
-- `id` is NOT NULL with NO database default (Prisma generates cuid() client-side), so the raw
-- INSERT supplies gen_random_uuid()::text — core Postgres since 13; ids in this schema are opaque
-- text, so a uuid sits happily beside cuids. Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO "RolePermission" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'action.apply_payments'
  FROM "Role" r
 WHERE r."deletedAt" IS NULL
   AND EXISTS (
         SELECT 1 FROM "RolePermission" rp
          WHERE rp."roleId" = r."id" AND rp."permission" = 'receivables.create'
       )
    ON CONFLICT ("roleId", "permission") DO NOTHING;

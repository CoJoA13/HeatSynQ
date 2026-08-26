-- Issue #211, second backfill (Codex P1 on PR #240) — COMPLETES the predecessor migration
-- `20260825213000_grant_apply_payments_to_receivables_creators`, which stays exactly as it
-- shipped: an already-applied migration.sql is never edited in place
-- (.claude/hooks/protect-applied-migrations.sh, the P3009 lesson), so extending its rule means a
-- second migration — the `20260816130000_grant_manage_backups_to_admin_roles` precedent again.
--
-- THE GAP: the predecessor grants through ROLES only, but permission resolution honors per-user
-- overrides FIRST (DENY override → GRANT override → role grant → deny). A live user whose
-- `receivables.create` arrives as a UserPermissionOverride GRANT rather than through their role
-- could apply payments before `mustDo(apply_payments)` landed, and the role-only backfill
-- preserves nothing for them — this migration's predecessor comment called overrides out of
-- scope, and the review showed that carve-out breaks the preserve-what-they-could-do intent.
--
-- THE RULE: for every LIVE user holding a GRANT override on `receivables.create`, insert a GRANT
-- override on `action.apply_payments`. `ON CONFLICT DO NOTHING` on the (userId, permission)
-- unique key preserves ANY explicit override already present — including a DENY, which after the
-- enforcement change finally means what the admin who set it intended. A DENY on
-- `receivables.create` itself qualifies nobody (the user could not apply before either), and a
-- user whose role carries `receivables.create` is already preserved by the predecessor; an extra
-- GRANT override for one who also holds the create override is redundant but harmless.
--
-- `id` is NOT NULL with NO database default (Prisma generates cuid() client-side), so the raw
-- INSERT supplies gen_random_uuid()::text, the predecessor's shape.
INSERT INTO "UserPermissionOverride" ("id", "userId", "permission", "mode")
SELECT gen_random_uuid()::text, u."id", 'action.apply_payments', 'GRANT'::"OverrideMode"
  FROM "User" u
 WHERE u."deletedAt" IS NULL
   AND EXISTS (
         SELECT 1 FROM "UserPermissionOverride" o
          WHERE o."userId" = u."id"
            AND o."permission" = 'receivables.create'
            AND o."mode" = 'GRANT'
       )
    ON CONFLICT ("userId", "permission") DO NOTHING;

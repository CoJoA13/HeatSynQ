-- Phase 8C (owner decision, 2026-08-16) — SUPERSEDES the predecessor migration
-- `20260816120000_grant_manage_backups_to_full_roles`, which stays exactly as it shipped: it is
-- harmless (see below), so it is not edited, renamed, or removed. This is a genuinely SECOND
-- migration, not an in-place edit of the first — an already-applied migration.sql may never be
-- edited in place (a repo-level hook, .claude/hooks/protect-applied-migrations.sh, enforces this
-- after a real past incident, the P3009 failure class from Phase 3 Task 6), so once a migration has
-- shipped, correcting its rule means adding a new one.
--
-- THE RULE: grant `action.manage_backups` to any LIVE role holding BOTH `admin.view` AND
-- `action.manage_users`. Such a role can already create/edit roles and assign permissions to
-- them — including granting itself `manage_backups` directly through the admin UI — so this
-- migration confers no authority the role could not already take. That is the owner's original
-- intent for the predecessor migration too: preserve what a role could already do, never confer
-- something new. This restates it in a form that does not decay.
--
-- WHY A SECOND MIGRATION, NOT JUST THE FIRST ONE: the predecessor's all-64-permissions predicate
-- was correct the day it was written but decays as the permission set grows. `SPECIAL_ACTIONS`
-- (src/lib/permission-constants.ts) has grown at least three times since Phase 1
-- (`override_credit_hold` in Phase 4, `write_off` in Phase 5B, `manage_backups` itself now), areas
-- have been added too, and the seed (`prisma/seed.ts`, via ALL_PERMISSIONS) is the ONLY thing that
-- ever backfills an existing role's permission set — `migrate deploy` alone never does. A
-- production install seeded once and upgraded since would hold roughly 58 permissions, not 64, and
-- would never have satisfied the all-64 predicate: the predecessor migration would have been a
-- silent no-op on exactly the box it was written to protect.
--
-- WHY RUNNING BOTH IS SAFE: this rule is a strict SUPERSET of the predecessor's. Any role holding
-- all 64 other permissions necessarily holds `admin.view` and `action.manage_users` among them, so
-- every role the predecessor would have granted, this one grants too — nothing that qualified
-- before stops qualifying, and applying both in sequence (in either order, including re-running
-- either one) is idempotent via the shared `ON CONFLICT ("roleId", "permission") DO NOTHING`.
--
-- `id` is NOT NULL with NO database default: Prisma generates `cuid()` CLIENT-side, so a raw
-- INSERT has to supply one itself. `gen_random_uuid()` is core Postgres since 13 (no pgcrypto
-- extension needed); ids in this schema are opaque `text`, so a uuid sits happily beside cuids.
INSERT INTO "RolePermission" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'action.manage_backups'
  FROM "Role" r
 WHERE r."deletedAt" IS NULL
   AND EXISTS (
         SELECT 1 FROM "RolePermission" rp
          WHERE rp."roleId" = r."id" AND rp."permission" = 'admin.view'
       )
   AND EXISTS (
         SELECT 1 FROM "RolePermission" rp
          WHERE rp."roleId" = r."id" AND rp."permission" = 'action.manage_users'
       )
    ON CONFLICT ("roleId", "permission") DO NOTHING;

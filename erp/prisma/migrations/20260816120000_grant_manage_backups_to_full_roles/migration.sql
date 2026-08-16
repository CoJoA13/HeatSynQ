-- Phase 8C (owner decision, 2026-08-16). Backfill `action.manage_backups` onto roles that were
-- ALREADY fully privileged, so upgrading an existing install does not leave the Backups page
-- invisible and 403ing. The documented upgrade path runs `prisma migrate deploy` but never the
-- seed, and the seed is the only thing that grants ALL_PERMISSIONS.
--
-- This does NOT grant a new power to anyone: the WHERE clause fires only for a role that already
-- holds every OTHER permission in the system, so the role could already do everything else,
-- including editing roles. A role with partial grants is deliberately untouched — a limited user
-- must never silently gain a named dangerous action.
--
-- `id` is NOT NULL with NO database default: Prisma generates `cuid()` CLIENT-side, so a raw
-- INSERT has to supply one itself. `gen_random_uuid()` is core Postgres since 13 (no pgcrypto
-- extension needed); ids in this schema are opaque `text`, so a uuid sits happily beside cuids.
INSERT INTO "RolePermission" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'action.manage_backups'
  FROM "Role" r
 WHERE r."deletedAt" IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM (VALUES
    ('orders.view'),
    ('orders.create'),
    ('orders.edit'),
    ('orders.delete'),
    ('parts.view'),
    ('parts.create'),
    ('parts.edit'),
    ('parts.delete'),
    ('processes.view'),
    ('processes.create'),
    ('processes.edit'),
    ('processes.delete'),
    ('customers.view'),
    ('customers.create'),
    ('customers.edit'),
    ('customers.delete'),
    ('quotes.view'),
    ('quotes.create'),
    ('quotes.edit'),
    ('quotes.delete'),
    ('certs.view'),
    ('certs.create'),
    ('certs.edit'),
    ('certs.delete'),
    ('shipping.view'),
    ('shipping.create'),
    ('shipping.edit'),
    ('shipping.delete'),
    ('invoicing.view'),
    ('invoicing.create'),
    ('invoicing.edit'),
    ('invoicing.delete'),
    ('ar.view'),
    ('ar.create'),
    ('ar.edit'),
    ('ar.delete'),
    ('reports.view'),
    ('reports.create'),
    ('reports.edit'),
    ('reports.delete'),
    ('templates.view'),
    ('templates.create'),
    ('templates.edit'),
    ('templates.delete'),
    ('admin.view'),
    ('admin.create'),
    ('admin.edit'),
    ('admin.delete'),
    ('receivables.view'),
    ('receivables.create'),
    ('receivables.edit'),
    ('receivables.delete'),
    ('action.void_shipper'),
    ('action.unlock_invoice'),
    ('action.void_order'),
    ('action.change_prices'),
    ('action.edit_cert_results_after_print'),
    ('action.apply_payments'),
    ('action.run_qbo_export'),
    ('action.close_ar_period'),
    ('action.edit_templates'),
    ('action.manage_users'),
    ('action.override_credit_hold'),
    ('action.write_off')
           ) AS required(permission)
          WHERE NOT EXISTS (
                SELECT 1 FROM "RolePermission" rp
                 WHERE rp."roleId" = r."id"
                   AND rp."permission" = required.permission
              )
       )
    ON CONFLICT ("roleId", "permission") DO NOTHING;

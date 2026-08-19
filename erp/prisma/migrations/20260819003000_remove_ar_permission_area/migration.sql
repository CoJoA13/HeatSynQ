-- #72 (Round 2 Group H, 2026-08-19). Remove the vestigial `ar` permission area's granted rows.
--
-- `ar` was superseded by `receivables` in Phase 5B and no route ever authorized against it, but
-- seeded installs granted all four `ar.*` permissions to the admin role (the seed grants
-- ALL_PERMISSIONS), and overrides could name them too. Deleting the constant alone would strand
-- those rows: setRolePermissions/setUserOverrides round-trip the FULL permission list on every
-- save and reject unknown keys, so every subsequent whole-set role or override save would 400
-- with "Unknown permissions: ar.view". This data migration purges the stale rows so removing
-- "ar" from AREAS (src/lib/permission-constants.ts) is safe.
--
-- Raw unaudited DELETEs in a migration follow the 20260816120000 precedent (permission backfill):
-- a migration runs before the app exists to audit anything, and removing a permission no code can
-- check grants nothing and revokes nothing anyone could use. Explicit IN lists, never LIKE 'ar.%',
-- so the migration can only ever touch the four literals the retired area actually minted.
DELETE FROM "RolePermission"
 WHERE "permission" IN ('ar.view', 'ar.create', 'ar.edit', 'ar.delete');

DELETE FROM "UserPermissionOverride"
 WHERE "permission" IN ('ar.view', 'ar.create', 'ar.edit', 'ar.delete');

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "./helpers/db";
import { ALL_PERMISSIONS } from "@/server/permissions";

/**
 * Phase 8C Task 8 — the `action.manage_backups` permission-backfill migrations.
 *
 * TWO migrations exist on purpose, not one editing the other in place. An already-applied
 * migration.sql may never be edited — `.claude/hooks/protect-applied-migrations.sh` enforces that
 * (the P3009 lesson from Phase 3 Task 6) — so once the first migration had actually run, correcting
 * its rule meant adding a second one rather than rewriting it:
 *
 *   - `20260816120000_grant_manage_backups_to_full_roles` — the ORIGINAL rule: backfills a role
 *     holding ALL 64 other permissions. Still ships, still runs, still correct for what it checks —
 *     just a narrower predicate that decays as `SPECIAL_ACTIONS` grows (an install seeded once and
 *     upgraded since would hold ~58 permissions, never satisfying it).
 *   - `20260816130000_grant_manage_backups_to_admin_roles` — the REVISED, owner-chosen rule:
 *     backfills any live role holding BOTH `admin.view` AND `action.manage_users` — a role that can
 *     already grant itself this permission through the admin UI. Strictly BROADER than the first
 *     (any role holding all 64 necessarily holds both of these), so running both in sequence is
 *     safe and idempotent.
 *
 * Both migrations have already run against `erp_test`, so asserting against the live DB would be a
 * tautology — every test starts from `truncateAll()`, which wipes roles entirely. Instead these
 * tests prove each RULE by driving each migration's own SQL text via `$executeRawUnsafe(SQL)`
 * against hand-built fixture roles — the same drift-guard shape as tests/template-seed.test.ts. A
 * re-implementation of either predicate in TypeScript would pass even if the shipped SQL were
 * wrong; reading and executing the actual files closes that gap.
 */

const MIGRATION_1_PATH = join(
  process.cwd(),
  "prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql",
);
const MIGRATION_2_PATH = join(
  process.cwd(),
  "prisma/migrations/20260816130000_grant_manage_backups_to_admin_roles/migration.sql",
);
const SQL_ALL_64 = readFileSync(MIGRATION_1_PATH, "utf8");
const SQL_ADMIN_ROLES = readFileSync(MIGRATION_2_PATH, "utf8");

// Every `('permission.name')` line inside migration 1's VALUES(...) list. Its literals use this
// exact single-quoted-inside-parens shape for all 64 required permissions and nowhere else in the
// file (the INSERT target, the ON CONFLICT clause, and 'action.manage_backups' itself are all
// quoted without the wrapping parens), so the pattern isolates them cleanly.
const REQUIRED_PERMISSIONS = [...SQL_ALL_64.matchAll(/\('([a-z._]+)'\)/g)].map((m) => m[1]);

async function runAll64Migration(): Promise<void> {
  await prisma.$executeRawUnsafe(SQL_ALL_64);
}

async function runAdminRolesMigration(): Promise<void> {
  await prisma.$executeRawUnsafe(SQL_ADMIN_ROLES);
}

async function roleWithPermissions(name: string, permissions: string[], deletedAt?: Date) {
  return prisma.role.create({
    data: {
      name,
      deletedAt,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
}

async function hasManageBackups(roleId: string): Promise<boolean> {
  const row = await prisma.rolePermission.findFirst({
    where: { roleId, permission: "action.manage_backups" },
  });
  return row !== null;
}

describe("migration 1's own SQL literal (drift guard — parses the file, never a re-implementation)", () => {
  it("lists exactly the 64 permissions other than action.manage_backups, no duplicates", () => {
    expect(REQUIRED_PERMISSIONS).toHaveLength(64);
    expect(new Set(REQUIRED_PERMISSIONS).size).toBe(64);
    expect(REQUIRED_PERMISSIONS).not.toContain("action.manage_backups");
  });

  // The three checks above only pin the COUNT and shape of what the regex pulled out of the SQL —
  // a typo'd permission string PAIRED WITH an omitted one would still count 64, still contain no
  // duplicates, and still exclude "action.manage_backups" literally, and would still pass every
  // assertion above. Comparing the actual set against the real source of truth
  // (permission-constants.ts, via ALL_PERMISSIONS) is what catches a mistyped or substituted
  // entry — the dangerous direction, since a wrong entry only ever LOOSENS the migration's rule
  // (a role that should have been excluded gets backfilled instead). This still guards migration
  // 1's list; migration 2 has no list to drift (a two-permission EXISTS predicate).
  it("is exactly ALL_PERMISSIONS minus action.manage_backups — no typo'd or substituted entry", () => {
    const expected = ALL_PERMISSIONS.filter((p) => p !== "action.manage_backups");
    expect([...REQUIRED_PERMISSIONS].sort()).toEqual([...expected].sort());
  });
});

describe("migration 1 (20260816120000_grant_manage_backups_to_full_roles) — the all-64 rule", () => {
  beforeEach(truncateAll);

  it("grants action.manage_backups to a role holding all 64 other permissions", async () => {
    const role = await roleWithPermissions("Full Access", REQUIRED_PERMISSIONS);
    await runAll64Migration();
    expect(await hasManageBackups(role.id)).toBe(true);
  });

  it("does not grant it to a role missing exactly one of the 64", async () => {
    const almostAll = REQUIRED_PERMISSIONS.slice(1); // every permission except the first
    const role = await roleWithPermissions("Almost Full", almostAll);
    await runAll64Migration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("does not grant it to a role with no permissions", async () => {
    const role = await roleWithPermissions("No Access", []);
    await runAll64Migration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("re-running is a no-op — ON CONFLICT DO NOTHING means no duplicate row and no error", async () => {
    const role = await roleWithPermissions("Full Access", REQUIRED_PERMISSIONS);
    await runAll64Migration();
    await expect(runAll64Migration()).resolves.not.toThrow();
    const rows = await prisma.rolePermission.findMany({
      where: { roleId: role.id, permission: "action.manage_backups" },
    });
    expect(rows).toHaveLength(1);
  });

  it("does not touch a soft-deleted role, even one that held all 64 others", async () => {
    const role = await roleWithPermissions("Full Access (deleted)", REQUIRED_PERMISSIONS, new Date());
    await runAll64Migration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });
});

describe("migration 2 (20260816130000_grant_manage_backups_to_admin_roles) — the admin.view + action.manage_users rule", () => {
  beforeEach(truncateAll);

  it("grants it to a role holding admin.view + action.manage_users with FEW other permissions — the case the all-64 rule missed", async () => {
    const role = await roleWithPermissions("Role Admin", ["admin.view", "action.manage_users", "orders.view"]);
    await runAdminRolesMigration();
    expect(await hasManageBackups(role.id)).toBe(true);
  });

  it("does not grant it to a role with admin.view only", async () => {
    const role = await roleWithPermissions("View Only", ["admin.view"]);
    await runAdminRolesMigration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("does not grant it to a role with action.manage_users only", async () => {
    const role = await roleWithPermissions("User Manager Only", ["action.manage_users"]);
    await runAdminRolesMigration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("does not grant it to a role with neither permission", async () => {
    const role = await roleWithPermissions("Neither", ["orders.view", "parts.view"]);
    await runAdminRolesMigration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("does not touch a soft-deleted role, even one holding both", async () => {
    const role = await roleWithPermissions(
      "Role Admin (deleted)", ["admin.view", "action.manage_users"], new Date(),
    );
    await runAdminRolesMigration();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("re-running is a no-op — ON CONFLICT DO NOTHING means no duplicate row and no error", async () => {
    const role = await roleWithPermissions("Role Admin", ["admin.view", "action.manage_users"]);
    await runAdminRolesMigration();
    await expect(runAdminRolesMigration()).resolves.not.toThrow();
    const rows = await prisma.rolePermission.findMany({
      where: { roleId: role.id, permission: "action.manage_backups" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("both migrations applied in sequence (the interaction the owner's superset choice makes possible)", () => {
  beforeEach(truncateAll);

  it("an all-64 role ends with exactly one action.manage_backups row after both migrations run — no duplicate, no error", async () => {
    const role = await roleWithPermissions("Full Access", REQUIRED_PERMISSIONS);
    await runAll64Migration(); // grants it first, under the original rule
    await expect(runAdminRolesMigration()).resolves.not.toThrow(); // the superset rule hits ON CONFLICT DO NOTHING
    const rows = await prisma.rolePermission.findMany({
      where: { roleId: role.id, permission: "action.manage_backups" },
    });
    expect(rows).toHaveLength(1);
  });
});

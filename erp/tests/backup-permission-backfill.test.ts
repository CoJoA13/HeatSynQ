import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "./helpers/db";
import { ALL_PERMISSIONS } from "@/server/permissions";

/**
 * Phase 8C Task 8 — the `action.manage_backups` permission-backfill migration
 * (`prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql`).
 *
 * The migration has already run against `erp_test` (Task 8's `migrate deploy`), so asserting
 * against the live DB here would be a tautology — every test starts from `truncateAll()`, which
 * wipes roles entirely. Instead this test proves the RULE by driving the migration's own SQL text
 * a second time via `$executeRawUnsafe(SQL)` against hand-built fixture roles — the same
 * drift-guard shape as tests/template-seed.test.ts. A re-implementation of the predicate in
 * TypeScript would pass even if the shipped SQL were wrong; reading and executing the actual file
 * closes that gap.
 *
 * The 64-permission list itself is parsed out of the SQL file rather than re-typed here — a second
 * hand-copied list in the test is exactly the kind of paraphrase that could quietly drift from the
 * migration's own VALUES(...) list.
 */

const MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20260816120000_grant_manage_backups_to_full_roles/migration.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

// Every `('permission.name')` line inside the VALUES(...) list. The migration's own literals use
// this exact single-quoted-inside-parens shape for all 64 required permissions and nowhere else
// in the file (the INSERT target, the ON CONFLICT clause, and 'action.manage_backups' itself are
// all quoted without the wrapping parens), so the pattern isolates them cleanly.
const REQUIRED_PERMISSIONS = [...SQL.matchAll(/\('([a-z._]+)'\)/g)].map((m) => m[1]);

async function runMigrationSql(): Promise<void> {
  await prisma.$executeRawUnsafe(SQL);
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

describe("the migration's own SQL literal (drift guard — parses the file, never a re-implementation)", () => {
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
  // (a role that should have been excluded gets backfilled instead).
  it("is exactly ALL_PERMISSIONS minus action.manage_backups — no typo'd or substituted entry", () => {
    const expected = ALL_PERMISSIONS.filter((p) => p !== "action.manage_backups");
    expect([...REQUIRED_PERMISSIONS].sort()).toEqual([...expected].sort());
  });
});

describe("backup-permission backfill (executes prisma/migrations/20260816120000_.../migration.sql)", () => {
  beforeEach(truncateAll);

  it("grants action.manage_backups to a role holding all 64 other permissions", async () => {
    const role = await roleWithPermissions("Full Access", REQUIRED_PERMISSIONS);
    await runMigrationSql();
    expect(await hasManageBackups(role.id)).toBe(true);
  });

  it("does not grant it to a role missing exactly one of the 64", async () => {
    const almostAll = REQUIRED_PERMISSIONS.slice(1); // every permission except the first
    const role = await roleWithPermissions("Almost Full", almostAll);
    await runMigrationSql();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("does not grant it to a role with no permissions", async () => {
    const role = await roleWithPermissions("No Access", []);
    await runMigrationSql();
    expect(await hasManageBackups(role.id)).toBe(false);
  });

  it("re-running is a no-op — ON CONFLICT DO NOTHING means no duplicate row and no error", async () => {
    const role = await roleWithPermissions("Full Access", REQUIRED_PERMISSIONS);
    await runMigrationSql();
    await expect(runMigrationSql()).resolves.not.toThrow();
    const rows = await prisma.rolePermission.findMany({
      where: { roleId: role.id, permission: "action.manage_backups" },
    });
    expect(rows).toHaveLength(1);
  });

  it("does not touch a soft-deleted role, even one that held all 64 others", async () => {
    const role = await roleWithPermissions("Full Access (deleted)", REQUIRED_PERMISSIONS, new Date());
    await runMigrationSql();
    expect(await hasManageBackups(role.id)).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "./helpers/db";

/**
 * #211 — the `action.apply_payments` permission backfill.
 *
 * The special action existed unenforced from Phase 5B until #211's owner ruling (2026-08-25)
 * wired it into POST /api/receivables/applications and /credit-applications. Before that wiring,
 * `receivables.create` alone let a session apply cash — so the migration grants
 * `action.apply_payments` to every LIVE role holding `receivables.create`, preserving what each
 * role could already do and never conferring anything new (the
 * `20260816130000_grant_manage_backups_to_admin_roles` precedent, including its
 * predicate-that-does-not-decay lesson: the rule keys on the ONE permission that carried the
 * ability, not on a snapshot of the whole permission set).
 *
 * The migration has already run against `erp_test`, and every test starts from `truncateAll()`,
 * so these tests prove the RULE by executing the shipped migration.sql itself against hand-built
 * fixture roles (the backup-permission-backfill.test.ts drift-guard shape) — a TypeScript
 * re-implementation of the predicate would stay green even if the shipped SQL were wrong.
 */
const MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20260825213000_grant_apply_payments_to_receivables_creators/migration.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

// The role-only rule above misses ONE preserved-ability case (Codex P1 on PR #240): a live user
// whose `receivables.create` arrives as a UserPermissionOverride GRANT rather than through their
// role. The first migration was already applied to both databases, and an applied migration.sql
// is never edited in place (.claude/hooks/protect-applied-migrations.sh, the P3009 lesson) — so
// the override half is a SECOND migration, the manage_backups two-migration precedent.
const OVERRIDE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20260825224500_grant_apply_payments_to_override_holders/migration.sql",
);
const OVERRIDE_SQL = readFileSync(OVERRIDE_MIGRATION_PATH, "utf8");

async function runMigration(): Promise<void> {
  await prisma.$executeRawUnsafe(SQL);
}

async function runOverrideMigration(): Promise<void> {
  await prisma.$executeRawUnsafe(OVERRIDE_SQL);
}

async function roleWithPermissions(name: string, permissions: string[], deletedAt?: Date) {
  return prisma.role.create({
    data: {
      name,
      ...(deletedAt ? { deletedAt } : {}),
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
}

async function granted(roleId: string): Promise<boolean> {
  return (await prisma.rolePermission.count({
    where: { roleId, permission: "action.apply_payments" },
  })) === 1;
}

beforeEach(truncateAll);

describe("apply_payments backfill migration (#211)", () => {
  it("grants action.apply_payments to a live role holding receivables.create", async () => {
    const role = await roleWithPermissions("AR Clerk", ["receivables.view", "receivables.create"]);
    await runMigration();
    expect(await granted(role.id)).toBe(true);
  });

  it("does not grant to a role without receivables.create", async () => {
    const viewer = await roleWithPermissions("AR Viewer", ["receivables.view", "receivables.edit"]);
    await runMigration();
    expect(await granted(viewer.id)).toBe(false);
  });

  it("does not grant to a soft-deleted role, even one holding receivables.create", async () => {
    const dead = await roleWithPermissions("Retired", ["receivables.create"], new Date());
    await runMigration();
    expect(await granted(dead.id)).toBe(false);
  });

  it("is idempotent: re-running never duplicates an existing grant", async () => {
    const role = await roleWithPermissions("AR Clerk", [
      "receivables.create", "action.apply_payments",
    ]);
    await runMigration();
    await runMigration();
    expect(await prisma.rolePermission.count({
      where: { roleId: role.id, permission: "action.apply_payments" },
    })).toBe(1);
  });
});

async function userWithOverrides(
  username: string,
  overrides: Array<{ permission: string; mode: "GRANT" | "DENY" }>,
  deletedAt?: Date,
) {
  const role = await roleWithPermissions(`role-${username}`, ["receivables.view"]);
  return prisma.user.create({
    data: {
      username, displayName: username, passwordHash: "x", roleId: role.id,
      ...(deletedAt ? { deletedAt } : {}),
      overrides: { create: overrides },
    },
  });
}

async function overrideModeFor(userId: string): Promise<string | null> {
  const row = await prisma.userPermissionOverride.findUnique({
    where: { userId_permission: { userId, permission: "action.apply_payments" } },
  });
  return row?.mode ?? null;
}

describe("apply_payments override-holder backfill migration (#211, Codex P1 on PR #240)", () => {
  it("grants a GRANT override to a live user whose receivables.create is itself an override GRANT", async () => {
    const u = await userWithOverrides("ov-holder", [{ permission: "receivables.create", mode: "GRANT" }]);
    await runOverrideMigration();
    expect(await overrideModeFor(u.id)).toBe("GRANT");
  });

  it("preserves an explicit DENY override on action.apply_payments", async () => {
    const u = await userWithOverrides("ov-denied", [
      { permission: "receivables.create", mode: "GRANT" },
      { permission: "action.apply_payments", mode: "DENY" },
    ]);
    await runOverrideMigration();
    expect(await overrideModeFor(u.id)).toBe("DENY");
  });

  it("grants nothing to a soft-deleted user or to a DENY on receivables.create", async () => {
    const dead = await userWithOverrides("ov-dead", [{ permission: "receivables.create", mode: "GRANT" }], new Date());
    const denied = await userWithOverrides("ov-create-denied", [{ permission: "receivables.create", mode: "DENY" }]);
    await runOverrideMigration();
    expect(await overrideModeFor(dead.id)).toBeNull();
    expect(await overrideModeFor(denied.id)).toBeNull();
  });

  it("is idempotent: re-running never duplicates or rewrites an override", async () => {
    const u = await userWithOverrides("ov-idem", [{ permission: "receivables.create", mode: "GRANT" }]);
    await runOverrideMigration();
    await runOverrideMigration();
    expect(await prisma.userPermissionOverride.count({
      where: { userId: u.id, permission: "action.apply_payments" },
    })).toBe(1);
    expect(await overrideModeFor(u.id)).toBe("GRANT");
  });
});

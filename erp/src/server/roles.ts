import { prisma } from "./db";
import { HttpError } from "./errors";
import { ALL_PERMISSIONS } from "./permissions";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { withDbErrors } from "./db-errors";

export async function listRoles() {
  const roles = await prisma.role.findMany({
    where: { deletedAt: null },
    include: { permissions: true, _count: { select: { users: { where: { deletedAt: null } } } } },
    orderBy: { name: "asc" },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: r.permissions.map((p) => p.permission).sort(),
    userCount: r._count.users,
  }));
}

export async function createRole(name: string): Promise<{ id: string }> {
  // findFirst, NOT findUnique — Role.name is unique only among live rows, but the client still
  // types it unique, so findUnique compiles and returns the soft-deleted row instead.
  const existing = await prisma.role.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
  if (existing) throw new HttpError(400, "A role with that name already exists");

  const role = await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedCreate("role", { name }, () => tx.role.create({ data: { name } }), { tx })));
  return { id: role.id };
}

export async function renameRole(roleId: string, name: string): Promise<void> {
  const existing = await prisma.role.findFirst({
    where: { name, deletedAt: null, NOT: { id: roleId } },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A role with that name already exists");
  await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("role", roleId, () => tx.role.update({ where: { id: roleId }, data: { name } }), { tx })));
}

export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.join(", ")}`);
  await prisma.$transaction((tx) =>
    auditedUpdate("role", roleId, async () => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) });
    }, { tx }));
}

/**
 * `reason` is required, not optional — spec §9's "destructive-ish actions require a reason".
 * Role delete qualifies on two counts: it carries the role's permission grants away, and it
 * frees the role name for reuse by an unrelated future role. Enforced in the service rather
 * than only at the route so no future caller can bypass it, matching deleteCustomer.
 *
 * Requiring a reason on EVERY delete was considered and rejected (handoff §5.17): demanding a
 * justification for a carrier typed wrong four seconds earlier trains people to type "x".
 */
export async function deleteRole(roleId: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a role");
  const holders = await prisma.user.count({ where: { roleId, deletedAt: null } });
  if (holders > 0) throw new HttpError(400, "Role is assigned to users");
  await withDbErrors({ entity: "Role" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("role", roleId, why, tx)));
}

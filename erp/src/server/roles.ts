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

  const role = await auditedCreate("role", { name }, () =>
    withDbErrors({ entity: "Role", conflictField: "name" }, () => prisma.role.create({ data: { name } })));
  return { id: role.id };
}

export async function renameRole(roleId: string, name: string): Promise<void> {
  const existing = await prisma.role.findFirst({
    where: { name, deletedAt: null, NOT: { id: roleId } },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A role with that name already exists");
  await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    auditedUpdate("role", roleId, () => prisma.role.update({ where: { id: roleId }, data: { name } })));
}

export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.join(", ")}`);
  await auditedUpdate("role", roleId, () =>
    prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId } }),
      prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) }),
    ]),
  );
}

export async function deleteRole(roleId: string): Promise<void> {
  const holders = await prisma.user.count({ where: { roleId, deletedAt: null } });
  if (holders > 0) throw new HttpError(400, "Role is assigned to users");
  await auditedSoftDelete("role", roleId);
}

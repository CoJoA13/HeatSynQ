import { prisma } from "./db";
import { HttpError } from "./http";
import { hashPassword } from "./password";
import { ALL_PERMISSIONS } from "./permissions";

export async function listUsers() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    include: { role: true, overrides: true },
    orderBy: { username: "asc" },
  });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    roleName: u.role?.name ?? null,
    roleId: u.roleId,
    active: u.active,
    overrides: u.overrides.map((o) => ({ permission: o.permission, mode: o.mode })),
  }));
}

export async function createUser(input: { username: string; displayName: string; password: string; roleId?: string }) {
  const dupe = await prisma.user.findUnique({ where: { username: input.username } });
  if (dupe) throw new HttpError(400, "That username is taken");
  const user = await prisma.user.create({
    data: {
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      roleId: input.roleId ?? null,
    },
  });
  return { id: user.id };
}

export async function updateUser(
  id: string,
  input: { displayName?: string; roleId?: string | null; active?: boolean; password?: string },
) {
  await prisma.user.update({
    where: { id },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    },
  });
}

export async function setUserOverrides(id: string, overrides: { permission: string; mode: "GRANT" | "DENY" }[]) {
  const unknown = overrides.filter((o) => !ALL_PERMISSIONS.includes(o.permission));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.map((o) => o.permission).join(", ")}`);
  await prisma.$transaction([
    prisma.userPermissionOverride.deleteMany({ where: { userId: id } }),
    prisma.userPermissionOverride.createMany({
      data: overrides.map((o) => ({ userId: id, permission: o.permission, mode: o.mode })),
    }),
  ]);
}

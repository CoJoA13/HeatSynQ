import { prisma } from "./db";
import { HttpError } from "./errors";
import { hashPassword } from "./password";
import { ALL_PERMISSIONS, canDo } from "./permissions";
import { auditedCreate, auditedUpdate } from "./audit";
import { currentActor } from "./context";
import { withDbErrors } from "./db-errors";

/** Active, non-deleted users whose effective permissions currently include action.manage_users. */
async function activeManageUsersHolders() {
  const users = await prisma.user.findMany({
    where: { active: true, deletedAt: null },
    include: { role: { include: { permissions: true } }, overrides: true },
  });
  return users.filter((u) => canDo(u, "manage_users"));
}

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
  // Destructure the plaintext password out before it reaches the audit log: redact() only
  // strips keys containing "passwordhash", so spreading the raw `input` (which carries
  // `password`) would leak the plaintext into the "after" snapshot. `rest` carries every
  // other field; `passwordHash: "set"` records that a password was set without exposing it.
  const { password, ...rest } = input;
  const user = await withDbErrors({ entity: "User", conflictField: "username" }, () =>
    prisma.$transaction((tx) =>
      auditedCreate("user", { ...rest, passwordHash: "set" }, async () =>
        tx.user.create({
          data: {
            username: input.username,
            displayName: input.displayName,
            passwordHash: await hashPassword(password),
            roleId: input.roleId ?? null,
          },
        }), { tx })));
  return { id: user.id };
}

export async function updateUser(
  id: string,
  input: { displayName?: string; roleId?: string | null; active?: boolean; password?: string },
) {
  if (input.active === false && id === currentActor().id) {
    throw new HttpError(400, "You cannot deactivate your own account");
  }

  // Guard against locking everyone out of user management: only relevant when active or roleId
  // is changing, and only when the target is *currently* the sole active manage_users holder.
  if (input.active === false || input.roleId !== undefined) {
    const holders = await activeManageUsersHolders();
    const target = holders.find((h) => h.id === id);
    if (target && holders.length === 1) {
      const stillActive = input.active !== undefined ? input.active : target.active;
      const role =
        input.roleId !== undefined && input.roleId !== target.roleId
          ? input.roleId
            ? await prisma.role.findUnique({ where: { id: input.roleId }, include: { permissions: true } })
            : null
          : target.role;
      const stillManages = stillActive && canDo({ role, overrides: target.overrides }, "manage_users");
      if (!stillManages) throw new HttpError(400, "Cannot remove the last user manager");
    }
  }

  await withDbErrors({ entity: "User" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("user", id, async () =>
        tx.user.update({
          where: { id },
          data: {
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
            ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
          },
        }), { tx })));
}

export async function setUserOverrides(id: string, overrides: { permission: string; mode: "GRANT" | "DENY" }[]) {
  const unknown = overrides.filter((o) => !ALL_PERMISSIONS.includes(o.permission));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.map((o) => o.permission).join(", ")}`);
  await prisma.$transaction((tx) =>
    auditedUpdate("user", id, async () => {
      await tx.userPermissionOverride.deleteMany({ where: { userId: id } });
      await tx.userPermissionOverride.createMany({
        data: overrides.map((o) => ({ userId: id, permission: o.permission, mode: o.mode })),
      });
    }, { tx }));
}

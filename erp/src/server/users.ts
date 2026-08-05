import { prisma } from "./db";
import { HttpError } from "./errors";
import { hashPassword } from "./password";
import { ALL_PERMISSIONS, canDo } from "./permissions";
import { auditedCreate, auditedUpdate } from "./audit";
import { currentActor } from "./context";
import { withDbErrors } from "./db-errors";

/**
 * Active, non-deleted users whose effective permissions currently include action.manage_users.
 *
 * Explicit `select` (never the old `include: { role: {...}, overrides: true }`, which pulls
 * every scalar on User) — this runs on every `updateUser` call that changes `active` or `roleId`,
 * a routine admin action, and the old blanket include pulled up to SIGNATURE_MAX_BYTES of
 * signature bytes (plus passwordHash) per active user just to compute a permission check that
 * only ever reads id/active/roleId/role.permissions/overrides. Same fix as `listUsers` below, in
 * the same file, for the same reason — this is the sibling that fix was supposed to catch too.
 */
async function activeManageUsersHolders() {
  const users = await prisma.user.findMany({
    where: { active: true, deletedAt: null },
    select: {
      id: true, active: true, roleId: true,
      role: { select: { permissions: { select: { permission: true } } } },
      overrides: { select: { permission: true, mode: true } },
    },
  });
  return users.filter((u) => canDo(u, "manage_users"));
}

export async function listUsers() {
  // Explicit `select` (never the old `include: { role: true, overrides: true }`, which pulls
  // every scalar on User) — Task 12 gave `signatureImage` real bytes for the first time, and this
  // list is refetched on every admin/users page load and every mutation on it. Pulling up to
  // SIGNATURE_MAX_BYTES per row into a list nobody renders bytes from is exactly the "real memory
  // pressure for a value nothing ever needed" shape SNAPSHOT_SELECT (audit.ts) already exists to
  // avoid for the attachment tables; this is the same fix applied at the query that actually feeds
  // this screen. `passwordHash` drops out too, for free.
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true, username: true, displayName: true, roleId: true, active: true,
      role: { select: { name: true } },
      overrides: { select: { permission: true, mode: true } },
    },
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
  // select: { id: true } — this is a bare existence check (`if (dupe)`); no reason to pull the
  // full row, signature bytes included, just to learn whether one exists.
  const dupe = await prisma.user.findUnique({ where: { username: input.username }, select: { id: true } });
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

// 2 MB — small enough that pulling it into a before/after audit snapshot would be real memory
// pressure for a value nothing there ever needs (SNAPSHOT_SELECT's `user` entry, audit.ts, is the
// other half of that guarantee); large enough for a real scanned or drawn signature.
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
// Per task-12-brief.md's interface — png/jpeg cover the common web image types, bmp besides.
export const SIGNATURE_MIME = ["image/png", "image/jpeg", "image/bmp"] as const;

/**
 * Owner ruling (spec §3.11): the signature that prints on a certification is the PRINTING user's
 * own — no signer selection, no config key. This is the one and only writer of that image; there
 * is no separate "signer" concept anywhere in this codebase for Task 19's cert layout to consume.
 *
 * Follows the attachments.ts precedent (parseUploadFile/assertDeclaredUploadSize upstream in the
 * route, a size cap and a MIME allowlist here) at a much smaller scale — one image per user
 * rather than an unbounded list, so there is no separate list/get-by-id shape, just the three
 * verbs a single optional field needs.
 */
export async function setSignature(userId: string, data: Buffer, mimeType: string): Promise<void> {
  if (!(SIGNATURE_MIME as readonly string[]).includes(mimeType)) {
    throw new HttpError(400, `Signature images must be one of: ${SIGNATURE_MIME.join(", ")}`);
  }
  if (data.byteLength > SIGNATURE_MAX_BYTES) {
    throw new HttpError(400, `Signature images cannot exceed ${SIGNATURE_MAX_BYTES / (1024 * 1024)} MB`);
  }
  // No upfront findFirst/existence check: `tx.user.update` on an id that doesn't exist raises
  // Prisma's P2025, which withDbErrors already translates to the same "User not found" 404 —
  // updateUser (above) relies on the identical path rather than a redundant pre-check.
  //
  // `new Uint8Array(data)`, not `data` itself: Prisma's `Bytes` input is typed
  // `Uint8Array<ArrayBuffer>`, and Node's `Buffer` is `Uint8Array<ArrayBufferLike>`, which that
  // does not accept (the storeDocument precedent, documents.ts).
  await withDbErrors({ entity: "User" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("user", userId, () =>
        tx.user.update({
          where: { id: userId }, data: { signatureImage: new Uint8Array(data), signatureMimeType: mimeType },
        }),
      { tx })));
}

export async function clearSignature(userId: string): Promise<void> {
  await withDbErrors({ entity: "User" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("user", userId, () =>
        tx.user.update({ where: { id: userId }, data: { signatureImage: null, signatureMimeType: null } }),
      { tx })));
}

export async function getSignature(userId: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { signatureImage: true, signatureMimeType: true },
  });
  if (!user) throw new HttpError(404, "User not found");
  if (!user.signatureImage || !user.signatureMimeType) return null;
  // Prisma's `Bytes` scalar is a bare Uint8Array (see attachments.ts's identical comment on
  // getAttachment) — Buffer.from guarantees the real Node Buffer this function's type promises.
  return { data: Buffer.from(user.signatureImage), mimeType: user.signatureMimeType };
}

import { prisma } from "./db";
import { HttpError } from "./errors";
import { hashPassword } from "./password";
import { ALL_PERMISSIONS, canDo } from "./permissions";
import { auditedCreate, auditedUpdate } from "./audit";
import { currentActor } from "./context";
import { withDbErrors } from "./db-errors";
import { matchesDeclaredImage } from "./image-sniff";

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
  //
  // Two signature columns this read may touch, and ONLY these two — `signatureMimeType` (#160) and,
  // since #171, `signatureUpdatedAt`. Both stand proxy for the bytes exactly as `hasLogo` does in
  // templates.ts's `toVersionSummary`; NEVER `signatureImage: true`, which would undo the narrowing
  // these comments exist to protect. Fidelity: `setSignature`/`clearSignature` below always write
  // all three columns together, and `getSignature` returns null unless image AND mime are non-null,
  // so only a hand-written database row could desync them — and in that direction the flag reads
  // "no signature" while GET 404s, the harmless side: UserSignatureControl's `onError` belt still
  // lands right. `tests/user-signature.test.ts`'s "#160" block pins the select shape, not just the
  // payload.
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true, username: true, displayName: true, title: true, roleId: true, active: true,
      signatureMimeType: true, signatureUpdatedAt: true,
      role: { select: { name: true } },
      overrides: { select: { permission: true, mode: true } },
    },
    orderBy: { username: "asc" },
  });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    title: u.title,
    roleName: u.role?.name ?? null,
    roleId: u.roleId,
    active: u.active,
    // A boolean is the whole existence payload: the screen renders a preview `<img>` or the "No
    // signature" placeholder, and neither needs the mime type. Shipping the flag alone is what stops
    // one 404 per signature-less user on every /admin/users load (#160).
    hasSignature: u.signatureMimeType !== null,
    // The revision the preview URL cache-busts on (#171) — epoch millis of `signatureUpdatedAt`, or
    // null before the image has ever been written. It MOVES on every set/clear, so a stale failed
    // preview retries by construction on ANY change; still bytes-free, the whole point of #160.
    signatureRev: u.signatureUpdatedAt?.getTime() ?? null,
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
  // `title` prints on the quote and cert signature blocks (Phase 6 ruling 14); "" clears it and
  // both builders then omit the line rather than print a blank.
  input: { displayName?: string; title?: string; roleId?: string | null; active?: boolean; password?: string },
  // #237: when the same request also replaces overrides, they ride into the ONE shared
  // transaction below rather than a second one — pass-through for updateUserWithOverrides,
  // already validated there; direct callers omit it.
  overrides?: { permission: string; mode: "GRANT" | "DENY" }[],
) {
  if (input.active === false && id === currentActor().id) {
    throw new HttpError(400, "You cannot deactivate your own account");
  }

  // The last-manager guard used to live here; since #250 it is the first act of `writeUser`, so
  // the overrides-only paths cannot skip it. This function keeps only the check that is genuinely
  // about the CALLER rather than the target.
  await writeUser(id, input, overrides);
}

export async function setUserOverrides(id: string, overrides: { permission: string; mode: "GRANT" | "DENY" }[]) {
  await writeUser(id, undefined, overrides);
}

/**
 * The route-facing combination (#237): PUT /api/admin/users/[id] may carry fields AND overrides,
 * and running them as two service calls half-committed — the field update landed (and audited),
 * then the overrides 400'd on an unknown permission, with only the error reported back. Every
 * refusal now runs before the one shared transaction below, so a rejected request leaves nothing
 * behind, and the combined write lands as ONE audit entry — one actor action, one entry, with the
 * before/after snapshots carrying both the fields and the overrides (SNAPSHOT_INCLUDE pulls the
 * override rows in).
 */
export async function updateUserWithOverrides(
  id: string,
  input: Parameters<typeof updateUser>[1] | undefined,
  overrides: { permission: string; mode: "GRANT" | "DENY" }[] | undefined,
) {
  if (input && Object.keys(input).length) {
    await updateUser(id, input, overrides); // runs updateUser's own guards, then the shared writer
  } else if (overrides) {
    await writeUser(id, undefined, overrides);
  }
}

/**
 * Refuse a write that would leave nobody able to manage users.
 *
 * **JUDGED ON THE POST-WRITE STATE, and that is the whole of #250.** The old guard lived in
 * `updateUser`, ran only when `active` or `roleId` was in the input, and read the target's
 * overrides as they stood BEFORE the write. Both halves were holes:
 *
 *  - a request that only replaced overrides never reached it — `setUserOverrides` and the
 *    overrides-only branch of `updateUserWithOverrides` go straight to the writer — so a DENY on
 *    `action.manage_users` committed and locked everyone out, the exact outcome it exists to
 *    prevent, one write path over;
 *  - and when it DID run, a DENY riding in the same body was invisible to it, because it asked
 *    `canDo` about the overrides being replaced rather than the ones arriving.
 *
 * It was also wrong in the OTHER direction, which is why this cannot simply refuse any override
 * write on the sole manager: dropping the role while granting `action.manage_users` by override
 * leaves that user still managing users, and the old code refused it (pinned in users.test.ts).
 *
 * It lives HERE, as the first act of the one shared writer, for the reason `assertKnownPermissions`
 * does: every path to the write then validates by construction rather than by caller discipline.
 * Pre-transaction, so a refusal leaves nothing behind.
 *
 * The `activeManageUsersHolders` query is gated on a write that could REMOVE the permission —
 * deactivation, a role change, or any override replacement. A rename or a password reset skips it,
 * which is what keeps that findMany off the routine admin actions (see its own docstring).
 */
async function assertLastManagerSurvives(
  id: string,
  input: Parameters<typeof updateUser>[1] | undefined,
  overrides: { permission: string; mode: "GRANT" | "DENY" }[] | undefined,
) {
  const nextActive = input?.active;
  const nextRoleId = input?.roleId;
  if (nextActive !== false && nextRoleId === undefined && overrides === undefined) return;

  const holders = await activeManageUsersHolders();
  const target = holders.find((h) => h.id === id);
  // Only the SOLE holder is protected: with a second manager active, removing this one locks
  // nobody out. A target that does not hold the permission cannot be the one keeping the door open.
  if (!target || holders.length !== 1) return;

  const stillActive = nextActive !== undefined ? nextActive : target.active;
  const role =
    nextRoleId !== undefined && nextRoleId !== target.roleId
      ? nextRoleId
        ? await prisma.role.findUnique({ where: { id: nextRoleId }, include: { permissions: true } })
        : null
      : target.role;
  // `overrides` REPLACES the set wholesale (`writeUser` deletes then re-creates), so the post-write
  // set is the incoming array when one is present — never a merge with what is there.
  const nextOverrides = overrides ?? target.overrides;
  const stillManages = stillActive && canDo({ role, overrides: nextOverrides }, "manage_users");
  if (!stillManages) throw new HttpError(400, "Cannot remove the last user manager");
}

function assertKnownPermissions(overrides: { permission: string }[]) {
  const unknown = overrides.filter((o) => !ALL_PERMISSIONS.includes(o.permission));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.map((o) => o.permission).join(", ")}`);
}

/** ONE transaction, ONE auditedUpdate, applying whichever parts are present (#237). BOTH refusals
 *  live HERE — first acts, still pre-transaction — so every path to the write validates by
 *  construction rather than by caller discipline (review Minor 1, and #250 for the second). */
async function writeUser(
  id: string,
  input: Parameters<typeof updateUser>[1] | undefined,
  overrides: { permission: string; mode: "GRANT" | "DENY" }[] | undefined,
) {
  if (overrides) assertKnownPermissions(overrides);
  await assertLastManagerSurvives(id, input, overrides);
  await withDbErrors({ entity: "User" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("user", id, async () => {
        const updated = input
          ? await tx.user.update({
              where: { id },
              data: {
                ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
                ...(input.active !== undefined ? { active: input.active } : {}),
                ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
              },
            })
          : undefined;
        // #218: a password reset must cut off every session minted under the old credential, or
        // a stolen/lingering session survives the reset and the sliding expiry keeps it alive
        // indefinitely; deactivation gets the same sweep as hygiene (getSessionUser already
        // refuses inactive users). Same transaction as the update, so a failed save deletes
        // nothing. Session rows are ephemeral auth state, not an audited entity — the audit
        // trail is this user-update entry, matching logout's unaudited destroySession. Password
        // change is admin-route-only (no self-service route exists), and an admin resetting
        // their OWN password logs themselves out too — deliberate: simpler than threading the
        // acting token down here, and the safe direction.
        if (input && (input.password || input.active === false)) {
          await tx.session.deleteMany({ where: { userId: id } });
        }
        if (overrides) {
          await tx.userPermissionOverride.deleteMany({ where: { userId: id } });
          await tx.userPermissionOverride.createMany({
            data: overrides.map((o) => ({ userId: id, permission: o.permission, mode: o.mode })),
          });
        }
        return updated;
      }, { tx })));
}

// 2 MB — small enough that pulling it into a before/after audit snapshot would be real memory
// pressure for a value nothing there ever needs (SNAPSHOT_SELECT's `user` entry, audit.ts, is the
// other half of that guarantee); large enough for a real scanned or drawn signature.
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
// png/jpeg only (§9 amendment 2026-08-05, owner-ratified): Task 12 also allowed image/bmp, but
// pdfkit cannot embed BMP — a BMP signature rendered on screen while every cert silently printed
// the typed-name fallback. Existing BMP rows keep falling back safely (certs.ts's
// EMBEDDABLE_SIGNATURE_MIME null-out stays as defense in depth); new uploads must be embeddable.
export const SIGNATURE_MIME = ["image/png", "image/jpeg"] as const;

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
// Magic-byte sniff (#49): the declared MIME alone let renamed/corrupt bytes persist and poison
// that user's cert prints until an admin cleared the signature. The sniff itself moved to the
// shared image-sniff.ts leaf when Phase 7's template-logo upload became its second caller —
// same magic numbers, same prefix-check rationale (see that file's header).

export async function setSignature(userId: string, data: Buffer, mimeType: string): Promise<void> {
  if (!(SIGNATURE_MIME as readonly string[]).includes(mimeType)) {
    throw new HttpError(400, `Signature images must be one of: ${SIGNATURE_MIME.join(", ")}`);
  }
  if (data.byteLength > SIGNATURE_MAX_BYTES) {
    throw new HttpError(400, `Signature images cannot exceed ${SIGNATURE_MAX_BYTES / (1024 * 1024)} MB`);
  }
  if (!matchesDeclaredImage(mimeType, data)) {
    throw new HttpError(400, `The uploaded file is not a valid ${mimeType} image`);
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
          where: { id: userId },
          // `signatureUpdatedAt` moves with the bytes so listUsers can cache-bust the preview URL
          // on ANY change (#171). Set here AND in clearSignature — never inferred from `updatedAt`,
          // which also moves on a name/role/password edit.
          data: {
            signatureImage: new Uint8Array(data), signatureMimeType: mimeType,
            signatureUpdatedAt: new Date(),
          },
        }),
      { tx })));
}

export async function clearSignature(userId: string): Promise<void> {
  await withDbErrors({ entity: "User" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("user", userId, () =>
        // `signatureUpdatedAt` moves on the clear too (#171): a preview that failed before the clear
        // must not be suppressed by an identical URL after a later re-upload — the revision advances
        // here, so the URL does.
        tx.user.update({
          where: { id: userId },
          data: { signatureImage: null, signatureMimeType: null, signatureUpdatedAt: new Date() },
        }),
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

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { getSetting } from "./settings";

async function timeoutMinutes(): Promise<number> {
  return getSetting("session_timeout_minutes");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a session — but only after proving, under a row lock, that `verifiedPasswordHash` is
 * STILL the stored credential (#218 review P1, PR #242). Login verifies the password and then
 * inserts; unfenced, a login racing a password reset could insert AFTER the reset's session
 * sweep ran and commit a session minted under the old credential that the sweep never saw (an
 * FK insert takes only KEY SHARE, which the reset's row claim does not block — reproduced by
 * the held-lock test in sessions.test.ts). The fence: re-read the User row `FOR SHARE` in the
 * same transaction as the insert. FOR SHARE conflicts with the FOR NO KEY UPDATE claim every
 * auditedUpdate takes on its row before the before-snapshot, so login and reset serialize —
 * whichever commits first, either the sweep sees this session and deletes it, or this re-read
 * sees the new hash and refuses. Returns null on a stale hash (caller answers 401): the
 * credential the login checked has already been replaced.
 */
export async function createSession(userId: string, verifiedPasswordHash: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  const inserted = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ passwordHash: string }[]>`
      SELECT "passwordHash" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
    if (rows[0]?.passwordHash !== verifiedPasswordHash) return false;
    await tx.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
    return true;
  });
  return inserted ? { token, expiresAt } : null;
}

/**
 * Runs on every authenticated request (`handle`, http.ts, calls this for every request carrying
 * a session cookie) — the hottest path in the application for a User row read. Explicit `select`
 * on the nested `user`, not `include`: `include` pulls every scalar on User, including
 * `signatureImage` (up to SIGNATURE_MAX_BYTES, users.ts) now that it has a real writer, on every
 * single request. Lists exactly what a `SessionUser` is actually used for downstream:
 * id/username/displayName (http.ts's actor, /api/auth/me), active/deletedAt (the eligibility
 * check just below), and role.permissions/overrides (can()/canDo(), permissions.ts) — nothing
 * else reads a `SessionUser` field anywhere in the codebase (swept via grep before this change).
 */
export async function getSessionUser(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      user: {
        select: {
          id: true, username: true, displayName: true, active: true, deletedAt: true,
          role: { select: { permissions: { select: { permission: true } } } },
          overrides: { select: { permission: true, mode: true } },
        },
      },
    },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) return null;
  if (!session.user.active || session.user.deletedAt) return null;
  // Sliding expiry — updateMany, never update (#218 review P2, PR #242): this row can be deleted
  // between the lookup above and this write (the password-reset session sweep, a concurrent
  // logout), and `update` throws P2025 out of handle() as a 500 for what is simply a session
  // that no longer exists. Zero rows slid means logged out: answer null like every other
  // not-a-session path above.
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  const slid = await prisma.session.updateMany({ where: { id: session.id }, data: { expiresAt } });
  if (slid.count === 0) return null;
  return session.user;
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

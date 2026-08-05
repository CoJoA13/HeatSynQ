import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { getSetting } from "./settings";

async function timeoutMinutes(): Promise<number> {
  return getSetting("session_timeout_minutes");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  return { token, expiresAt };
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
  // Sliding expiry
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  await prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
  return session.user;
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

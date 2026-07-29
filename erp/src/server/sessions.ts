import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";

export const SESSION_TIMEOUT_FALLBACK_MINUTES = 480;
// NOTE (Task 10): once settings.ts exists, replace timeoutMinutes() body with
// getSetting("session_timeout_minutes") — Task 10 Step 5 does exactly that.
async function timeoutMinutes(): Promise<number> {
  return SESSION_TIMEOUT_FALLBACK_MINUTES;
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

export async function getSessionUser(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: { include: { role: { include: { permissions: true } }, overrides: true } },
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

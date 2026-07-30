import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createSession, getSessionUser, destroySession } from "@/server/sessions";

async function makeUser(username = "jane") {
  return prisma.user.create({
    data: { username, passwordHash: "x", displayName: username },
  });
}

describe("sessions", () => {
  beforeEach(async () => await truncateAll());

  it("round-trips a session token to its user", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const found = await getSessionUser(token);
    expect(found?.id).toBe(user.id);
  });

  it("stores only a hash of the token", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const rows = await prisma.session.findMany();
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it("rejects expired sessions", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("rejects disabled users", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("destroySession invalidates the token", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await destroySession(token);
    expect(await getSessionUser(token)).toBeNull();
  });

  it("slides the expiry forward on each successful lookup", async () => {
    const user = await makeUser();
    const { token, expiresAt: initialExpiresAt } = await createSession(user.id);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await getSessionUser(token);
    const row = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(initialExpiresAt.getTime());
  });

  it("rejects soft-deleted users", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    expect(await getSessionUser(token)).toBeNull();
  });
});

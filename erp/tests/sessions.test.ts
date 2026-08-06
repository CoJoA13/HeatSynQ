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

  // getSessionUser runs on every authenticated request (handle(), http.ts) — the hottest path
  // in the app for a User row read. Its `select` (sessions.ts) must never pull signatureImage:
  // unlike the audit snapshot's SNAPSHOT_SELECT (whose absence is provable straight from the
  // database), a session lookup has no equivalent redaction layer at all — an included bytes
  // column here would ride along on literally every route. Pins the property's absence on the
  // resolved user, not just the query shape, against a user that genuinely has a signature set.
  it("never pulls signatureImage into the resolved session user", async () => {
    const user = await makeUser("has-a-signature");
    await prisma.user.update({
      where: { id: user.id },
      data: { signatureImage: Buffer.from("fake-signature-bytes"), signatureMimeType: "image/png" },
    });
    const { token } = await createSession(user.id);
    const found = await getSessionUser(token);
    expect(found).not.toBeNull();
    expect(found).not.toHaveProperty("signatureImage");
    expect(JSON.stringify(found)).not.toContain("fake-signature-bytes");
  });
});

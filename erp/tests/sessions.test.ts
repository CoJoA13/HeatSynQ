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
    const { token } = (await createSession(user.id, "x"))!;
    const found = await getSessionUser(token);
    expect(found?.id).toBe(user.id);
  });

  it("stores only a hash of the token", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    const rows = await prisma.session.findMany();
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it("rejects expired sessions", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("rejects disabled users", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("destroySession invalidates the token", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await destroySession(token);
    expect(await getSessionUser(token)).toBeNull();
  });

  it("slides the expiry forward on each successful lookup", async () => {
    const user = await makeUser();
    const { token, expiresAt: initialExpiresAt } = (await createSession(user.id, "x"))!;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await getSessionUser(token);
    const row = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(initialExpiresAt.getTime());
  });

  it("rejects soft-deleted users", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    expect(await getSessionUser(token)).toBeNull();
  });

  // #218 review P1 (PR #242): a login verifies the password, THEN inserts its session — so a
  // login racing the password reset could mint a session under the old credential after the
  // reset's session sweep already ran, and the sweep would never see it. createSession therefore
  // takes the hash the caller verified and re-reads the User row FOR SHARE in the same
  // transaction as the insert: FOR SHARE conflicts with the FOR NO KEY UPDATE claim every
  // auditedUpdate takes on its row, so the two serialize — either the login commits first and
  // the sweep deletes its session, or the reset commits first and the re-read sees the new hash.
  it("refuses to mint a session when the verified hash is no longer the stored one", async () => {
    const user = await makeUser();
    expect(await createSession(user.id, "not-the-stored-hash")).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("a login racing a password reset can never keep a session minted under the old hash", async () => {
    const user = await makeUser(); // stored hash "x"
    // updateUser's exact shape at the worst interleaving: the row claimed FOR NO KEY UPDATE
    // (auditedUpdate's before-snapshot claim), the hash rewritten, the session sweep ALREADY
    // EXECUTED — and the transaction held open while a login that verified the OLD hash tries
    // to insert. An unfenced insert succeeds here (an FK insert takes only KEY SHARE, which
    // NO KEY UPDATE does not block) and the stale session survives the sweep.
    let release: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const reset = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR NO KEY UPDATE`;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: "new-hash" } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await held;
    });
    const attempt = createSession(user.id, "x");
    await new Promise((r) => setTimeout(r, 200));
    release!();
    await reset;
    expect(await attempt).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  // #218 review P2 (PR #242): the session row can vanish between getSessionUser's lookup and
  // its sliding-expiry write (the password-reset sweep, a concurrent logout). A `update` there
  // throws P2025 out of handle() as a 500 for what is simply a logged-out session; the slide
  // must be updateMany with a zero-count answer of null. The gone-between-statements state is
  // simulated deterministically by stubbing the lookup to answer with a row that no longer
  // exists — plain property save/restore, never vi.spyOn on a Prisma delegate (CLAUDE.md).
  it("returns null, never a thrown 500, when the session row vanishes before the expiry slide", async () => {
    const user = await makeUser();
    const delegate = prisma.session as { findUnique: typeof prisma.session.findUnique };
    const original = delegate.findUnique;
    delegate.findUnique = (async () => ({
      id: "ghost-row-deleted-mid-request",
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: user.id, username: user.username, displayName: user.displayName,
        active: true, deletedAt: null, role: null, overrides: [],
      },
    })) as unknown as typeof prisma.session.findUnique;
    try {
      await expect(getSessionUser("any-token")).resolves.toBeNull();
    } finally {
      delegate.findUnique = original;
    }
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
    const { token } = (await createSession(user.id, "x"))!;
    const found = await getSessionUser(token);
    expect(found).not.toBeNull();
    expect(found).not.toHaveProperty("signatureImage");
    expect(JSON.stringify(found)).not.toContain("fake-signature-bytes");
  });
});

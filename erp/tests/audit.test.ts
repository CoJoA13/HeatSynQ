import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedCreate, auditedUpdate, auditedSoftDelete, readAudit, searchAudit } from "@/server/audit";

describe("audit helpers", () => {
  beforeEach(async () => await truncateAll());

  it("logs create with actor and redacts passwordHash", async () => {
    const user = await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      prisma.$transaction((tx) =>
        auditedCreate("user", { username: "jane", passwordHash: "SECRET", displayName: "Jane" }, () =>
          tx.user.create({ data: { username: "jane", passwordHash: "SECRET", displayName: "Jane" } }), { tx }),
      ),
    );
    const log = await readAudit("user", user.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "create", actorName: "Admin", actorId: "u0" });
    expect(JSON.stringify(log[0].after)).not.toContain("SECRET");
  });

  it("logs update with before and after", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "Old" } });
    await prisma.$transaction((tx) =>
      auditedUpdate("user", u.id, () =>
        tx.user.update({ where: { id: u.id }, data: { displayName: "New" } }), { tx }),
    );
    const [entry] = await readAudit("user", u.id);
    expect((entry.before as { displayName: string }).displayName).toBe("Old");
    expect((entry.after as { displayName: string }).displayName).toBe("New");
  });

  it("soft delete sets deletedAt and logs with reason", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await prisma.$transaction((tx) => auditedSoftDelete("user", u.id, "left the company", tx));
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect((await readAudit("user", u.id))[0]).toMatchObject({ action: "delete", reason: "left the company" });
  });

  it("searchAudit filters by entity", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await prisma.$transaction((tx) =>
      auditedUpdate("user", u.id, () =>
        tx.user.update({ where: { id: u.id }, data: { displayName: "K" } }), { tx }),
    );
    expect(await searchAudit({ entity: "user" })).toHaveLength(1);
    expect(await searchAudit({ entity: "role" })).toHaveLength(0);
  });

  it("redacts nested password and token fields in create", async () => {
    const user = await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      prisma.$transaction((tx) =>
        auditedCreate(
          "user",
          {
            username: "nested",
            displayName: "Nested",
            profile: { password: "NestedPw1", email: "test@example.com" },
            apiToken: "tok_abc",
            secret: "sec123",
          },
          () => tx.user.create({ data: { username: "nested", passwordHash: "x", displayName: "Nested" } }),
          { tx },
        ),
      ),
    );
    const log = await readAudit("user", user.id);
    const afterStr = JSON.stringify(log[0].after);
    expect(afterStr).not.toContain("NestedPw1");
    expect(afterStr).not.toContain("tok_abc");
    expect(afterStr).not.toContain("sec123");
    expect(afterStr).toContain("[redacted]");
  });

  // Task 12 added a `SNAPSHOT_SELECT` entry for `user` (audit.ts), mirroring the
  // partAttachment/orderAttachment/storedDocument precedent: signatureImage now has a real
  // writer (setSignature, users.ts) and is excluded from the snapshot QUERY itself, the same way
  // those three tables' fileData is — so this no longer merely redacts the bytes, it never fetches
  // them at all. Updated from this test's original "asserts '[redacted]'" expectation to match;
  // see attachments.test.ts's identical before/after (its own comment: "the key itself is absent,
  // not merely redacted to a placeholder string").
  it("excludes signatureImage bytes from the snapshot query entirely, rather than merely redacting them", async () => {
    const u = await prisma.user.create({
      data: { username: "sig", passwordHash: "x", displayName: "Sig", signatureImage: Buffer.from("fakeimage") },
    });
    await prisma.$transaction((tx) =>
      auditedUpdate("user", u.id, () =>
        tx.user.update({ where: { id: u.id }, data: { displayName: "Updated" } }), { tx }),
    );
    const [entry] = await readAudit("user", u.id);
    const beforeSnapshot = entry.before as Record<string, unknown>;
    const afterSnapshot = entry.after as Record<string, unknown>;
    const beforeStr = JSON.stringify(entry.before);
    const afterStr = JSON.stringify(entry.after);

    // The key itself is absent — redact()'s "signatureimage" pattern stays defense-in-depth, not
    // the mechanism relied on to keep the bytes out (CLAUDE.md).
    expect(beforeSnapshot).not.toHaveProperty("signatureImage");
    expect(afterSnapshot).not.toHaveProperty("signatureImage");

    // Belt: no raw Buffer serialization survives either.
    expect(beforeStr).not.toContain('"type":"Buffer"');
    expect(afterStr).not.toContain('"type":"Buffer"');
    expect(beforeStr).not.toContain("fakeimage");
    expect(afterStr).not.toContain("fakeimage");
  });
});

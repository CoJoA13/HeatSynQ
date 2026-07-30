import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedCreate, auditedUpdate, auditedSoftDelete, readAudit, searchAudit } from "@/server/audit";

describe("audit helpers", () => {
  beforeEach(async () => await truncateAll());

  it("logs create with actor and redacts passwordHash", async () => {
    const user = await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      auditedCreate("user", { username: "jane", passwordHash: "SECRET", displayName: "Jane" }, () =>
        prisma.user.create({ data: { username: "jane", passwordHash: "SECRET", displayName: "Jane" } }),
      ),
    );
    const log = await readAudit("user", user.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "create", actorName: "Admin", actorId: "u0" });
    expect(JSON.stringify(log[0].after)).not.toContain("SECRET");
  });

  it("logs update with before and after", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "Old" } });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "New" } }),
    );
    const [entry] = await readAudit("user", u.id);
    expect((entry.before as { displayName: string }).displayName).toBe("Old");
    expect((entry.after as { displayName: string }).displayName).toBe("New");
  });

  it("soft delete sets deletedAt and logs with reason", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await auditedSoftDelete("user", u.id, "left the company");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect((await readAudit("user", u.id))[0]).toMatchObject({ action: "delete", reason: "left the company" });
  });

  it("searchAudit filters by entity", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "K" } }),
    );
    expect(await searchAudit({ entity: "user" })).toHaveLength(1);
    expect(await searchAudit({ entity: "role" })).toHaveLength(0);
  });

  it("redacts nested password and token fields in create", async () => {
    const user = await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      auditedCreate(
        "user",
        {
          username: "nested",
          displayName: "Nested",
          profile: { password: "NestedPw1", email: "test@example.com" },
          apiToken: "tok_abc",
          secret: "sec123",
        },
        () => prisma.user.create({ data: { username: "nested", passwordHash: "x", displayName: "Nested" } }),
      ),
    );
    const log = await readAudit("user", user.id);
    const afterStr = JSON.stringify(log[0].after);
    expect(afterStr).not.toContain("NestedPw1");
    expect(afterStr).not.toContain("tok_abc");
    expect(afterStr).not.toContain("sec123");
    expect(afterStr).toContain("[redacted]");
  });

  it("redacts signatureImage in update", async () => {
    const u = await prisma.user.create({
      data: { username: "sig", passwordHash: "x", displayName: "Sig", signatureImage: Buffer.from("fakeimage") },
    });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "Updated" } }),
    );
    const [entry] = await readAudit("user", u.id);
    const beforeSnapshot = entry.before as Record<string, unknown>;
    const afterSnapshot = entry.after as Record<string, unknown>;
    const beforeStr = JSON.stringify(entry.before);
    const afterStr = JSON.stringify(entry.after);

    // Structurally assert redaction of signatureImage in both snapshots
    expect(beforeSnapshot.signatureImage).toBe("[redacted]");
    expect(afterSnapshot.signatureImage).toBe("[redacted]");

    // Prove no raw Buffer serialization survives
    expect(beforeStr).not.toContain('"type":"Buffer"');
    expect(afterStr).not.toContain('"type":"Buffer"');
  });
});

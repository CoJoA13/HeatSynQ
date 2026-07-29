import { describe, it, expect, beforeAll } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("schema", () => {
  beforeAll(async () => await truncateAll());

  it("creates a user with role and override", async () => {
    const role = await prisma.role.create({ data: { name: "Office" } });
    const user = await prisma.user.create({
      data: {
        username: "jane",
        passwordHash: "x",
        displayName: "Jane",
        roleId: role.id,
        overrides: { create: { permission: "orders.view", mode: "GRANT" } },
      },
      include: { overrides: true },
    });
    expect(user.overrides).toHaveLength(1);
    expect(user.active).toBe(true);
  });

  it("writes an audit row", async () => {
    const row = await prisma.auditLog.create({
      data: { actorName: "system", entity: "User", entityId: "u1", action: "create", after: { a: 1 } },
    });
    expect(row.at).toBeInstanceOf(Date);
  });
});

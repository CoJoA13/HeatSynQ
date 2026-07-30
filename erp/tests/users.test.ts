import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { createUser, listUsers, updateUser, setUserOverrides } from "@/server/users";
import { createRole } from "@/server/roles";
import { verifyPassword } from "@/server/password";
import { HttpError } from "@/server/http";
import { readAudit } from "@/server/audit";

describe("users service", () => {
  beforeEach(async () => await truncateAll());

  it("creates a user with a hashed password and lists it", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.passwordHash).not.toBe("pw12345");
    expect(await verifyPassword(row.passwordHash, "pw12345")).toBe(true);
    expect((await listUsers())[0]).toMatchObject({ username: "jane", roleName: null, active: true });
  });

  it("rejects duplicate usernames", async () => {
    await createUser({ username: "jane", displayName: "J", password: "x1234567" });
    await expect(createUser({ username: "jane", displayName: "K", password: "y1234567" }))
      .rejects.toThrow(HttpError);
  });

  it("assigns roles, deactivates, resets password", async () => {
    const role = await createRole("Office");
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    await updateUser(id, { roleId: role.id, active: false, password: "newpw999" });
    const listed = (await listUsers())[0];
    expect(listed.roleName).toBe("Office");
    expect(listed.active).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await verifyPassword(row.passwordHash, "newpw999")).toBe(true);
  });

  it("replaces overrides and validates keys", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    await setUserOverrides(id, [{ permission: "orders.view", mode: "GRANT" }]);
    await setUserOverrides(id, [{ permission: "orders.view", mode: "DENY" }]);
    expect((await listUsers())[0].overrides).toEqual([{ permission: "orders.view", mode: "DENY" }]);
    await expect(setUserOverrides(id, [{ permission: "bogus.key", mode: "GRANT" }])).rejects.toThrow(HttpError);
  });

  it("user mutations write audit entries", async () => {
    const { id } = await createUser({ username: "audited", displayName: "A", password: "pw123456" });
    await updateUser(id, { displayName: "B" });
    const log = await readAudit("user", id);
    expect(log.map((l) => l.action)).toEqual(["update", "create"]);
  });

  it("createUser audit entry never contains the plaintext password", async () => {
    const { id } = await createUser({ username: "leakcheck", displayName: "L", password: "S3cretUnique!" });
    const log = await readAudit("user", id);
    expect(JSON.stringify(log)).not.toContain("S3cretUnique!");
  });
});

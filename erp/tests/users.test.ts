import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { createUser, listUsers, updateUser, setUserOverrides } from "@/server/users";
import { createRole, setRolePermissions } from "@/server/roles";
import { verifyPassword } from "@/server/password";
import { HttpError } from "@/server/http";
import { readAudit } from "@/server/audit";
import { runWithActor } from "@/server/context";

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

  it("setUserOverrides produces an audit entry whose before/after overrides differ", async () => {
    const { id } = await createUser({ username: "overrideaudit", displayName: "O", password: "pw123456" });
    await setUserOverrides(id, [{ permission: "orders.view", mode: "GRANT" }]);
    const [entry] = await readAudit("user", id);
    const before = (entry.before as { overrides: { permission: string; mode: string }[] }).overrides;
    const after = (entry.after as { overrides: { permission: string; mode: string }[] }).overrides;
    expect(before).toEqual([]);
    expect(after.map((o) => ({ permission: o.permission, mode: o.mode }))).toEqual([
      { permission: "orders.view", mode: "GRANT" },
    ]);
    expect(before).not.toEqual(after);
  });

  describe("self-lockout guards", () => {
    it("rejects a user deactivating their own account", async () => {
      const { id } = await createUser({ username: "self", displayName: "Self", password: "pw123456" });
      await expect(
        runWithActor({ id, name: "Self" }, () => updateUser(id, { active: false })),
      ).rejects.toThrow("You cannot deactivate your own account");
      expect((await listUsers()).find((u) => u.id === id)?.active).toBe(true);
    });

    it("rejects deactivating the last active user manager", async () => {
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const { id } = await createUser({
        username: "mgr", displayName: "Manager", password: "pw123456", roleId: role.id,
      });
      await expect(updateUser(id, { active: false })).rejects.toThrow("Cannot remove the last user manager");
      expect((await listUsers()).find((u) => u.id === id)?.active).toBe(true);
    });

    it("rejects removing the role of the last active user manager", async () => {
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const { id } = await createUser({
        username: "mgr3", displayName: "Manager3", password: "pw123456", roleId: role.id,
      });
      await expect(updateUser(id, { roleId: null })).rejects.toThrow("Cannot remove the last user manager");
    });

    it("allows deactivating a manager when another active manager remains", async () => {
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const mgr1 = await createUser({
        username: "mgr1", displayName: "Manager1", password: "pw123456", roleId: role.id,
      });
      await createUser({ username: "mgr2", displayName: "Manager2", password: "pw123456", roleId: role.id });
      await updateUser(mgr1.id, { active: false });
      expect((await listUsers()).find((u) => u.id === mgr1.id)?.active).toBe(false);
    });
  });
});

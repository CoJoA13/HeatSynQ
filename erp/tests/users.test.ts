import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import {
  createUser, listUsers, updateUser, setUserOverrides, updateUserWithOverrides,
} from "@/server/users";
import { createRole, setRolePermissions } from "@/server/roles";
import { verifyPassword } from "@/server/password";
import { HttpError } from "@/server/http";
import { readAudit } from "@/server/audit";
import { runWithContext } from "@/server/context";

describe("users service", () => {
  beforeEach(async () => await truncateAll());

  // #218: a password reset exists to cut off whoever holds the old credential — so it must also
  // cut off whoever holds a SESSION minted under it, or a stolen/lingering session survives the
  // reset and the sliding expiry keeps it alive indefinitely. Deactivation gets the same sweep
  // (getSessionUser already refuses inactive users, so that half is hygiene, not the hole).
  async function seedSession(userId: string, tokenHash: string) {
    await prisma.session.create({
      data: { tokenHash, userId, expiresAt: new Date(Date.now() + 60 * 60_000) },
    });
  }

  it("password change deletes the target's sessions and only theirs (#218)", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    const other = await createUser({ username: "bob", displayName: "Bob", password: "pw12345" });
    await seedSession(id, "jane-1");
    await seedSession(id, "jane-2");
    await seedSession(other.id, "bob-1");

    await updateUser(id, { password: "newpw999" });

    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: other.id } })).toBe(1);
  });

  it("a non-password update leaves sessions alone (#218)", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    await seedSession(id, "jane-1");
    await updateUser(id, { displayName: "Jane R." });
    expect(await prisma.session.count({ where: { userId: id } })).toBe(1);
  });

  it("deactivation deletes the target's sessions too (#218)", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    await seedSession(id, "jane-1");
    await updateUser(id, { active: false });
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
  });

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

  it("updates the signature title, lists it, and the audit diff shows the change (Phase 6 ruling 14)", async () => {
    const { id } = await createUser({ username: "titled", displayName: "T", password: "pw123456" });
    expect((await listUsers())[0].title).toBe("");             // schema default — blank prints nothing
    await updateUser(id, { title: "V.P. Sales" });
    expect((await listUsers())[0].title).toBe("V.P. Sales");
    const [entry] = await readAudit("user", id);
    expect(entry.action).toBe("update");
    expect((entry.before as { title?: string }).title).toBe("");
    expect((entry.after as { title?: string }).title).toBe("V.P. Sales");
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
        runWithContext({ actor: { id, name: "Self" }, user: null }, () => updateUser(id, { active: false })),
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

    it("rejects DENYing action.manage_users on the last manager, via the overrides path (#250)", async () => {
      // The guard's blind spot for four phases: it ran only when `active` or `roleId` was in the
      // input, and read the target's overrides as they stood BEFORE the write. So a request that
      // only replaces overrides never reached it at all, and a DENY committed — locking everyone
      // out of user management, the exact outcome the guard exists to prevent, one write path over.
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const { id } = await createUser({
        username: "mgr4", displayName: "Manager4", password: "pw123456", roleId: role.id,
      });
      await expect(setUserOverrides(id, [{ permission: "action.manage_users", mode: "DENY" }]))
        .rejects.toThrow("Cannot remove the last user manager");
      // And nothing was written: the refusal is pre-transaction, so the override set is untouched.
      expect((await listUsers()).find((u) => u.id === id)?.overrides).toEqual([]);
    });

    it("rejects a DENY arriving in the SAME request as the field update (#250)", async () => {
      // The second half. Here the guard DID run — `active` is present — but it evaluated the
      // target's pre-write overrides, so a DENY riding in the same body was invisible to it and
      // the combined write committed. Post-write state is what has to be judged.
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const { id } = await createUser({
        username: "mgr5", displayName: "Manager5", password: "pw123456", roleId: role.id,
      });
      await expect(updateUserWithOverrides(
        id, { displayName: "Still Manager" }, [{ permission: "action.manage_users", mode: "DENY" }],
      )).rejects.toThrow("Cannot remove the last user manager");
      const after = (await listUsers()).find((u) => u.id === id);
      expect(after?.overrides, "the overrides never landed").toEqual([]);
      expect(after?.displayName, "and neither did the field beside them").toBe("Manager5");
    });

    it("lets an override GRANT keep the last manager, when the role alone would not (#250)", async () => {
      // The guard must judge the POST-WRITE set, not merely refuse anything touching overrides.
      // Here the role is being removed AND a GRANT override arrives in the same request: the user
      // still manages users afterwards, so this must be ALLOWED. Without this case the fix could
      // be "refuse every override write on the last manager", which passes the two tests above
      // while making the sole manager's overrides permanently uneditable.
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const { id } = await createUser({
        username: "mgr6", displayName: "Manager6", password: "pw123456", roleId: role.id,
      });
      await updateUserWithOverrides(
        id, { roleId: null }, [{ permission: "action.manage_users", mode: "GRANT" }],
      );
      const after = (await listUsers()).find((u) => u.id === id);
      expect(after?.roleId).toBeNull();
      expect(after?.overrides).toEqual([{ permission: "action.manage_users", mode: "GRANT" }]);
    });

    it("still allows an unrelated override write on the last manager (#250)", async () => {
      // The guard must not become "the sole manager's overrides are frozen": an override set that
      // leaves manage_users intact is an ordinary admin action.
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users"]);
      const { id } = await createUser({
        username: "mgr7", displayName: "Manager7", password: "pw123456", roleId: role.id,
      });
      await setUserOverrides(id, [{ permission: "orders.view", mode: "DENY" }]);
      expect((await listUsers()).find((u) => u.id === id)?.overrides)
        .toEqual([{ permission: "orders.view", mode: "DENY" }]);
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

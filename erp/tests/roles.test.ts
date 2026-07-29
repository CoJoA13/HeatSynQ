import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createRole, listRoles, setRolePermissions, deleteRole, renameRole } from "@/server/roles";
import { HttpError } from "@/server/http";

describe("roles service", () => {
  beforeEach(async () => await truncateAll());

  it("creates, lists, and renames roles", async () => {
    const { id } = await createRole("Office");
    await renameRole(id, "Front Office");
    const roles = await listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ name: "Front Office", permissions: [], userCount: 0 });
  });

  it("rejects duplicate names", async () => {
    await createRole("Office");
    await expect(createRole("Office")).rejects.toThrow(HttpError);
  });

  it("replaces the permission set and rejects unknown keys", async () => {
    const { id } = await createRole("Billing");
    await setRolePermissions(id, ["invoicing.view", "invoicing.edit"]);
    await setRolePermissions(id, ["invoicing.view"]);
    expect((await listRoles())[0].permissions).toEqual(["invoicing.view"]);
    await expect(setRolePermissions(id, ["nope.bogus"])).rejects.toThrow(HttpError);
  });

  it("refuses to delete a role users still hold, allows otherwise", async () => {
    const { id } = await createRole("Office");
    await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J", roleId: id } });
    await expect(deleteRole(id)).rejects.toThrow("Role is assigned to users");
    await prisma.user.updateMany({ data: { roleId: null } });
    await deleteRole(id);
    expect(await listRoles()).toHaveLength(0);
  });
});

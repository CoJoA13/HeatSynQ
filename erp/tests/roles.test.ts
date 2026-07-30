import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createRole, listRoles, setRolePermissions, deleteRole, renameRole } from "@/server/roles";
import { HttpError } from "@/server/http";
import { readAudit } from "@/server/audit";

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

  it("renameRole rejects a name already used by another non-deleted role", async () => {
    await createRole("Office");
    const { id: warehouseId } = await createRole("Warehouse");
    await expect(renameRole(warehouseId, "Office")).rejects.toThrow(HttpError);
    await expect(renameRole(warehouseId, "Office")).rejects.toThrow("A role with that name already exists");
    // renaming to its own current name is not a conflict
    await renameRole(warehouseId, "Warehouse");
    expect((await listRoles()).find((r) => r.id === warehouseId)?.name).toBe("Warehouse");
  });

  it("setRolePermissions produces an audit entry whose before/after permissions differ", async () => {
    const { id } = await createRole("Billing");
    await setRolePermissions(id, ["invoicing.view"]);
    const [entry] = await readAudit("role", id);
    const before = (entry.before as { permissions: { permission: string }[] }).permissions.map((p) => p.permission);
    const after = (entry.after as { permissions: { permission: string }[] }).permissions.map((p) => p.permission);
    expect(before).toEqual([]);
    expect(after).toEqual(["invoicing.view"]);
    expect(before).not.toEqual(after);
  });

  it("createRole resurrection clears stale permissions from the deleted role", async () => {
    const { id } = await createRole("Office");
    await setRolePermissions(id, ["orders.view", "orders.edit"]);
    await deleteRole(id);
    const revived = await createRole("Office");
    expect(revived.id).toBe(id);
    const roles = await listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].permissions).toEqual([]);
  });
});

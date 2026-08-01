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
    await expect(deleteRole(id, "cleaning up unused roles")).rejects.toThrow("Role is assigned to users");
    await prisma.user.updateMany({ data: { roleId: null } });
    await deleteRole(id, "cleaning up unused roles");
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

  it("renameRole onto a soft-deleted role's name is allowed, not a 500", async () => {
    const { id: deadId } = await createRole("Old");
    await deleteRole(deadId, "merged into Live");
    const { id: liveId } = await createRole("Live");
    await expect(renameRole(liveId, "Old")).resolves.not.toThrow();
    expect((await listRoles()).find((r) => r.id === liveId)?.name).toBe("Old");
  });

  it("re-creating a deleted role name makes a NEW role with no inherited grants", async () => {
    const first = await createRole("Shipping");
    await setRolePermissions(first.id, ["customers.view"]);
    await deleteRole(first.id, "consolidating into Warehouse");

    const second = await createRole("Shipping");
    expect(second.id).not.toBe(first.id);

    const roles = await listRoles();
    const fresh = roles.find((r) => r.id === second.id);
    expect(fresh?.permissions).toEqual([]);

    expect((await readAudit("role", second.id)).map((e) => e.action)).toEqual(["create"]);
  });

  it("requires a reason to delete a role", async () => {
    const { id } = await createRole("Shipping");
    await expect(deleteRole(id, "")).rejects.toThrow(/reason is required/i);
    await expect(deleteRole(id, "   ")).rejects.toThrow(/reason is required/i);
  });

  it("stores the trimmed reason on the audit entry", async () => {
    const { id } = await createRole("Shipping");
    await deleteRole(id, "  duplicate of Office  ");
    const [entry] = await readAudit("role", id);
    expect(entry.action).toBe("delete");
    expect(entry.reason).toBe("duplicate of Office");
  });
});

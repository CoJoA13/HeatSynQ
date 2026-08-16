import { describe, it, expect } from "vitest";
import { can, canDo, ALL_PERMISSIONS, AREAS, SPECIAL_ACTIONS, type PermUser } from "@/server/permissions";

function user(rolePerms: string[], overrides: { permission: string; mode: "GRANT" | "DENY" }[] = []): PermUser {
  return { role: { permissions: rolePerms.map((permission) => ({ permission })) }, overrides };
}

describe("permission resolution", () => {
  it("denies by default", () => {
    expect(can(user([]), "orders", "view")).toBe(false);
    expect(canDo(user([]), "void_shipper")).toBe(false);
  });

  it("role grants work", () => {
    expect(can(user(["orders.view"]), "orders", "view")).toBe(true);
    expect(canDo(user(["action.void_shipper"]), "void_shipper")).toBe(true);
  });

  it("GRANT override adds to a role", () => {
    expect(can(user([], [{ permission: "invoicing.edit", mode: "GRANT" }]), "invoicing", "edit")).toBe(true);
  });

  it("DENY override beats a role grant", () => {
    expect(can(user(["orders.delete"], [{ permission: "orders.delete", mode: "DENY" }]), "orders", "delete")).toBe(false);
  });

  it("DENY beats GRANT when both exist", () => {
    const u = user([], [
      { permission: "ar.view", mode: "GRANT" },
      { permission: "ar.view", mode: "DENY" },
    ]);
    expect(can(u, "ar", "view")).toBe(false);
  });

  it("no role means only overrides apply", () => {
    const u: PermUser = { role: null, overrides: [{ permission: "reports.view", mode: "GRANT" }] };
    expect(can(u, "reports", "view")).toBe(true);
    expect(can(u, "orders", "view")).toBe(false);
  });

  it("ALL_PERMISSIONS covers areas × actions plus specials", () => {
    expect(ALL_PERMISSIONS).toContain("orders.view");
    expect(ALL_PERMISSIONS).toContain("action.close_ar_period");
    // 13 areas (Phase 5B adds "receivables") × 4 CRUD actions + 13 specials (Phase 8C adds
    // "manage_backups" on top of Phase 5B's "write_off").
    expect(ALL_PERMISSIONS.length).toBe(13 * 4 + 13);
  });

  it("has a receivables area and a write_off special action", () => {
    expect(AREAS).toContain("receivables");
    expect(SPECIAL_ACTIONS).toContain("write_off");
  });

  it("manage_backups is denied by default and granted by an explicit action grant", () => {
    expect(canDo(user([]), "manage_backups")).toBe(false);
    expect(canDo(user(["action.manage_backups"]), "manage_backups")).toBe(true);
    // A DENY override must beat the grant, like every other dangerous action.
    expect(canDo(
      user(["action.manage_backups"], [{ permission: "action.manage_backups", mode: "DENY" }]),
      "manage_backups",
    )).toBe(false);
  });
});

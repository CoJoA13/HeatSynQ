import { describe, it, expect } from "vitest";
import { can, canDo, ALL_PERMISSIONS, type PermUser } from "@/server/permissions";

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
    expect(ALL_PERMISSIONS.length).toBe(12 * 4 + 10);
  });
});

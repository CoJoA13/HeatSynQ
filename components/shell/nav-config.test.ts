import { describe, it, expect } from "vitest";
import { isItemActive, NAV_GROUPS } from "./nav-config";

describe("nav", () => {
  it("keeps the parent active on detail routes", () => {
    expect(isItemActive("/orders", "/orders")).toBe(true);
    expect(isItemActive("/orders", "/orders/wo-48211")).toBe(true);
    expect(isItemActive("/orders", "/quotes")).toBe(false);
  });
  it("does not match the today root against everything", () => {
    expect(isItemActive("/today", "/orders")).toBe(false);
  });
  it("exposes the documented groups", () => {
    const labels = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label));
    ["Quotes","Customers","Part Maintenance","Orders","Invoicing","A/R","Patterns","Setup"].forEach((l) =>
      expect(labels).toContain(l));
  });
});

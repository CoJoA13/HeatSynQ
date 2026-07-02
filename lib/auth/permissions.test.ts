import { describe, it, expect } from "vitest";
import { can, PERMISSIONS, MATRIX, permissionMeta } from "@/lib/auth/permissions";
import { ROLE_KEYS } from "@/lib/domain/enums";

describe("permissions", () => {
  it("only managers approve over limit + close periods", () => {
    expect(can("manager","approve_over_limit")).toBe(true);
    expect(can("sales","approve_over_limit")).toBe(false);
    expect(can("manager","close_period")).toBe(true);
    expect(can("office","close_period")).toBe(true);
  });
  it("sales + managers apply discounts", () => {
    expect(can("sales","apply_discount")).toBe(true);
    expect(can("office","apply_discount")).toBe(false);
  });
});

describe("maintain_equipment", () => {
  it("grants manager and office, denies sales", () => {
    expect(can("manager", "maintain_equipment")).toBe(true);
    expect(can("office", "maintain_equipment")).toBe(true);
    expect(can("sales", "maintain_equipment")).toBe(false);
  });
});

describe("permission matrix exports (Setup)", () => {
  it("PERMISSIONS lists all 7 keys in display order", () => {
    expect(PERMISSIONS).toEqual([
      "approve_over_limit", "apply_discount", "release_cert", "close_period",
      "edit_setup", "schedule_loads", "maintain_equipment",
    ]);
  });
  it("MATRIX agrees with can() for every permission × role", () => {
    for (const p of PERMISSIONS) for (const r of ROLE_KEYS) {
      expect(MATRIX[p].includes(r)).toBe(can(r, p));
    }
  });
  it("every permission has a label", () => {
    for (const p of PERMISSIONS) expect(permissionMeta[p].label.length).toBeGreaterThan(0);
  });
});

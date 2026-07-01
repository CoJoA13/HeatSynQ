import { describe, it, expect } from "vitest";
import { can } from "@/lib/auth/permissions";

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

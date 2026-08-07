import { describe, it, expect } from "vitest";
import { buildCustomerSurchargeBody, type CustomerSurchargeOptionRow } from "@/lib/customer-surcharge-body";

// The surcharge-body.test.ts precedent, applied to the customer-side override: an omitted field
// on `setCustomerSurcharge`'s update branch clears that column (task-8 brief's opening
// blockquote, carried in from Task 6's review), so `buildCustomerSurchargeBody` must always
// return the whole row, opposite-field nulling included.

const percentRow: CustomerSurchargeOptionRow = {
  surchargeId: "s1", surchargeName: "Energy", kind: "PERCENT",
  optOut: false, rate: 0.04, amount: null, hasOverride: true,
};
const flatRow: CustomerSurchargeOptionRow = {
  surchargeId: "s2", surchargeName: "Fuel", kind: "FLAT",
  optOut: false, rate: null, amount: 5, hasOverride: true,
};

describe("buildCustomerSurchargeBody", () => {
  it("returns every key on every payload, whichever single field the patch touches", () => {
    const body = buildCustomerSurchargeBody(percentRow, { optOut: true });
    expect(Object.keys(body).sort()).toEqual(["amount", "optOut", "rate"].sort());
    expect(body).toEqual({ optOut: true, rate: 0.04, amount: null });
  });

  it("an empty patch reproduces the row exactly, opposite-field nulling included", () => {
    expect(buildCustomerSurchargeBody(percentRow, {})).toEqual({ optOut: false, rate: 0.04, amount: null });
    expect(buildCustomerSurchargeBody(flatRow, {})).toEqual({ optOut: false, rate: null, amount: 5 });
  });

  it("a deliberate null in the patch overrides the row's stored value, not falls back to it", () => {
    const body = buildCustomerSurchargeBody(percentRow, { rate: null });
    expect(body.rate).toBeNull();
  });

  it("nulls amount for a PERCENT surcharge even if a stale non-null amount is sitting on the row", () => {
    const row: CustomerSurchargeOptionRow = { ...percentRow, amount: 9 };
    const body = buildCustomerSurchargeBody(row, {});
    expect(body.rate).toBe(0.04);
    expect(body.amount).toBeNull();
  });

  it("nulls rate for a FLAT surcharge even if a stale non-null rate is sitting on the row", () => {
    const row: CustomerSurchargeOptionRow = { ...flatRow, rate: 0.09 };
    const body = buildCustomerSurchargeBody(row, {});
    expect(body.amount).toBe(5);
    expect(body.rate).toBeNull();
  });

  it("accepts a raw decimal string for rate/amount without touching it", () => {
    expect(buildCustomerSurchargeBody(percentRow, { rate: "0.070000" }).rate).toBe("0.070000");
    expect(buildCustomerSurchargeBody(flatRow, { amount: "12.34" }).amount).toBe("12.34");
  });

  it("clearing optOut back to false while touching nothing else leaves rate/amount untouched", () => {
    const optedOut: CustomerSurchargeOptionRow = { ...percentRow, optOut: true };
    const body = buildCustomerSurchargeBody(optedOut, { optOut: false });
    expect(body).toEqual({ optOut: false, rate: 0.04, amount: null });
  });
});

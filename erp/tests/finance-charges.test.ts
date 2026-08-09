import { describe, expect, it } from "vitest";
import { financeCharge, financeChargeRateFor } from "@/server/finance-charges";

// Pure module, no DB (spec §7): finance charges are informational-only — computed at statement
// time, never posted, never aged. `financeCharge` sums the non-exempt past-due open balances the
// caller hands it and applies the monthly rate; `financeChargeRateFor` resolves the customer
// override vs. the plant default.

describe("financeCharge", () => {
  it("charges only the non-exempt balances at the monthly rate", () => {
    expect(financeCharge({
      pastDueBalances: [{ open: 1000, exempt: false }, { open: 500, exempt: true }],
      rate: 1.5,
    })).toBe(15.00);
  });

  it("is zero when the rate is null", () => {
    expect(financeCharge({
      pastDueBalances: [{ open: 1000, exempt: false }],
      rate: null as unknown as number,
    })).toBe(0);
  });

  it("is zero when the rate is 0", () => {
    expect(financeCharge({ pastDueBalances: [{ open: 1000, exempt: false }], rate: 0 })).toBe(0);
  });

  it("is zero when nothing is past due", () => {
    expect(financeCharge({ pastDueBalances: [], rate: 1.5 })).toBe(0);
  });

  it("is zero when every balance is exempt", () => {
    expect(financeCharge({
      pastDueBalances: [{ open: 1000, exempt: true }, { open: 500, exempt: true }],
      rate: 1.5,
    })).toBe(0);
  });
});

describe("financeChargeRateFor", () => {
  it("prefers the customer override when set", () => {
    expect(financeChargeRateFor(2, 1.5)).toBe(2);
  });

  it("falls back to the plant rate when there's no override", () => {
    expect(financeChargeRateFor(null, 1.5)).toBe(1.5);
  });

  it("is null when neither is set", () => {
    expect(financeChargeRateFor(null, null)).toBe(null);
  });
});

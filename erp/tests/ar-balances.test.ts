import { describe, expect, it } from "vitest";
import { invoiceOpenBalance, paymentOnAccount, creditRemaining, type ApplicationLite } from "@/server/ar-balances";
import type { ApplicationTypeValue } from "@/lib/ar-constants";

// Pure module, no DB: every A/R balance (invoice open balance, payment on-account, credit
// remaining) derives from live Application rows here, never from a cached column (spec §4.2).

const live = (amount: number, type: ApplicationTypeValue): ApplicationLite =>
  ({ amount, type, deletedAt: null });

describe("invoiceOpenBalance", () => {
  it("subtracts every live application type", () => {
    expect(invoiceOpenBalance(1000, [
      live(300, "PAYMENT"), live(50, "DISCOUNT"), live(20, "WRITE_OFF"), live(100, "CREDIT"),
    ])).toBe(530);
  });

  it("ignores voided applications", () => {
    expect(invoiceOpenBalance(1000, [{ amount: 400, type: "PAYMENT", deletedAt: new Date() }])).toBe(1000);
  });

  it("rounds in cents — no float drift", () => {
    expect(invoiceOpenBalance(0.3, [live(0.1, "PAYMENT")])).toBe(0.2);
  });
});

describe("paymentOnAccount", () => {
  it("counts only live PAYMENT applications", () => {
    expect(paymentOnAccount(500, [live(300, "PAYMENT"), live(50, "DISCOUNT")])).toBe(200);
  });
});

describe("creditRemaining", () => {
  it("uses the credit's absolute total", () => {
    expect(creditRemaining(-937.44, [live(100, "CREDIT")])).toBe(837.44);
  });
});

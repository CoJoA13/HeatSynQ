import { expect, it } from "vitest";
import { cashJournal, salesJournal, reverseLines, readinessGaps, type SalesEvent, type CashEvent } from "@/server/gl-mapping";

function sum(lines: { debit: number; credit: number }[]) {
  const d = lines.reduce((a, l) => a + l.debit, 0);
  const c = lines.reduce((a, l) => a + l.credit, 0);
  return { d: Math.round(d * 100), c: Math.round(c * 100) };
}

it("an invoice posts DR A/R = CR revenue + tax and balances", () => {
  const ev: SalesEvent = {
    kind: "INVOICE", invoiceId: "i1", total: 108,
    arGlAccountId: "ar", arGlAccountName: "1200",
    taxTotal: 8, taxGlAccountId: "tax", taxGlAccountName: "2200",
    revenue: [{ glAccountId: "rev", glAccountName: "4010", amount: 100 }],
  };
  const lines = salesJournal(ev);
  const ar = lines.find((l) => l.glAccountId === "ar")!;
  expect(ar.debit).toBe(108);
  const { d, c } = sum(lines);
  expect(d).toBe(c); // balances
});

it("a credit reverses the sales entry (DR revenue/tax, CR A/R)", () => {
  const ev: SalesEvent = {
    kind: "CREDIT", invoiceId: "c1", total: 50, arGlAccountId: "ar", arGlAccountName: "1200",
    taxTotal: 0, taxGlAccountId: null, taxGlAccountName: "",
    revenue: [{ glAccountId: "rev", glAccountName: "4010", amount: 50 }],
  };
  const lines = salesJournal(ev);
  expect(lines.find((l) => l.glAccountId === "ar")!.credit).toBe(50);
  const { d, c } = sum(lines);
  expect(d).toBe(c);
});

it("a payment posts DR cash = CR A/R, balanced and keyed on the payment id", () => {
  const lines = cashJournal({
    kind: "PAYMENT", sourceId: "pay1", amount: 90,
    debitGlAccountId: "bank", debitGlAccountName: "1000", arGlAccountId: "ar", arGlAccountName: "1200",
  });
  expect(lines).toHaveLength(2);
  expect(lines.every((l) => l.sourceId === "pay1")).toBe(true);
  expect(lines.find((l) => l.glAccountId === "ar")!.credit).toBe(90);
  const { d, c } = sum(lines);
  expect(d).toBe(c);
});

it("reverseLines swaps debit/credit and flags isReversal", () => {
  const [orig] = cashJournal({ kind: "DISCOUNT", sourceId: "app1", amount: 5,
    debitGlAccountId: "disc", debitGlAccountName: "4900", arGlAccountId: "ar", arGlAccountName: "1200" });
  const [rev] = reverseLines([orig]);
  expect(rev.credit).toBe(orig.debit);
  expect(rev.debit).toBe(orig.credit);
  expect(rev.isReversal).toBe(true);
});

it("readinessGaps lists a step code, surcharge, payment type, and missing A/R default", () => {
  const gaps = readinessGaps({
    arGlAccountId: null, discountGlAccountId: "d", writeOffGlAccountId: "w",
    hasDiscount: false, hasWriteOff: false,
    stepCodesMissingGl: [{ id: "s1", code: "HT" }],
    surchargesMissingGl: [{ id: "u1", name: "Energy" }],
    paymentTypesMissingGl: [{ id: "p1", name: "ACH" }],
  });
  const kinds = gaps.map((g) => g.kind).sort();
  expect(kinds).toEqual(["payment-type", "plant-default", "step-code", "surcharge"]);
});

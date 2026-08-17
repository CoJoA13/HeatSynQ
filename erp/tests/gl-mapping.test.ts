import { expect, it } from "vitest";
import { cashJournal, salesJournal, reverseLines, readinessGaps, type SalesEvent, type ReadinessInput } from "@/server/gl-mapping";

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

/** The account-bearing config every readinessGaps test starts from — all set, no gaps. Each test
 *  clears exactly the field(s) it exercises so the assertion pins the gap it means to. */
const clean: ReadinessInput = {
  arGlAccountId: "ar", discountGlAccountId: "d", writeOffGlAccountId: "w", salesTaxGlAccountId: "t",
  freightGlAccountId: "f", otherChargeGlAccountId: "oc", certChargeStepCodeId: "cs",
  hasDiscount: false, hasWriteOff: false, hasTax: false, hasFreight: false, hasCharge: false, hasCert: false,
  invoicesMissingGl: [],
  stepCodesMissingGl: [], surchargesMissingGl: [], paymentTypesMissingGl: [], hasUnattributedLine: false,
};

// #89: this gap is UNCONDITIONAL — the plant defaults above are all set here, and a line frozen with
// a null GL is still a dropped credit. The pure half of "readiness read clean and the export 500'd".
it("readinessGaps names an invoice carrying a frozen null-GL line even with every default set", () => {
  const gaps = readinessGaps({ ...clean, invoicesMissingGl: [{ id: "inv1", label: "INV - 1042" }] });
  expect(gaps).toEqual([{
    kind: "invoice", id: "inv1",
    label: "Invoice INV - 1042 has a line with no GL account — unlock and re-finalize it",
    href: "/invoicing/inv1",
  }]);
});

it("readinessGaps lists a step code, surcharge, payment type, and missing A/R default", () => {
  const gaps = readinessGaps({
    ...clean, arGlAccountId: null,
    stepCodesMissingGl: [{ id: "s1", code: "HT" }],
    surchargesMissingGl: [{ id: "u1", name: "Energy" }],
    paymentTypesMissingGl: [{ id: "p1", name: "ACH" }],
  });
  const kinds = gaps.map((g) => g.kind).sort();
  expect(kinds).toEqual(["payment-type", "plant-default", "step-code", "surcharge"]);
});

it("flags a missing sales-tax account when a taxable event is in the delta", () => {
  const gaps = readinessGaps({ ...clean, salesTaxGlAccountId: null, hasTax: true });
  expect(gaps).toHaveLength(1);
  expect(gaps[0].label).toMatch(/sales tax/i);
});

it("flags missing freight / other-charge accounts when such lines are in the delta", () => {
  const gaps = readinessGaps({
    ...clean,
    freightGlAccountId: null, hasFreight: true,
    otherChargeGlAccountId: null, hasCharge: true,
  });
  expect(gaps).toHaveLength(2);
  expect(gaps.some((g) => /freight/i.test(g.label))).toBe(true);
  expect(gaps.some((g) => /charge/i.test(g.label))).toBe(true);
  // A freight/charge line with the account set is NOT a gap.
  expect(readinessGaps({ ...clean, hasFreight: true, hasCharge: true })).toEqual([]);
});

it("flags a missing cert step code only when it is unset (a set one attributes via the step-code list)", () => {
  const unset = readinessGaps({ ...clean, certChargeStepCodeId: null, hasCert: true });
  expect(unset).toHaveLength(1);
  expect(unset[0].label).toMatch(/cert/i);
  // Cert step code SET but GL-less: resolveReadiness routes it through stepCodesMissingGl, so the
  // cert plant-default branch stays quiet and the step-code gap carries it.
  const viaStep = readinessGaps({ ...clean, hasCert: true, stepCodesMissingGl: [{ id: "cs", code: "CERT" }] });
  expect(viaStep).toHaveLength(1);
  expect(viaStep[0].kind).toBe("step-code");
});

it("emits a generic gap for an unattributable account-less line (the safety net)", () => {
  const gaps = readinessGaps({ ...clean, hasUnattributedLine: true });
  expect(gaps).toHaveLength(1);
  expect(gaps[0].label).toMatch(/no GL account/i);
});

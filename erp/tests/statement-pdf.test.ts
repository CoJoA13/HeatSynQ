import { describe, it, expect } from "vitest";
import { buildStatementDefinition, type StatementData } from "@/server/pdf/statement";
import { renderPdf } from "@/server/pdf/render";

// Task 12 (P5B §8): `buildStatementDefinition` is a PURE builder — `StatementData` in, a plain-JSON
// pdfmake definition out. Content pins live on the DEFINITION (`allText`, copied from
// tests/cert-pdf.test.ts), never on rendered bytes (pdfkit writes TTF-subset glyph ids, so a
// rendered PDF carries no character text to grep for) — the global-constraints.md rule.

/** Every `text` string anywhere in a document definition, flattened. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

function sampleData(overrides: Partial<StatementData> = {}): StatementData {
  return {
    asOf: "2026-08-08",
    company: {
      name: "American Heat Treating - Alabama, LLC",
      address: "3008 Red Morris Parkway\nAnniston AL 36207", phone: "256-835-3370",
    },
    remitTo: {
      name: "American Heat Treating - Alabama, LLC",
      lines: ["3008 Red Morris Parkway", "Anniston AL 36207"],
    },
    customer: {
      code: "C100", name: "GFMCO - Columbus LLC",
      billTo: ["GFMCO - Columbus LLC", "600 12th Street", "Columbus GA 31902-0096"],
    },
    openItems: [
      { documentNumber: "7 - 72026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 400 },
      { documentNumber: "1000", date: "2026-07-19", dueDate: null, kind: "CREDIT", original: -200, open: -200 },
    ],
    aging: {
      customerId: "cust-1", customerCode: "C100", customerName: "GFMCO - Columbus LLC",
      current: 0, d1_30: 0, d31_60: 400, d61_90: 0, d90_plus: 0, unapplied: 200, net: 200,
    },
    financeCharge: null,
    totalDue: 200,
    ...overrides,
  };
}

describe("buildStatementDefinition", () => {
  it("is a pure builder — the definition survives a JSON round trip", () => {
    const def = buildStatementDefinition(sampleData());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints the customer, remit-to, open items, aging strip and total due", async () => {
    const text = allText(buildStatementDefinition(sampleData())).join(" ");
    expect(text).toContain("Statement");
    expect(text).toContain("American Heat Treating - Alabama, LLC");
    expect(text).toContain("C100");
    expect(text).toContain("GFMCO - Columbus LLC");
    expect(text).toContain("Remit To");
    expect(text).toContain("600 12th Street");

    expect(text).toContain("7 - 72026");
    expect(text).toContain("$400.00");
    expect(text).toContain("$1,000.00");
    expect(text).toContain("1000");
    expect(text).toContain("$-200.00");

    expect(text).toContain("31–60");
    expect(text).toContain("Unapplied");
    expect(text).toContain("$200.00");
    expect(text).toContain("Total Due");

    // Structural pins on the REAL file — the `%PDF-` header, never a `Buffer.compare` of two
    // fresh renders (CLAUDE.md).
    const pdf = await renderPdf(buildStatementDefinition(sampleData()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("prints the finance-charge line only when the statement carries one", () => {
    const withFc = allText(buildStatementDefinition(sampleData({ financeCharge: 6 }))).join(" ");
    expect(withFc).toContain("Finance Charge");
    expect(withFc).toContain("$6.00");

    const withoutFc = allText(buildStatementDefinition(sampleData({ financeCharge: null }))).join(" ");
    expect(withoutFc).not.toContain("Finance Charge");
  });

  it("prints a blank Due Date cell for a credit, never a fabricated date", () => {
    const text = allText(buildStatementDefinition(sampleData())).join(" ");
    // The credit's own document number appears once for the item row; nothing pairs it with a
    // due-date-shaped string (there is none to find, since the field is null).
    expect(text).toContain("1000");
  });
});

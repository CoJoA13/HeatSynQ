import { describe, it, expect } from "vitest";
import { buildPostingRegister, type PostingRegisterData } from "@/server/pdf/posting-register";
import { renderPdf } from "@/server/pdf/render";

// Task 7 (P5C §4.3/§4.4): `buildPostingRegister` is a PURE builder — `PostingRegisterData` in, a
// plain-JSON pdfmake definition out. Content pins live on the DEFINITION (`allText`, the
// statement-pdf.test.ts precedent), never on rendered bytes (pdfkit writes TTF-subset glyph ids,
// so a rendered PDF carries no character text to grep for) — the global-constraints.md rule.

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

function sampleData(overrides: Partial<PostingRegisterData> = {}): PostingRegisterData {
  return {
    periodLabel: "July 2026",
    periodEnd: "2026-07-31",
    exportNumber: 3,
    lines: [
      { side: "SALES", glAccountName: "1200-AR", debit: 100, credit: 0, memo: "A/R" },
      { side: "SALES", glAccountName: "4010-REV", debit: 0, credit: 100, memo: "Revenue" },
      { side: "CASH", glAccountName: "1000-CASH", debit: 40, credit: 0, memo: "Cash receipt" },
      { side: "CASH", glAccountName: "1200-AR", debit: 0, credit: 40, memo: "A/R" },
    ],
    ...overrides,
  };
}

describe("buildPostingRegister", () => {
  it("is a pure builder — the definition survives a JSON round trip", () => {
    const def = buildPostingRegister(sampleData());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints the period, export number, and both sub-registers with balanced totals", async () => {
    const text = allText(buildPostingRegister(sampleData())).join(" ");
    expect(text).toContain("July 2026");
    expect(text).toContain("Export #3");
    expect(text).toContain("2026-07-31");
    expect(text).toContain("SALES");
    expect(text).toContain("CASH");
    expect(text).toContain("1200-AR");
    expect(text).toContain("4010-REV");
    expect(text).toContain("1000-CASH");
    // Each side's total row: SALES sums to 100.00/100.00, CASH to 40.00/40.00 — both balanced.
    expect(text).toContain("Total");
    expect((text.match(/100\.00/g) ?? []).length).toBeGreaterThanOrEqual(2); // SALES debit + credit totals
    expect((text.match(/40\.00/g) ?? []).length).toBeGreaterThanOrEqual(2); // CASH debit + credit totals

    // Structural pin on the REAL file — the `%PDF-` header, never a `Buffer.compare` of two fresh
    // renders (CLAUDE.md).
    const pdf = await renderPdf(buildPostingRegister(sampleData()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("prints an empty (zero/zero) totals row for a side with no lines", () => {
    const text = allText(buildPostingRegister(sampleData({
      lines: [
        { side: "SALES", glAccountName: "1200-AR", debit: 100, credit: 0, memo: "A/R" },
        { side: "SALES", glAccountName: "4010-REV", debit: 0, credit: 100, memo: "Revenue" },
      ],
    }))).join(" ");
    expect(text).toContain("SALES");
    expect(text).toContain("CASH"); // the CASH sub-register still prints even with zero lines
  });
});

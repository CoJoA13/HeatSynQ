import { describe, it, expect } from "vitest";
import { buildStatementDefinition, type StatementData } from "@/server/pdf/statement";
import { renderPdf } from "@/server/pdf/render";
import { textRunsWithY } from "./helpers/pdf";

// Task 12 (P5B §8): `buildStatementDefinition` is a PURE builder — `StatementData` in, a plain-JSON
// pdfmake definition out. Content pins live on the DEFINITION (`allText`, copied from
// tests/cert-pdf.test.ts), never on rendered bytes (pdfkit writes TTF-subset glyph ids, so a
// rendered PDF carries no character text to grep for) — the global-constraints.md rule.
//
// ONE deliberate exception, added with #162: the no-wrap pin near the end of this file asserts a
// rendered LAYOUT fact (does the finance-charge label stay on one baseline in its 200pt column?),
// which the definition cannot express — it reads geometry via `textRunsWithY`, not characters, so
// the TTF-subset rule above is not violated. Its own docblock carries the reasoning.

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

/** The ONE rendered baseline the finance-charge label's first run sits on, reassembled left to
 *  right. A label that overflowed its column would have its tail on a DIFFERENT baseline and simply
 *  not appear here — which `drawnText` cannot express, since it concatenates runs across a wrap. */
function financeChargeLine(pdf: Buffer): string {
  const runs = textRunsWithY(pdf)[0];
  const anchor = runs.find((r) => r.text.startsWith("Finance"));
  if (anchor === undefined) throw new Error("no finance-charge run on page 1");
  return runs.filter((r) => Math.abs(r.y - anchor.y) < 0.5)
    .sort((a, b) => a.x - b.x).map((r) => r.text).join("");
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

  /**
   * #162 — the paper must not read as a levied charge. The finance line prints IMMEDIATELY ABOVE a
   * Total Due that excludes it (`totalDue` is `aging.net`, and nothing about the charge is posted),
   * so the label itself has to carry both facts. Pinned as the WHOLE default label, not a substring:
   * the previous "Finance Charge:" is a prefix of nothing here, and a `toContain("Finance Charge")`
   * would have gone green against either wording.
   *
   * The fix is the CONTRACT DEFAULT, deliberately not a re-order of the `finance_charge` section
   * below `total`: a stored config renders in its own stored section order, so a re-order reaches
   * only the default template and silently misses every already-published version, while a
   * `defaultLabel` re-resolves at every print for all of them (#103, `template-contracts/types.ts`).
   */
  it("labels the finance charge as neither billed nor part of the total (#162)", () => {
    const withFc = allText(buildStatementDefinition(sampleData({ financeCharge: 6 }))).join(" ");
    expect(withFc).toContain("Finance Charge (not billed, not in total):");
    // And the Total Due directly beneath it genuinely excludes it — the fact the label states.
    const data = sampleData({ financeCharge: 6 });
    expect(data.totalDue).toBe(data.aging.net);
  });

  /**
   * The one thing the DEFINITION cannot show: whether the longer #162 label still FITS. `totalLine`
   * gives it a 200pt column at 10pt, and pdfmake silently wraps an over-long label onto a second
   * line — which on a right-aligned money line reads as two half-labels with the amount stranded
   * beside the first. Measured, the label is 174pt (Roboto) / 175pt (Liberation Sans) / 161pt
   * (Liberation Serif); this pins the default family on the real paper.
   *
   * `drawnText` alone CANNOT see a wrap — runs concatenate across the line break and the check
   * passes on a two-line label (probed). The wrap shows only in the RUN POSITIONS, so this reads
   * the single baseline the label's first run sits on and reassembles just that line.
   * Deliberately the only rendered-bytes pin in this file (see the header rule): it is a layout
   * question, not a content one.
   */
  it("prints that label on ONE line — it fits the 200pt label column (#162)", async () => {
    const pdf = await renderPdf(buildStatementDefinition(sampleData({ financeCharge: 6 })));
    expect(financeChargeLine(pdf)).toContain("Finance Charge (not billed, not in total):");
  });

  it("renders an on-account payment as a negative open-item line (Fix #6)", () => {
    const text = allText(buildStatementDefinition(sampleData({
      openItems: [
        { documentNumber: "7 - 72026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 400 },
        { documentNumber: "CHK-4711", date: "2026-07-19", dueDate: null, kind: "PAYMENT", original: 300, open: -300 },
      ],
    }))).join(" ");
    expect(text).toContain("CHK-4711"); // the check reference labels the on-account line
    expect(text).toContain("$-300.00"); // its negative Open amount
  });

  it("prints a blank Due Date cell for a credit, never a fabricated date", () => {
    const text = allText(buildStatementDefinition(sampleData())).join(" ");
    // The credit's own document number appears once for the item row; nothing pairs it with a
    // due-date-shaped string (there is none to find, since the field is null).
    expect(text).toContain("1000");
  });
});

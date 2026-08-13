import { describe, it, expect } from "vitest";
import { jpegDataUri, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import type { RenderableDefinition } from "@/server/pdf/render";
import { TINY_JPEG, drawnPages, drawnText, pageCount } from "./helpers/pdf";

/**
 * Phase 7 Task 6 — the render runtime's declarative primitives (spec §6.1–§6.3): the page-footer
 * spec, the continuation-header spec, per-sheet-group rendering + merge, the four-family font
 * map, and the JPEG data-uri helper. No database — everything here is pure render plumbing.
 *
 * CONTENT-ASSERTION TECHNIQUE. The footer and continuation header exist only as renderer-side
 * callbacks (the named-table-layouts indirection), so `allText` over the definition — the house
 * technique for builder output — cannot see them, and CLAUDE.md forbids `Buffer.compare` between
 * fresh renders. `drawnText` below therefore decodes what the RENDERED bytes actually draw:
 * pdfkit embeds each font as a subset whose text operators carry subset glyph ids (never ASCII),
 * but every embedded font also carries a ToUnicode CMap mapping those ids back to Unicode — the
 * same table a PDF viewer's copy-paste uses. Inflate every FlateDecode stream, parse the CMaps,
 * decode every text run through them, and the assertions read the words the paper really shows.
 * The `/Type /Pages /Count N` marker stays the page-count assertion (traveler.test.ts's rule).
 * The decoder itself (`drawnPages`/`drawnText`/`pageCount`, and the TINY_JPEG fixture) lives in
 * tests/helpers/pdf.ts — lifted there by Task 7, the moment a second suite needed it.
 */

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

// ------------------------------------------------------------------------------------------------
// Fixtures — body text carries NO digits (see drawnText's contract)
// ------------------------------------------------------------------------------------------------

/** A two-page definition: one text node per page, split by an explicit pageBreak. */
function twoPageDef(extra: Partial<RenderableDefinition> = {}): RenderableDefinition {
  return {
    content: [
      { text: "alpha body", pageBreak: "after" },
      { text: "beta body" },
    ],
    ...extra,
  };
}

// ------------------------------------------------------------------------------------------------
// The page-footer spec
// ------------------------------------------------------------------------------------------------

describe("pageFooterSpec — the declarative pageNofM footer (spec §6.1)", () => {
  it("a 2-page definition renders 'Page N of M' on its own page, and /Count 2", async () => {
    const pdf = await renderPdf(twoPageDef({ pageFooterSpec: { kind: "pageNofM" } }));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    expect(pages).toHaveLength(2);
    expect(count(pages[0], "Page 1 of 2")).toBe(1);
    expect(pages[0]).not.toContain("Page 2 of 2");
    expect(count(pages[1], "Page 2 of 2")).toBe(1);
    expect(pages[1]).not.toContain("Page 1 of 2");
  });

  it("label overrides the 'Page' prefix — 'Page:' reproduces the quote's exact footer text", async () => {
    const pdf = await renderPdf(
      twoPageDef({ pageFooterSpec: { kind: "pageNofM", label: "Page:" } }));
    const text = drawnText(pdf);
    expect(text).toContain("Page: 1 of 2");
    expect(text).toContain("Page: 2 of 2");
  });

  it("a spec-less definition renders exactly today's behavior — no footer text anywhere", async () => {
    const pdf = await renderPdf(twoPageDef());
    expect(pageCount(pdf)).toBe(2);
    expect(drawnText(pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a definition carrying BOTH a pdfmake footer and the spec is refused loudly", async () => {
    await expect(renderPdf(twoPageDef({
      footer: { text: "hand-written" }, pageFooterSpec: { kind: "pageNofM" },
    }))).rejects.toThrow(/pageFooterSpec/);
  });

  it("an unknown footer kind is refused loudly, never rendered as nothing", async () => {
    await expect(renderPdf(twoPageDef({
      pageFooterSpec: { kind: "pageXofY" } as never,
    }))).rejects.toThrow(/pageXofY/);
  });
});

// ------------------------------------------------------------------------------------------------
// The continuation-header spec
// ------------------------------------------------------------------------------------------------

describe("continuationHeaderSpec — static content on every page after the first (spec §6.1)", () => {
  const SPEC = { content: { text: "CONTINUED-MARKER-ALPHA", fontSize: 8 } };

  it("page one lacks it, page two carries it", async () => {
    const pdf = await renderPdf(twoPageDef({ continuationHeaderSpec: SPEC }));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    expect(pages).toHaveLength(2);
    expect(pages[0]).not.toContain("CONTINUED-MARKER-ALPHA");
    expect(pages[1]).toContain("CONTINUED-MARKER-ALPHA");
  });

  it("a single-page definition never shows it at all", async () => {
    const pdf = await renderPdf({
      content: [{ text: "lonely body" }], continuationHeaderSpec: SPEC,
    });
    expect(pageCount(pdf)).toBe(1);
    expect(drawnText(pdf)).not.toContain("CONTINUED-MARKER-ALPHA");
  });

  it("a definition carrying BOTH a pdfmake header and the spec is refused loudly", async () => {
    await expect(renderPdf(twoPageDef({
      header: { text: "hand-written" }, continuationHeaderSpec: SPEC,
    }))).rejects.toThrow(/continuationHeaderSpec/);
  });
});

// ------------------------------------------------------------------------------------------------
// Per-sheet-group rendering + merge (spec §6.1 — the pdf-lib seam, #36's mechanism)
// ------------------------------------------------------------------------------------------------

describe("renderSheetGroups — each group renders alone, the PDFs merge into one document", () => {
  /** A three-page sibling of twoPageDef — digit-free body text, one node per page. */
  const threePageDef = (extra: Partial<RenderableDefinition> = {}): RenderableDefinition => ({
    content: [
      { text: "gamma body", pageBreak: "after" },
      { text: "delta body", pageBreak: "after" },
      { text: "epsilon body" },
    ],
    ...extra,
  });

  it("2-page + 3-page groups merge to /Count 5, and each group's footer restarts at ITS OWN 'Page 1 of N'", async () => {
    const merged = await renderSheetGroups([
      twoPageDef({ pageFooterSpec: { kind: "pageNofM" } }),
      threePageDef({ pageFooterSpec: { kind: "pageNofM" } }),
    ]);
    expect(merged.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(merged)).toBe(5); // the uncompressed marker survives useObjectStreams: false

    const pages = drawnPages(merged);
    expect(pages).toHaveLength(5);
    // Group one numbers its own two pages…
    expect(pages[0]).toContain("Page 1 of 2");
    expect(pages[1]).toContain("Page 2 of 2");
    // …group two restarts at 1 and counts to ITS three…
    expect(pages[2]).toContain("Page 1 of 3");
    expect(pages[3]).toContain("Page 2 of 3");
    expect(pages[4]).toContain("Page 3 of 3");
    // …and nothing ever numbers against the merged document's five (per-group, not per-document).
    expect(drawnText(merged)).not.toContain("of 5");
  });

  it("each group's continuation header stays scoped to its own pages", async () => {
    const merged = await renderSheetGroups([
      twoPageDef({ continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-ALPHA" } } }),
      threePageDef({ continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-BETA" } } }),
    ]);
    const pages = drawnPages(merged);
    expect(pages).toHaveLength(5);
    // Each group's FIRST page is bare — page three of the merged document is a first page again.
    expect(pages[0]).not.toContain("CONTINUED-MARKER");
    expect(pages[1]).toContain("CONTINUED-MARKER-ALPHA");
    expect(pages[2]).not.toContain("CONTINUED-MARKER");
    expect(pages[3]).toContain("CONTINUED-MARKER-BETA");
    expect(pages[4]).toContain("CONTINUED-MARKER-BETA");
  });

  it("a single group still comes out whole (its own count, its own numbering)", async () => {
    const merged = await renderSheetGroups([twoPageDef({ pageFooterSpec: { kind: "pageNofM" } })]);
    expect(pageCount(merged)).toBe(2);
    expect(drawnText(merged)).toContain("Page 2 of 2");
  });

  it("an empty group list is refused loudly — a zero-page PDF is never produced", async () => {
    await expect(renderSheetGroups([])).rejects.toThrow(/at least one/);
  });
});

// ------------------------------------------------------------------------------------------------
// Purity — the new keys are data (the template-as-data contract, spec §10)
// ------------------------------------------------------------------------------------------------

describe("purity — definitions carrying the spec keys stay plain JSON", () => {
  it("both keys survive JSON.parse(JSON.stringify(...)) and render identically after the round trip", async () => {
    const def = twoPageDef({
      pageFooterSpec: { kind: "pageNofM", label: "Sheet" },
      continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-ALPHA", fontSize: 8 } },
    });
    const roundTripped = JSON.parse(JSON.stringify(def)) as RenderableDefinition;
    expect(roundTripped).toEqual(def); // nothing was a function; nothing was lost

    const a = await renderPdf(def);
    const b = await renderPdf(roundTripped);
    // Identical CONTENT, never Buffer.compare between fresh renders (CLAUDE.md).
    expect(pageCount(a)).toBe(pageCount(b));
    expect(drawnText(a)).toBe(drawnText(b));
    expect(drawnText(a)).toContain("Sheet 1 of 2");
  });
});

// ------------------------------------------------------------------------------------------------
// The unregistered-font belt (spec §6.2 — the contracts refuse at validation; this is render-side)
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
// JPEG embedding (spec §6.3 — the logo path's second mime type)
// ------------------------------------------------------------------------------------------------


describe("jpegDataUri — the pngDataUri sibling", () => {
  it("produces a data URI pdfmake accepts — the render succeeds", async () => {
    const uri = jpegDataUri(TINY_JPEG);
    expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    const pdf = await renderPdf({ content: [{ image: uri, width: 20 }] });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// The four-family font map (spec §6.2, owner ruling 5)
// ------------------------------------------------------------------------------------------------

describe("the contract-enumerated font families all render", () => {
  it.each(["Roboto", "Liberation Sans", "Liberation Serif", "Roboto Mono"])(
    "'%s' renders in all four styles and the drawn text reads back", async (family) => {
      const pdf = await renderPdf({
        defaultStyle: { font: family },
        content: [
          { text: `body set in ${family}` },
          { text: "bold run", bold: true },
          { text: "italic run", italics: true },
          { text: "bold italic run", bold: true, italics: true },
        ],
      });
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const text = drawnText(pdf);
      expect(text).toContain(`body set in ${family}`);
      expect(text).toContain("bold run");
      expect(text).toContain("italic run");
      expect(text).toContain("bold italic run");
    });
});

describe("unregistered font families fail the render loudly", () => {
  it("defaultStyle naming an unregistered family throws naming it and the registered set", async () => {
    await expect(renderPdf({
      defaultStyle: { font: "Comic Sans" }, content: [{ text: "x" }],
    })).rejects.toThrow(/Font family "Comic Sans" is not registered/);
  });

  it("an inline node's font is caught too — never a silent fallback", async () => {
    await expect(renderPdf({
      content: [{ text: "x", font: "Papyrus" }],
    })).rejects.toThrow(/Font family "Papyrus" is not registered/);
  });
});

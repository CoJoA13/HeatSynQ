import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { jpegDataUri, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import type { RenderableDefinition } from "@/server/pdf/render";

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
 */

// ------------------------------------------------------------------------------------------------
// PDF-byte helpers
// ------------------------------------------------------------------------------------------------

/** The PDF's own page count, read off its uncompressed `/Type /Pages /Count N` object. */
function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

type PdfObj = { body: string; stream: Buffer | null };

/**
 * Every `N 0 obj` in the file, keyed by number: its dict/body text plus its stream bytes,
 * inflated where FlateDecode'd. Parsed sequentially — after a stream the scan resumes past
 * `endstream`, so binary stream data can never be misread as an object header.
 */
function parseObjects(pdf: Buffer): Map<number, PdfObj> {
  const s = pdf.toString("latin1"); // byte-for-byte, so string offsets are byte offsets
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const start = m.index + m[0].length;
    const endobjIdx = s.indexOf("endobj", start);
    if (endobjIdx === -1) break;
    const streamIdx = s.indexOf("stream", start);
    if (streamIdx !== -1 && streamIdx < endobjIdx) {
      const body = s.slice(start, streamIdx);
      let dataStart = streamIdx + 6;
      if (pdf[dataStart] === 0x0d) dataStart++;
      if (pdf[dataStart] === 0x0a) dataStart++;
      const endstreamIdx = s.indexOf("endstream", dataStart);
      let e = endstreamIdx;
      while (e > dataStart && (pdf[e - 1] === 0x0a || pdf[e - 1] === 0x0d)) e--;
      const bytes = pdf.subarray(dataStart, e);
      let stream: Buffer;
      try { stream = zlib.inflateSync(bytes); } catch { stream = Buffer.from(bytes); }
      objs.set(Number(m[1]), { body, stream });
      re.lastIndex = s.indexOf("endobj", endstreamIdx) + 6;
    } else {
      objs.set(Number(m[1]), { body: s.slice(start, endobjIdx), stream: null });
      re.lastIndex = endobjIdx + 6;
    }
  }
  return objs;
}

type Cmap = Map<number, string>;

/** One embedded font's glyph-id → Unicode map, parsed from its ToUnicode CMap stream (bfchar
 *  pairs, bfrange with an array, and sequential bfrange all handled). */
function parseCmap(buf: Buffer): Cmap {
  const s = buf.toString("latin1");
  const map: Cmap = new Map();
  const hexToUtf16 = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfchar.exec(s)) !== null) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1])) !== null) map.set(parseInt(p[1], 16), hexToUtf16(p[2]));
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(s)) !== null) {
    const entryRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F]+>)/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(m[1])) !== null) {
      const lo = parseInt(e[1], 16);
      if (e[3].startsWith("[")) {
        const items = [...e[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        items.forEach((u, i) => map.set(lo + i, hexToUtf16(u)));
      } else {
        const start = parseInt(e[3].slice(1, -1), 16);
        const hi = parseInt(e[2], 16);
        for (let g = lo; g <= hi; g++) map.set(g, String.fromCharCode(start + (g - lo)));
      }
    }
  }
  return map;
}

/** The page objects in true page order — the root /Pages object's /Kids array, flattened
 *  depth-first (both pdfkit's and pdf-lib's trees are flat, but recursion costs nothing). */
function pagesInOrder(objs: Map<number, PdfObj>): PdfObj[] {
  const isPages = (o: PdfObj): boolean => /\/Type\s*\/Pages\b/.test(o.body);
  const kidRefs = (o: PdfObj): number[] => {
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(o.body);
    return kids ? [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
  };
  // The root: a /Pages object no other /Pages object lists as a kid.
  const pagesObjs = [...objs.entries()].filter(([, o]) => isPages(o));
  const listed = new Set(pagesObjs.flatMap(([, o]) => kidRefs(o)));
  const root = pagesObjs.find(([num]) => !listed.has(num));
  if (!root) throw new Error("No root /Pages object found");
  const out: PdfObj[] = [];
  const walk = (num: number): void => {
    const o = objs.get(num);
    if (!o) return;
    if (isPages(o)) kidRefs(o).forEach(walk);
    else if (/\/Type\s*\/Page\b/.test(o.body)) out.push(o);
  };
  kidRefs(root[1]).forEach(walk);
  return out;
}

/**
 * What each page actually draws, decoded exactly: for every page, its /Resources /Font dict maps
 * resource names to font objects, each font's ToUnicode CMap maps subset glyph ids to Unicode,
 * and the content stream is walked operator-by-operator — `Tf` selects the active font, each
 * TJ/Tj run decodes through THAT font's CMap (no cross-font guessing). pdfkit splits a line into
 * word-level runs that keep their trailing spaces, so concatenating a page's runs reassembles
 * its phrases exactly. Returns one string per page, in page order.
 */
function drawnPages(pdf: Buffer): string[] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    // Resources: inline dict or an indirect reference.
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
    const fonts = new Map<string, Cmap>();
    for (const [, name, num] of fontDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const fontObj = objs.get(Number(num));
      const toUni = fontObj && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObj.body);
      const cmapStream = toUni && objs.get(Number(toUni[1]))?.stream;
      if (cmapStream) fonts.set(name, parseCmap(cmapStream));
    }
    // Contents: a single ref or an array of refs.
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    const runs: string[] = [];
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      const opRe = /\/(\w+)\s+[\d.]+\s+Tf|\[((?:<[0-9a-fA-F]+>|[-\d.\s])+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
      let active: Cmap | undefined;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(content)) !== null) {
        if (m[1] !== undefined) { active = fonts.get(m[1]); continue; }
        const hexes = [...(m[2] ?? `<${m[3]}>`).matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        let text = "";
        for (const h of hexes) {
          for (let i = 0; i + 4 <= h.length; i += 4) {
            text += active?.get(parseInt(h.slice(i, i + 4), 16)) ?? "�";
          }
        }
        runs.push(text);
      }
    }
    return runs.join("");
  });
}

/** All pages' drawn text, newline-joined — the whole-document containment assertion. */
function drawnText(pdf: Buffer): string {
  return drawnPages(pdf).join("\n");
}

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

// A real 2×2 JPEG (PIL-generated for this suite; SOI + JFIF + SOF0, 633 bytes) — pdfkit parses
// the marker structure, so the fixture must be a genuine JPEG, not just magic bytes.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi" +
  "MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7" +
  "Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI" +
  "CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol" +
  "JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip" +
  "qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA" +
  "AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR" +
  "ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaX" +
  "mJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEA" +
  "PwDmaKKK8g/RD//Z",
  "base64");

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

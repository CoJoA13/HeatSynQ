/**
 * PDF-byte decoding for content assertions — lifted verbatim from tests/render-primitives.test.ts
 * (Phase 7 Task 6's decoder, moved here by Task 7 the moment a second suite needed it, per the
 * Task 6 report's own note), plus the `endstream` guard the Task 6 review carried: a stream with
 * no terminator now fails NAMING the parse problem instead of feeding `-1` into
 * `subarray`/`indexOf` and producing confusing downstream assertion failures.
 *
 * WHY BYTES, NOT DEFINITIONS. Renderer-side callbacks (page footers, continuation headers) and
 * anything asserted "through the real print path" exist only in the RENDERED bytes — the house
 * `allText`-over-definition technique cannot see them, and CLAUDE.md forbids `Buffer.compare`
 * between fresh renders. pdfkit embeds each font as a subset whose text operators carry subset
 * glyph ids (never ASCII), but every embedded font also carries a ToUnicode CMap mapping those
 * ids back to Unicode — the same table a PDF viewer's copy-paste uses. `drawnPages` inflates
 * every FlateDecode stream, parses the CMaps, walks each page's content stream with `Tf` font
 * tracking, and decodes every TJ/Tj run through the ACTIVE font's map — per-page, exact, no
 * cross-font guessing. The `/Type /Pages /Count N` marker stays the page-count assertion
 * (traveler.test.ts's rule); nothing here ever compares two fresh renders byte-for-byte.
 */
import zlib from "node:zlib";

/** The PDF's own page count, read off its uncompressed `/Type /Pages /Count N` object. */
export function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

export type PdfObj = { body: string; stream: Buffer | null };

/**
 * Every `N 0 obj` in the file, keyed by number: its dict/body text plus its stream bytes,
 * inflated where FlateDecode'd. Parsed sequentially — after a stream the scan resumes past
 * `endstream`, so binary stream data can never be misread as an object header.
 */
export function parseObjects(pdf: Buffer): Map<number, PdfObj> {
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
      // The Task 6 review carry: a missing terminator must be a clear parse error, never a `-1`
      // silently fed into subarray/indexOf below.
      if (endstreamIdx === -1) {
        throw new Error(
          `PDF parse error: object ${m[1]} opens a stream at byte ${dataStart} with no endstream`);
      }
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

/**
 * One embedded font's glyph-id → Unicode map, parsed from its ToUnicode CMap stream (bfchar
 * pairs, bfrange with an array, and sequential bfrange all handled).
 *
 * A destination is a UTF-16BE *string*, not one code point: pdfkit writes a LIGATURE's glyph as a
 * multi-code-point destination (`fl` → `<0066 006c>`), and inside a bfrange array those code
 * points arrive space-separated. Task 8 found this the hard way — a hex pattern that stopped at
 * the space matched no item at all for the ligature, so every LATER entry in the array shifted
 * down one glyph id and the page decoded as a consistent substitution cipher ("the" → "lfe").
 * Any fixture text containing fi/fl/ff hits it (the Task 8 overflow fixture's "Overflow Co" did),
 * so the hex classes below deliberately admit whitespace and `hexToUtf16` strips it.
 */
function parseCmap(buf: Buffer): Cmap {
  const s = buf.toString("latin1");
  const map: Cmap = new Map();
  const hexToUtf16 = (raw: string): string => {
    const hex = raw.replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfchar.exec(s)) !== null) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1])) !== null) map.set(parseInt(p[1], 16), hexToUtf16(p[2]));
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(s)) !== null) {
    const entryRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F\s]+>)/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(m[1])) !== null) {
      const lo = parseInt(e[1], 16);
      if (e[3].startsWith("[")) {
        const items = [...e[3].matchAll(/<([0-9a-fA-F\s]+)>/g)].map((x) => x[1]);
        items.forEach((u, i) => map.set(lo + i, hexToUtf16(u)));
      } else {
        // A sequential range increments the destination's LAST code unit; anything before it is a
        // fixed prefix (the multi-code-point case again).
        const hex = e[3].slice(1, -1).replace(/\s+/g, "");
        const prefix = hexToUtf16(hex.slice(0, -4));
        const start = parseInt(hex.slice(-4), 16);
        const hi = parseInt(e[2], 16);
        for (let g = lo; g <= hi; g++) map.set(g, prefix + String.fromCharCode(start + (g - lo)));
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
export function drawnPages(pdf: Buffer): string[] {
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
export function drawnText(pdf: Buffer): string {
  return drawnPages(pdf).join("\n");
}

/**
 * Decoded text runs WITH their device-space positions, per page — what a reading-order/overlap
 * assertion needs (Task 9's tear-off reflow regression: "the strip must sit BELOW every part
 * row on the page they share", which plain `drawnPages` cannot see because stream order and
 * paper order diverge exactly when `absolutePosition` is involved).
 *
 * Coordinates: PDF device space, y from the page's BOTTOM edge — larger y is HIGHER on the
 * paper. pdfkit brackets every run as `q / 1 0 0 -1 0 792 cm / BT / a b c d x y Tm / Tf / TJ /
 * ET / Q` inside a stream whose OWN leading flip cm composes with that inner flip back to the
 * identity, so the Tm translation IS the run's device-space baseline position (verified against
 * a flowed node at the 24pt top margin decoding to y≈757 and an `absolutePosition: {y: 648}`
 * node to y≈133). Deliberately additive beside `drawnPages` — that decoder is load-bearing for
 * every content assertion in the suite, and this one's Tm tracking is pdfkit-shaped (no Td/TD
 * chasing, which pdfkit does not emit).
 */
export function textRunsWithY(pdf: Buffer): { text: string; x: number; y: number }[][] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
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
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    const runs: { text: string; x: number; y: number }[] = [];
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      const opRe =
        /\/(\w+)\s+[\d.]+\s+Tf|(?:[-\d.]+\s+){4}([-\d.]+)\s+([-\d.]+)\s+Tm|\[((?:<[0-9a-fA-F]+>|[-\d.\s])+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
      let active: Cmap | undefined;
      let x = 0;
      let y = 0;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(content)) !== null) {
        if (m[1] !== undefined) { active = fonts.get(m[1]); continue; }
        if (m[2] !== undefined) { x = Number(m[2]); y = Number(m[3]); continue; }
        const hexes = [...(m[4] ?? `<${m[5]}>`).matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => h[1]);
        let text = "";
        for (const h of hexes) {
          for (let i = 0; i + 4 <= h.length; i += 4) {
            text += active?.get(parseInt(h.slice(i, i + 4), 16)) ?? "�";
          }
        }
        runs.push({ text, x, y });
      }
    }
    return runs;
  });
}

/**
 * Image paints per page, in page order: each `/Name Do` in a page's content stream(s) whose
 * resource entry is an image XObject counts once. SMask children never paint via `Do` (they are
 * referenced from an image's own dict), so like traveler-templates' `countImages` this counts
 * pictures ON the paper — but per page, which is what a continuation-header assertion needs
 * ("page two carries the barcode"). Survives the pdf-lib merge; the /XObject dict may arrive
 * inline (pdfkit) or as an indirect reference (pdf-lib copies), so both shapes resolve.
 */
export function paintedImageCounts(pdf: Buffer): number[] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const xobjRef = /\/XObject\s+(\d+)\s+0\s+R/.exec(resources);
    const xobjDict = xobjRef
      ? (objs.get(Number(xobjRef[1]))?.body ?? "")
      : (/\/XObject\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "");
    const imageNames = new Set<string>();
    for (const [, name, num] of xobjDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      if (/\/Subtype\s*\/Image/.test(objs.get(Number(num))?.body ?? "")) imageNames.add(name);
    }
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    let painted = 0;
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      for (const [, name] of content.matchAll(/\/(\w+)\s+Do\b/g)) {
        if (imageNames.has(name)) painted++;
      }
    }
    return painted;
  });
}

// A real 2×2 JPEG (PIL-generated for the Task 6 suite; SOI + JFIF + SOF0, 633 bytes) — pdfkit
// parses the marker structure, so the fixture must be a genuine JPEG, not just magic bytes.
// Exported beside the decoder because every suite that embeds a JPEG (render primitives, the
// traveler's template logo) needs the same genuine fixture.
export const TINY_JPEG = Buffer.from(
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

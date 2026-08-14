/**
 * The pdfmake + bwip-js plumbing, and the only file in the app that knows either library exists
 * (design spec §10). Everything above it deals in plain JSON document definitions — the
 * template-as-data contract Phase 7's designer will edit — so swapping the renderer never
 * reaches past this module.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import PdfPrinter from "pdfmake/src/printer.js";
import vfs from "pdfmake/build/vfs_fonts.js";
import { toBuffer } from "bwip-js/node";
// pdf-lib is imported ONLY here (plan Global Constraints): it exists solely to merge the
// per-sheet-group PDFs renderSheetGroups produces, and no other file may reach for it — the
// same module boundary that confines pdfmake and bwip-js to this file.
import { PDFDocument } from "pdf-lib";

/**
 * The font map — the four contract-enumerated families (Phase 7 spec §6.2, owner ruling 5),
 * every family fed to `PdfPrinter` as BUFFERS built once at module load. ONE mechanism per
 * family, and each family keeps its own:
 *
 * - **Roboto** stays decoded out of pdfmake's own bundled vfs — the pre-Phase-7 mechanism,
 *   under the exact same map key, so every unconverted builder and the posting register render
 *   byte-for-byte the paths they always have. The browser build's `pdfMake.createPdf(...)` was
 *   tried first (Phase 3) and is the wrong tool under Node: it wants a global `window`, and its
 *   vfs plumbing exists to fetch fonts the browser cannot read off disk. `PdfPrinter` is
 *   pdfmake's documented server entry point.
 * - **Liberation Sans / Liberation Serif / Roboto Mono** are `.ttf` assets vendored in
 *   `fonts/` beside this file (provenance + sha256 per file: `fonts/PROVENANCE.md`), read from
 *   an app-root-resolved path. `PdfPrinter` normally takes .ttf FILE PATHS — deliberately not
 *   used for either mechanism, because a path handed to pdfkit at render time would have to
 *   survive `output: "standalone"`'s file tracing into the Docker image unverified; reading the
 *   bytes eagerly at module load fails loudly at boot instead of at the first print, and
 *   `next.config.ts`'s `outputFileTracingIncludes` carries the files into the standalone output
 *   (physically verified, Task 6 report).
 *
 * Built once rather than per render: the printer is stateless across `createPdfKitDocument`
 * calls, and a traveler for a 14-load order is one call, not fourteen.
 */
const FONT_DIR = path.join(process.cwd(), "src", "server", "pdf", "fonts");
const ttf = (rel: string): Buffer => readFileSync(path.join(FONT_DIR, rel));

const FONTS = {
  Roboto: {
    normal: Buffer.from(vfs["Roboto-Regular.ttf"], "base64"),
    bold: Buffer.from(vfs["Roboto-Medium.ttf"], "base64"),
    italics: Buffer.from(vfs["Roboto-Italic.ttf"], "base64"),
    bolditalics: Buffer.from(vfs["Roboto-MediumItalic.ttf"], "base64"),
  },
  "Liberation Sans": {
    normal: ttf("liberation-sans/LiberationSans-Regular.ttf"),
    bold: ttf("liberation-sans/LiberationSans-Bold.ttf"),
    italics: ttf("liberation-sans/LiberationSans-Italic.ttf"),
    bolditalics: ttf("liberation-sans/LiberationSans-BoldItalic.ttf"),
  },
  "Liberation Serif": {
    normal: ttf("liberation-serif/LiberationSerif-Regular.ttf"),
    bold: ttf("liberation-serif/LiberationSerif-Bold.ttf"),
    italics: ttf("liberation-serif/LiberationSerif-Italic.ttf"),
    bolditalics: ttf("liberation-serif/LiberationSerif-BoldItalic.ttf"),
  },
  "Roboto Mono": {
    normal: ttf("roboto-mono/RobotoMono-Regular.ttf"),
    bold: ttf("roboto-mono/RobotoMono-Bold.ttf"),
    italics: ttf("roboto-mono/RobotoMono-Italic.ttf"),
    bolditalics: ttf("roboto-mono/RobotoMono-BoldItalic.ttf"),
  },
};

const printer = new PdfPrinter(FONTS);

/**
 * Custom table layouts, registered by NAME.
 *
 * This indirection is what keeps a document definition plain JSON. pdfmake also accepts a layout
 * as an inline object of callbacks, and that was the first cut here — until the purity test in
 * tests/traveler.test.ts caught it: a definition carrying functions does not survive
 * `JSON.parse(JSON.stringify(...))`, so it could never be stored, versioned or edited as data,
 * which is exactly what spec §10 promises a template is. Names live in the definition; the
 * drawing code lives here, in the renderer, and is handed to pdfmake per render.
 */
export const LAYOUT = {
  /** Horizontal rules only — the mockup's part-lines and quantity blocks are ruled, not gridded. */
  ruled: "traveler-ruled",
  /** As `ruled`, plus verticals around the trailing handwriting-box columns. */
  steps: "traveler-steps",
  /** A full grid. */
  boxed: "traveler-boxed",
} as const;

const BLACK = () => "#000000";
const TABLE_LAYOUTS = {
  [LAYOUT.ruled]: { hLineWidth: () => 0.8, vLineWidth: () => 0, hLineColor: BLACK },
  [LAYOUT.steps]: {
    hLineWidth: () => 0.8, vLineWidth: (i: number) => (i >= 3 ? 0.8 : 0),
    hLineColor: BLACK, vLineColor: BLACK,
  },
  [LAYOUT.boxed]: {
    hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: BLACK, vLineColor: BLACK,
  },
};

// ------------------------------------------------------------------------------------------------
// Declarative page callbacks (Phase 7 spec §6.1) — the named-table-layouts indirection, again
// ------------------------------------------------------------------------------------------------

/** `{ kind: "pageNofM" }` renders `"${label} N of M"` (label defaults to `"Page"`) bottom-right
 *  on every page — the quote's hand-written footer, generalized (label `"Page:"` reproduces it
 *  exactly, Task 14's conversion).
 *
 *  `above` (Task 11): static JSON content stacked OVER the page line, drawn on every page by the
 *  same callback. It exists because the cert (and Task 12's invoice) already print a static
 *  per-page company strip through pdfmake's `footer`, and the both-keys refusal below is
 *  deliberate — a builder whose paper carries such a strip passes it here when the knob turns
 *  on, instead of losing it or competing for the one footer slot. Plain data, like everything
 *  else on these specs; the callback deep-clones it per page (pdfmake decorates laid-out nodes —
 *  the two-pass probe's own lesson). */
export type PageFooterSpec = { kind: "pageNofM"; label?: string; above?: Content };

/** Static JSON content (text/images — never functions) repeated by a renderer-side header
 *  callback on every page AFTER the first of the definition.
 *
 *  `overflowTopMargin` (Task 8, #36's margin story): the header draws in the page's TOP MARGIN,
 *  and pdfmake margins are per-document — a header taller than the definition's own top margin
 *  (the traveler's identity band: text + a 44pt barcode against a 24pt margin) would overlap the
 *  body on pages 2+, while unconditionally widening the margin would move page one of EVERY
 *  print (the golden-compat killer). Setting this asks `renderPdf` for the two-pass render: a
 *  definition that fits one page keeps its original margins untouched (the header never shows on
 *  a one-page document anyway); an overflowing one re-renders with the top margin raised to at
 *  least this reserve, so the header has its room on every continuation page. Absent = the
 *  pre-Task-8 single-pass behavior: the header must fit the definition's own top margin. */
export type ContinuationHeaderSpec = { content: Content; overflowTopMargin?: number };

/**
 * A pdfmake document definition plus the two declarative keys `renderPdf` understands. The key
 * names are deliberately NOT pdfmake's own (`footer`/`header`) and carry the `Spec` suffix no
 * pdfmake key uses, so they can never collide with a definition key pdfmake consumes itself.
 * Both are plain data — the JSON round-trip contract (spec §10) extends to them; the CALLBACKS
 * they describe are constructed below, in the renderer, and exist only in this file.
 */
export type RenderableDefinition = TDocumentDefinitions & {
  pageFooterSpec?: PageFooterSpec;
  continuationHeaderSpec?: ContinuationHeaderSpec;
};

/**
 * Strips the declarative keys off the definition and hands pdfmake the callbacks they describe.
 * A definition carrying BOTH a spec key and the pdfmake key it drives is refused loudly — two
 * competing footers is a builder bug, and pdfmake would silently honor whichever this function
 * happened to assign last. An unknown footer kind is refused the same way (a typo'd kind must
 * never render as "no footer").
 */
function toPdfmakeDefinition(def: RenderableDefinition): TDocumentDefinitions {
  const { pageFooterSpec, continuationHeaderSpec, ...rest } = def;
  const out: TDocumentDefinitions = rest;
  if (pageFooterSpec !== undefined) {
    if (rest.footer !== undefined) {
      throw new Error(
        "Definition carries both a pdfmake `footer` and a `pageFooterSpec` — use one or the other");
    }
    if (pageFooterSpec.kind !== "pageNofM") {
      throw new Error(
        `Unknown pageFooterSpec kind "${String(pageFooterSpec.kind)}" — the renderer knows: pageNofM`);
    }
    const label = pageFooterSpec.label ?? "Page";
    const above = pageFooterSpec.above;
    // The quote's exact footer styling (pdf/quote.ts) — its Task 14 conversion must be invisible.
    out.footer = (currentPage: number, totalPages: number): Content => {
      const pageLine: Content = {
        text: `${label} ${currentPage} of ${totalPages}`,
        bold: true, fontSize: 8.5, alignment: "right", margin: [24, 8, 24, 0],
      };
      if (above === undefined) return pageLine;
      // Pristine nodes per page — see the spec's doc comment (lossless: `above` is plain JSON).
      return { stack: [JSON.parse(JSON.stringify(above)) as Content, pageLine] };
    };
  }
  if (continuationHeaderSpec !== undefined) {
    if (rest.header !== undefined) {
      throw new Error(
        "Definition carries both a pdfmake `header` and a `continuationHeaderSpec` — use one or the other");
    }
    out.header = (currentPage: number): Content | null =>
      currentPage > 1 ? continuationHeaderSpec.content : null;
  }
  return out;
}

/**
 * The render-side font belt (spec §6.2): the contracts already refuse unknown families at
 * config-validation time, but a definition reaching the renderer with an unregistered family —
 * a hand-built fixture, a future builder bug — must fail NAMING the family, never fall back
 * silently. pdfmake does throw its own error today; this belt makes the guarantee ours, with the
 * registered set in the message, independent of pdfmake's internals. The walk skips functions
 * (a definition's own callbacks are not JSON) and only ever inspects `font` string values —
 * pdfmake's one meaning for that key.
 */
function assertFontsRegistered(def: RenderableDefinition): void {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "font" && typeof value === "string" && !Object.hasOwn(FONTS, value)) {
        throw new Error(
          `Font family "${value}" is not registered with the PDF renderer — ` +
          `registered families: ${Object.keys(FONTS).join(", ")}`);
      }
      if (typeof value === "object") walk(value);
    }
  };
  walk(def);
}

/** The single-pass pdfmake render — bytes out of a definition that is already pdfmake-shaped. */
function renderBytes(def: TDocumentDefinitions): Promise<Buffer> {
  const doc = printer.createPdfKitDocument(def, { tableLayouts: TABLE_LAYOUTS });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    // pdfkit reports a bad definition (an unresolvable image, a missing font) by emitting on the
    // stream, long after createPdfKitDocument has already returned. Without this the promise
    // would simply never settle and the request would hang instead of failing.
    doc.on("error", reject);
    doc.end();
  });
}

/** pdfmake margins, normalized to `[left, top, right, bottom]` (40pt is pdfmake's own default). */
function normalizeMargins(
  margins: TDocumentDefinitions["pageMargins"],
): [number, number, number, number] {
  if (margins === undefined) return [40, 40, 40, 40];
  if (typeof margins === "number") return [margins, margins, margins, margins];
  if (margins.length === 2) return [margins[0], margins[1], margins[0], margins[1]];
  return [margins[0], margins[1], margins[2], margins[3]];
}

/**
 * Renders a document definition to PDF bytes.
 *
 * A `continuationHeaderSpec` carrying `overflowTopMargin` takes the TWO-PASS path (the spec's own
 * doc comment tells the why): pass one renders with the definition's original margins and no
 * continuation header, and a probe header callback captures pdfmake's own page total. One page →
 * those bytes ARE the result: original margins, no header, exactly as if the spec were absent —
 * the golden path costs one render, same as ever. More → pass two re-renders with the header
 * callback active and the top margin raised to at least the reserve.
 *
 * The probe renders a JSON DEEP CLONE, never the caller's nodes: pdfmake decorates content nodes
 * during layout (positions, a `resetXY` function), so pass two must lay out pristine nodes. The
 * clone is lossless because definitions are plain JSON by the house template-as-data contract
 * (every builder's purity test) — and the loud refusal below keeps that honest: a function-valued
 * definition key (a hand-written `footer`/`background` callback) would silently vanish from the
 * clone and skew the probe, so it is refused by name. Use the declarative specs instead.
 */
export async function renderPdf(def: RenderableDefinition): Promise<Buffer> {
  assertFontsRegistered(def);
  const full = toPdfmakeDefinition(def); // validates the spec/key collisions for BOTH passes
  const reserve = def.continuationHeaderSpec?.overflowTopMargin;
  if (reserve === undefined) return renderBytes(full);

  for (const [key, value] of Object.entries(def)) {
    if (typeof value === "function") {
      throw new Error(
        `overflowTopMargin's two-pass render requires a plain-JSON definition — ` +
        `"${key}" is a function (use the declarative specs instead)`);
    }
  }
  const probe = toPdfmakeDefinition(
    JSON.parse(JSON.stringify({ ...def, continuationHeaderSpec: undefined })) as RenderableDefinition);
  let probedPages = 0;
  probe.header = (_current: number, total: number): Content | null => {
    probedPages = total;
    return null; // draws nothing — the probe's bytes stay content-identical to a header-less render
  };
  const bytes = await renderBytes(probe);
  if (probedPages <= 1) return bytes;

  const [left, top, right, bottom] = normalizeMargins(def.pageMargins);
  full.pageMargins = [left, Math.max(top, reserve), right, bottom];
  return renderBytes(full);
}

/**
 * Renders each sheet-group definition as its OWN document and merges the results into one PDF
 * (spec §6.1). This is the whole mechanism behind per-group page numbers and continuation
 * headers: pdfmake's callbacks only ever see whole-document page counts, so "Page 1 of 2" on a
 * ticket meaning THAT ticket's pages requires each group to BE a document — each render's
 * `pageFooterSpec`/`continuationHeaderSpec` scopes to its group for free, restarting at every
 * group boundary.
 *
 * The merge is saved with `useObjectStreams: false`: object streams would deflate the page tree,
 * and the uncompressed `/Type /Pages /Count N` marker is what every house content assertion
 * (and the E2E flows) read off stored bytes. Groups render sequentially — a print is one request,
 * and #43's load bound caps the group count.
 */
export async function renderSheetGroups(defs: RenderableDefinition[]): Promise<Buffer> {
  if (defs.length === 0) {
    throw new Error("renderSheetGroups needs at least one sheet-group definition");
  }
  const merged = await PDFDocument.create();
  for (const def of defs) {
    const src = await PDFDocument.load(await renderPdf(def));
    for (const page of await merged.copyPages(src, src.getPageIndices())) {
      merged.addPage(page);
    }
  }
  return Buffer.from(await merged.save({ useObjectStreams: false }));
}

/**
 * A Code 128 barcode as a PNG, sized for the traveler's header block.
 *
 * The payload is the bare order number and nothing else (spec §10): scanning it into the Shell's
 * global search hits the exact-order-number short-circuit and opens the order. `includetext` is
 * off because the number is already printed above the barcode in the header.
 */
export async function barcodePng(text: string): Promise<Buffer> {
  return toBuffer({ bcid: "code128", text, scale: 3, height: 12, includetext: false });
}

/** `{ image }` content nodes take a data URI; the definition stays plain JSON either way. */
export function pngDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** The JPEG sibling (spec §6.3) — template logos are PNG or JPEG, sniffed at upload; the stored
 *  mime type picks which helper embeds them. */
export function jpegDataUri(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

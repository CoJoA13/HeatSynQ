/**
 * The pdfmake + bwip-js plumbing, and the only file in the app that knows either library exists
 * (design spec §10). Everything above it deals in plain JSON document definitions — the
 * template-as-data contract Phase 7's designer will edit — so swapping the renderer never
 * reaches past this module.
 */
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import PdfPrinter from "pdfmake/src/printer.js";
import vfs from "pdfmake/build/vfs_fonts.js";
import { toBuffer } from "bwip-js/node";

/**
 * pdfmake's own bundled Roboto, decoded out of its virtual file system into buffers.
 *
 * The browser build's `pdfMake.createPdf(def).getBuffer(...)` was tried first (task brief) and is
 * the wrong tool under Node: it wants a global `window`, and its vfs plumbing exists to fetch
 * fonts the browser cannot read off disk. `PdfPrinter` is pdfmake's documented server entry
 * point. It normally takes .ttf FILE PATHS — deliberately not used here, because a path would
 * have to survive `output: "standalone"`'s file tracing into the Docker image; buffers decoded
 * from a module the bundler already follows cannot go missing.
 *
 * Built once at module load (~1 MB of font data, four base64 decodes) rather than per render:
 * the printer is stateless across `createPdfKitDocument` calls, and a traveler for a 14-load
 * order is one call, not fourteen.
 */
const FONTS = {
  Roboto: {
    normal: Buffer.from(vfs["Roboto-Regular.ttf"], "base64"),
    bold: Buffer.from(vfs["Roboto-Medium.ttf"], "base64"),
    italics: Buffer.from(vfs["Roboto-Italic.ttf"], "base64"),
    bolditalics: Buffer.from(vfs["Roboto-MediumItalic.ttf"], "base64"),
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
 *  exactly, Task 14's conversion). */
export type PageFooterSpec = { kind: "pageNofM"; label?: string };

/** Static JSON content (text/images — never functions) repeated by a renderer-side header
 *  callback on every page AFTER the first of the definition. */
export type ContinuationHeaderSpec = { content: Content };

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
    // The quote's exact footer styling (pdf/quote.ts) — its Task 14 conversion must be invisible.
    out.footer = (currentPage: number, totalPages: number): Content => ({
      text: `${label} ${currentPage} of ${totalPages}`,
      bold: true, fontSize: 8.5, alignment: "right", margin: [24, 8, 24, 0],
    });
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

/** Renders a document definition to PDF bytes. */
export async function renderPdf(def: RenderableDefinition): Promise<Buffer> {
  assertFontsRegistered(def);
  const doc = printer.createPdfKitDocument(toPdfmakeDefinition(def), { tableLayouts: TABLE_LAYOUTS });
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

/**
 * The pdfmake + bwip-js plumbing, and the only file in the app that knows either library exists
 * (design spec §10). Everything above it deals in plain JSON document definitions — the
 * template-as-data contract Phase 7's designer will edit — so swapping the renderer never
 * reaches past this module.
 */
import type { TDocumentDefinitions } from "pdfmake/interfaces";
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

/** Renders a document definition to PDF bytes. */
export async function renderPdf(def: TDocumentDefinitions): Promise<Buffer> {
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

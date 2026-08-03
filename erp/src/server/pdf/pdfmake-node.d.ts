/**
 * pdfmake ships no types of its own, and `@types/pdfmake` types only the BROWSER build — its
 * `index.d.ts` describes `createPdf()`, which does not exist on the Node entry point. The Node
 * entry (`package.json` `"main": "src/printer.js"`) exports the `PdfPrinter` constructor
 * instead, which is what `render.ts` uses and what the %PDF smoke test in tests/traveler.test.ts
 * actually exercises. Declared here, minimally, for exactly the members we call.
 *
 * The font sources are typed `Buffer` on purpose: pdfmake's documented Node usage passes .ttf
 * FILE PATHS, but this app has no font files to ship — it decodes pdfmake's own bundled Roboto
 * out of `build/vfs_fonts.js` (base64) and hands over the buffers, so nothing has to survive the
 * standalone build's file tracing.
 */
declare module "pdfmake/src/printer.js" {
  import type { TDocumentDefinitions } from "pdfmake/interfaces";
  import type { Readable } from "node:stream";

  /** pdfkit's document — a readable stream that must be `end()`ed before it finishes emitting. */
  interface PdfKitDocument extends Readable {
    end(): void;
  }

  class PdfPrinter {
    constructor(fontDescriptors: Record<string, { normal: Buffer; bold: Buffer; italics: Buffer; bolditalics: Buffer }>);
    createPdfKitDocument(
      docDefinition: TDocumentDefinitions,
      /** `tableLayouts` registers custom layouts by name — see render.ts's LAYOUT. */
      options?: { tableLayouts?: Record<string, unknown> },
    ): PdfKitDocument;
  }

  export = PdfPrinter;
}

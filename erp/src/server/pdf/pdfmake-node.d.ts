/**
 * pdfmake ships no types of its own, and `@types/pdfmake` types only the BROWSER build — its
 * `index.d.ts` describes `createPdf()`, which does not exist on the low-level Node entry point.
 *
 * pdfmake 0.3 RELOCATED that entry: 0.2's `pdfmake/src/printer.js` (a CommonJS `module.exports =
 * PdfPrinter`) is gone; the constructor now lives at `pdfmake/js/Printer.js` as an ES-style
 * `export default`, and — the breaking change `render.ts` has to absorb — `createPdfKitDocument`
 * is now ASYNC. The constructor also grew two parameters: a virtual filesystem and a URL resolver,
 * because 0.3 resolves a font DESCRIPTOR (a filename string) to its bytes through the vfs rather
 * than accepting raw `Buffer`s. See `render.ts` for how the app supplies both. Declared here,
 * minimally, for exactly the members we call.
 */
declare module "pdfmake/js/Printer.js" {
  import type { TDocumentDefinitions } from "pdfmake/interfaces";
  import type { Readable } from "node:stream";

  /** pdfkit's document — a readable stream that must be `end()`ed before it finishes emitting. */
  interface PdfKitDocument extends Readable {
    end(): void;
  }

  /** A font family's four faces. In 0.3 each face is a virtual-filesystem FILENAME (a string),
   *  NOT a Buffer — the bytes live in the vfs and pdfmake reads them from there at render time. */
  interface FontFamily {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }

  /** The subset of pdfmake's VirtualFileSystem that the font path actually calls. `writeFileSync`
   *  is optional because only the (unused) URL-download path writes; the font reads never do. */
  interface VirtualFs {
    existsSync(filename: string): boolean;
    readFileSync(filename: string): Buffer;
    writeFileSync?(filename: string, content: Buffer): void;
  }

  /** The subset of pdfmake's URLResolver that `Printer.resolveUrls` calls: `resolve()` once per
   *  font descriptor and `resolved()` once, awaited. Font descriptors are vfs filenames (never
   *  URLs) here, so both are no-ops — but the object is dereferenced unconditionally, so it must
   *  exist. */
  interface UrlResolver {
    resolve(url: string, headers?: Record<string, string>): void | Promise<void>;
    resolved(): Promise<unknown>;
  }

  export default class PdfPrinter {
    constructor(
      fontDescriptors: Record<string, FontFamily>,
      virtualfs?: VirtualFs,
      urlResolver?: UrlResolver,
      localAccessPolicy?: (path: string) => boolean,
    );
    /** 0.3 made this ASYNC — it resolves to the pdfkit document (which must still be `end()`ed). */
    createPdfKitDocument(
      docDefinition: TDocumentDefinitions,
      /** `tableLayouts` registers custom layouts by name — see render.ts's LAYOUT. */
      options?: { tableLayouts?: Record<string, unknown> },
    ): Promise<PdfKitDocument>;
  }
}

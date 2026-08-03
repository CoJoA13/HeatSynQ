/**
 * The traveler — the paper that rides with the work (design spec §10).
 *
 * Three layers, deliberately separated:
 *
 *   collectTravelerData()      reads (order + LOCKED revision + lead part + settings + barcode)
 *   buildTravelerDefinition()  PURE: TravelerData in, a plain-JSON pdfmake definition out
 *   renderPdf()                bytes (src/server/pdf/render.ts — the only pdfmake-aware file)
 *
 * The middle layer is the point. Spec §10 makes the traveler template *data, not code*: the
 * definition this file returns is the built-in default template, and it is the substrate Phase
 * 7's template designer will edit and version. So `buildTravelerDefinition` performs no I/O,
 * reads no clock, and returns nothing that would not survive `JSON.parse(JSON.stringify(...))`
 * — asserted in tests/traveler.test.ts, not merely intended.
 *
 * Layout mirrors the owner's `docs/samples/2025-aht-orderform-mockup.pdf`, which the owner ruled
 * on 2026-08-03 to BE the build target (spec §3.9 amendment). Deviations from it are individually
 * commented below; there are no silent ones.
 */
import type { Content, TDocumentDefinitions, TableCell } from "pdfmake/interfaces";
import { Prisma, type DocumentKind } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate } from "./audit";
import { getOrder } from "./orders";
import { getRevision } from "./part-process-steps";
import { listPartInspections } from "./part-inspections";
import { listAddresses } from "./customer-addresses";
import { getSetting } from "./settings";
import { renderPdf, barcodePng, pngDataUri, LAYOUT } from "./pdf/render";

// ---------------------------------------------------------------------------------------------
// TravelerData — the builder's whole input. Plain data by construction: no Decimals, no Dates,
// no Prisma rows, nothing that needs a database to interpret.
// ---------------------------------------------------------------------------------------------

export type TravelerLine = {
  qty: number; partNumber: string; partName: string; description: string;
  eachWeight: number | null; lineWeight: number;
};
export type TravelerContainer = {
  typeName: string; count: number; qty: number | null;
  tareWeight: number | null; grossWeight: number | null;
};
export type TravelerInspection = {
  code: string; scale: string | null; min: number | null; max: number | null;
  sampleQty: string; location: string;
};
export type TravelerStepValue = { label: string; value: string; unit: string | null };
export type TravelerStep = {
  position: number; codeName: string; instruction: string; values: TravelerStepValue[];
};
/** One printed sheet-set: the mockup's header carries a load number, and the load's own numbers
 *  replace the order-wide ones in the quantity row. */
export type TravelerSheet = { loadNumber: number | null; loadQty: number | null; loadWeight: number | null };

export type TravelerData = {
  orderNumber: number;
  // No PO number: the mockup carries none, and the mockup IS the build target (spec §3.9a). The
  // PO lives on the order hub; adding a field to controlled shop paper is not this task's call.
  customerName: string;
  /** Received-from address lines, already assembled; empty when the customer has none. */
  receivedFrom: string[];
  company: { name: string; address: string; phone: string };
  /** `data:image/png;base64,…` — Code 128 over the bare order number (spec §10). */
  barcodeDataUri: string;
  lines: TravelerLine[];
  orderQty: number;
  orderWeight: number;
  containers: TravelerContainer[];
  materialName: string;
  /** The lead part number: the shop's process identity for this order (spec §3.1/§10). */
  processId: string;
  inspections: TravelerInspection[];
  /** The LOCKED revision — historical, never the part's current working revision. Governs
   *  `steps`; deliberately NOT printed (owner ruling 2026-08-03, see `processRow`), and kept on
   *  the payload because it is what makes `steps` interpretable to any future template. */
  revisionNumber: number | null;
  steps: TravelerStep[];
  sheets: TravelerSheet[];
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, and shared by every cell so one number never renders two ways.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated, at most 2 decimals, trailing zeros dropped — the mockup's own style
 *  ("4,500", "33,750", "13.5"). Locale pinned so the output never tracks the server's. */
function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** `Label: value unit`, the mockup's step-value line ("Furnace Temp: 1650 °F"). */
function valueLine(v: TravelerStepValue): string {
  return `${v.label}: ${v.value}${v.unit ? ` ${v.unit}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// buildTravelerDefinition — PURE.
// ---------------------------------------------------------------------------------------------

// Table layouts are referenced BY NAME (src/server/pdf/render.ts registers the drawing code).
// An inline layout object would put callbacks in the definition, and a definition carrying
// functions is not data — see render.ts's LAYOUT comment and the purity test.

const head = (text: string, colSpan?: number): TableCell =>
  ({ text, bold: true, alignment: "center", ...(colSpan ? { colSpan } : {}) });
const cell = (text: string): TableCell => ({ text, alignment: "center" });
/** A drawn square rather than "☐": a glyph would depend on the font actually carrying U+2610. */
const checkbox = (): TableCell => ({
  canvas: [{ type: "rect", x: 0, y: 0, w: 10, h: 10, lineWidth: 0.8 }], margin: [14, 2, 0, 0],
});

function headerBlock(d: TravelerData, sheet: TravelerSheet): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: d.customerName, bold: true, fontSize: 9.5 },
          ...d.receivedFrom.map((line) => ({ text: line })),
        ],
      },
      {
        width: "*",
        alignment: "center",
        stack: [
          // No logo: the owner supplied none with the samples, and Phase 7 owns logo upload
          // (spec §10). The company settings block stands in for it, centered where it sits on
          // the mockup.
          { text: d.company.name, bold: true, fontSize: 12 },
          { text: d.company.address },
          { text: d.company.phone },
        ],
      },
      {
        width: 190,
        stack: [
          {
            columns: [
              { width: "*", text: "Order Number", bold: true, alignment: "center" },
              { width: 44, text: "Load", bold: true, alignment: "center" },
            ],
          },
          {
            columns: [
              { width: "*", text: String(d.orderNumber), alignment: "center" },
              { width: 44, text: sheet.loadNumber === null ? "—" : String(sheet.loadNumber), alignment: "center" },
            ],
          },
          { image: d.barcodeDataUri, width: 186, height: 44, margin: [0, 4, 0, 0] },
        ],
      },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 8],
  };
}

function linesTable(d: TravelerData): Content {
  return {
    table: {
      headerRows: 1,
      widths: [78, "*", 78, 88],
      body: [
        [head("Part Quantity"), head("Part Number / Part Name / Description"), head("Part Weight"), head("Line Weight")],
        ...d.lines.map((l): TableCell[] => [
          cell(num(l.qty)),
          // One cell, slash-joined, exactly as the mockup prints it.
          cell([l.partNumber, l.partName, l.description].filter((p) => p !== "").join(" / ")),
          cell(num(l.eachWeight)),
          cell(num(l.lineWeight)),
        ]),
      ],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Order Quantity · Load Quantity · Containers.
 *
 * `Container Quantity` is the number of CONTAINERS (`OrderContainer.count`) — the mockup's own
 * meaning: 8 drop pans + 12 bins against a 4,500-piece order, which is neither a per-container
 * nor a total piece count. `OrderContainer.qty` (pieces per container) has no column of its own
 * on the mockup, so it rides as a second line inside the Container cell rather than being
 * dropped; it is real data the shop keys and the floor uses.
 *
 * Gross weight is a single figure for the whole set, as on the mockup. It is the SUM of the
 * containers' stored gross weights when every container carries one, and otherwise the mockup's
 * own arithmetic — order weight + total tare (60,750 + 6,764 = 67,514 there). Summing partial
 * data would silently under-report, which on a shipping document is worse than deriving.
 */
function quantityTable(d: TravelerData, sheet: TravelerSheet): Content {
  const rows = d.containers.length > 0 ? d.containers : [null];
  const tareTotal = d.containers.reduce((sum, c) => sum + (c.tareWeight ?? 0), 0);
  const grossTotal = d.containers.length > 0 && d.containers.every((c) => c.grossWeight !== null)
    ? d.containers.reduce((sum, c) => sum + (c.grossWeight ?? 0), 0)
    : d.orderWeight + tareTotal;

  const spanned = (text: string): TableCell => ({ text, alignment: "center", rowSpan: rows.length });

  return {
    table: {
      headerRows: 1,
      widths: [78, 78, "*", 88, 78, 88],
      body: [
        [
          head("Order Quantity"), head("Load Quantity"), head("Container"),
          head("Container Quantity"), head("Tare Weight"), head("Gross Weight"),
        ],
        ...rows.map((c, i): TableCell[] => [
          i === 0 ? spanned(num(d.orderQty)) : {},
          i === 0 ? {
            alignment: "center", rowSpan: rows.length,
            stack: [
              { text: sheet.loadQty === null ? "" : num(sheet.loadQty) },
              // The split is weight-capped as often as it is piece-capped (spec §5.4), so the
              // load's own weight rides under its piece count rather than being dropped — the
              // same treatment the Container cell gives pieces-per-container.
              ...(sheet.loadWeight === null
                ? [] : [{ text: `${num(sheet.loadWeight)} lb`, fontSize: 6.5, color: "#444444" }]),
            ],
          } : {},
          c === null ? cell("") : {
            alignment: "center",
            stack: [
              { text: c.typeName },
              ...(c.qty === null ? [] : [{ text: `${num(c.qty)} per container`, fontSize: 6.5, color: "#444444" }]),
            ],
          },
          cell(c === null ? "" : num(c.count)),
          cell(c === null ? "" : num(c.tareWeight)),
          i === 0 ? spanned(d.containers.length === 0 ? "" : num(grossTotal)) : {},
        ]),
      ],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Process / Material / Process ID.
 *
 * **Process renders BLANK in Phase 3 — owner ruling, 2026-08-03 (spec §3.9 amendment).** The
 * mockup prints a process NAME there ("Austemper") and this data model has no such field. The
 * candidates were all wrong in different ways: the lead part's `name` is a PART name ("U Bolt
 * Rear Spr Plate"), already in the lines table above and actively misleading under a "Process:"
 * label; a name assembled from step codes would be invented; and the locked revision ("Rev 3"),
 * which this first shipped, answers a different question than the label asks. The owner's call:
 * the slot stays empty and Phase 7's template designer owns it. Material and Process ID are
 * unaffected. The locked revision is still carried on TravelerData (and governs `steps`) — it is
 * simply not printed here.
 */
function processRow(d: TravelerData): Content {
  return {
    table: {
      widths: [50, "*", 50, "*", 56, "*"],
      body: [[
        { text: "Process:", bold: true, alignment: "center" }, cell(""),
        { text: "Material:", bold: true, alignment: "center" }, cell(d.materialName),
        { text: "Process ID:", bold: true, alignment: "center" }, cell(d.processId),
      ]],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Key Characteristic Inspection(s).
 *
 * Two deviations from the mockup, both forced:
 *  - the first column's header reads "Inspection", not "Hardness". On the mockup that header
 *    cell holds a DATA value (the first inspection's code name), which cannot generalise to an
 *    arbitrary set of inspection codes.
 *  - the mockup's `{Inspection Location.bmp}` slot renders nothing. Owner ruling 2026-08-03
 *    (spec §3.9c): no inspection-location images in Phase 3 — Phase 4/7 owns image handling.
 *    `PartInspection.location`'s TEXT still prints, in the last column.
 */
function inspectionsBlock(d: TravelerData): Content {
  const body: TableCell[][] = [
    [head("Inspection"), head("Scale"), head("Min"), head("Max"), head("Quantity"), head("Location")],
    ...d.inspections.map((i): TableCell[] => [
      { text: i.code, bold: true },
      cell(i.scale ?? ""), cell(num(i.min)), cell(num(i.max)), cell(i.sampleQty), cell(i.location),
    ]),
  ];
  if (d.inspections.length === 0) body.push([cell(""), cell(""), cell(""), cell(""), cell(""), cell("")]);

  return {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          { text: "Key Characteristic Inspection(s):", bold: true, alignment: "center", margin: [0, 0, 0, 3] },
          { table: { widths: ["*", 55, 48, 48, 72, "*"], body }, layout: "noBorders" },
        ],
      }]],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 6],
  };
}

/** PROCESS STEPS — position, code name, instruction + typed values (def order, units included),
 *  and the EQ# / OP / Date handwriting boxes the floor fills in by hand (there is no shop-floor
 *  tracking, by decision — spec §10). */
function stepsTable(d: TravelerData): Content {
  const stepRow = (s: TravelerStep): TableCell[] => [
    { text: String(s.position), bold: true },
    { text: s.codeName, bold: true },
    {
      stack: [
        ...(s.instruction === "" ? [] : [{ text: s.instruction }]),
        ...s.values.map((v) => ({ text: valueLine(v) })),
      ],
    },
    { text: "" }, { text: "" }, { text: "" },
  ];
  const blank: TableCell[] = [
    { text: "" }, { text: "" }, { text: "The locked revision carries no steps.", italics: true },
    { text: "" }, { text: "" }, { text: "" },
  ];

  return {
    table: {
      headerRows: 1,
      widths: [16, 62, "*", 34, 30, 46],
      body: [
        [
          { text: "PROCESS STEPS:", bold: true, alignment: "center", colSpan: 3 }, {}, {},
          head("EQ#"), head("OP"), head("Date"),
        ],
        ...(d.steps.length > 0 ? d.steps.map(stepRow) : [blank]),
      ],
    },
    layout: LAYOUT.steps,
    margin: [0, 0, 0, 6],
  };
}

/** RESULTS / TEMPERED RESULTS / FINAL INSPECTION PASS-FAIL / Tested By / OK to Ship. All
 *  handwriting areas — the traveler comes back marked up. */
function footerBlocks(): Content {
  const label = (text: string): TableCell => ({ text, bold: true, colSpan: 2 });
  return {
    columns: [
      {
        width: "*",
        table: {
          widths: ["*"],
          // Hand-tuned so the RESULTS box ends level with the right column's last row. pdfmake
          // gives no way to say "match my sibling's height", and a mismatch is the one thing that
          // makes this footer look wrong on paper. Re-measure if the right column gains a row.
          heights: ["auto", 151],
          body: [[head("RESULTS:")], [{ text: "" }]],
        },
        layout: LAYOUT.boxed,
      },
      {
        width: "*",
        table: {
          widths: ["*", 34, "*", 34],
          heights: ["auto", 92, "auto", "auto", "auto", "auto"],
          body: [
            [head("TEMPERED RESULTS:", 4), {}, {}, {}],
            [{ text: "", colSpan: 4 }, {}, {}, {}],
            [head("FINAL INSPECTION:", 4), {}, {}, {}],
            [head("PASS"), checkbox(), head("FAIL"), checkbox()],
            [label("Tested By:"), {}, label("Date:"), {}],
            [label("OK to Ship:"), {}, label("Date:"), {}],
          ],
        },
        layout: LAYOUT.boxed,
      },
    ],
    columnGap: 0,
  };
}

/**
 * The built-in default traveler template (spec §10). PURE — data in, JSON out.
 *
 * One sheet-set per load, all in ONE document: printing an order prints every load's paperwork
 * as a single PDF, and printing load N prints just that one (`sheets` is already filtered by
 * `collectTravelerData`).
 */
export function buildTravelerDefinition(input: TravelerData): TDocumentDefinitions {
  const content: Content[] = [];
  for (const [index, sheet] of input.sheets.entries()) {
    content.push({
      // Page break BEFORE every sheet but the first — never a trailing blank page.
      ...(index === 0 ? {} : { pageBreak: "before" as const }),
      stack: [
        headerBlock(input, sheet),
        linesTable(input),
        quantityTable(input, sheet),
        processRow(input),
        inspectionsBlock(input),
        stepsTable(input),
        footerBlocks(),
      ],
    });
  }
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: "Roboto", fontSize: 8 },
    // No `info.creationDate`, no header/footer clock: a definition that embedded "now" would make
    // two prints of the same order differ for no reason, and would break this builder's purity.
    content,
  };
}

// ---------------------------------------------------------------------------------------------
// collectTravelerData — the reads.
// ---------------------------------------------------------------------------------------------

const VOIDED = "Cannot print a traveler for a voided order";

/**
 * Assembles a print payload for one order (every load) or one load of it.
 *
 * Reads the LOCKED revision via `getRevision(leadPartId, lockedRevisionNumber)` — never the
 * part's current working revision. That is the whole point of locking at save (spec §5.3): a
 * traveler reprinted after the recipe changed must still say what the shop actually ran.
 *
 * Line parts are read here in ONE query rather than through `getPart` per line: the traveler
 * needs the same three fields (description, each-weight, material) for every line, and `getPart`
 * both fires a second per-part revision query and 404s a part an order may legitimately still
 * reference. Inspections still come from the parts service (`listPartInspections`).
 */
export async function collectTravelerData(orderId: string, loadNumber?: number): Promise<TravelerData> {
  const order = await getOrder(orderId); // 404s a missing order
  const lead = order.lines[0];
  if (!lead) throw new HttpError(400, "This order has no part lines to print");

  const [barcode, parts, customer, addresses, inspectionRows, revision,
    companyName, companyAddress, companyPhone] =
    await Promise.all([
      barcodePng(String(order.orderNumber)),
      prisma.part.findMany({
        // Deliberately unfiltered on deletedAt: the order references these parts and the paper
        // has to name them, whatever has happened to the catalog since.
        where: { id: { in: order.lines.map((l) => l.partId) } },
        select: { id: true, partNumber: true, name: true, description: true, eachWeight: true,
          material: { select: { name: true } } },
      }),
      prisma.customer.findFirst({ where: { id: order.customerId }, select: { name: true } }),
      listAddresses(order.customerId),
      listPartInspections(lead.partId),
      lead.revisionNumber === null ? null : getRevision(lead.partId, lead.revisionNumber),
      getSetting("company_name"),
      getSetting("company_address"),
      getSetting("company_phone"),
    ]);

  const partById = new Map(parts.map((p) => [p.id, p]));
  const leadPart = partById.get(lead.partId);

  // The default received-from address, else the first one on file. Street and city/state/zip
  // only — the mockup's Ph/Fx lines have no `CustomerAddress` columns behind them (phone lives
  // on CustomerContact, which is a person, not a site), so they are not printed.
  const receivedFromRows = addresses.filter((a) => a.kind === "RECEIVED_FROM");
  const site = receivedFromRows.find((a) => a.isDefault) ?? receivedFromRows[0] ?? null;
  const cityLine = site ? [site.city, [site.state, site.zip].filter(Boolean).join(" ")]
    .filter((p) => p !== "").join(", ") : "";
  const receivedFrom = site ? [site.street, cityLine].filter((line) => line !== "") : [];

  const allSheets: TravelerSheet[] = order.loads.map((l) => (
    { loadNumber: l.loadNumber, loadQty: l.qty, loadWeight: l.weight }));
  let sheets = allSheets;
  if (loadNumber !== undefined) {
    sheets = allSheets.filter((s) => s.loadNumber === loadNumber);
    if (sheets.length === 0) throw new HttpError(404, `This order has no load ${loadNumber}`);
  }
  // An order with no loads at all still prints one sheet — the paper is what the shop works
  // from, and refusing to print it would be a worse answer than a blank Load box.
  if (sheets.length === 0) sheets = [{ loadNumber: null, loadQty: null, loadWeight: null }];

  return {
    orderNumber: order.orderNumber,
    customerName: customer?.name ?? "",
    receivedFrom,
    company: { name: companyName, address: companyAddress, phone: companyPhone },
    barcodeDataUri: pngDataUri(barcode),
    lines: order.lines.map((l) => {
      const part = partById.get(l.partId);
      return {
        qty: l.qty,
        partNumber: part?.partNumber ?? l.part.partNumber,
        partName: part?.name ?? l.part.name,
        description: part?.description ?? "",
        eachWeight: part ? part.eachWeight.toNumber() : null,
        lineWeight: l.weight,
      };
    }),
    orderQty: order.lines.reduce((sum, l) => sum + l.qty, 0),
    orderWeight: order.lines.reduce((sum, l) => sum + l.weight, 0),
    containers: order.containers.map((c) => ({
      typeName: c.type.name, count: c.count, qty: c.qty,
      tareWeight: c.tareWeight, grossWeight: c.grossWeight,
    })),
    materialName: leadPart?.material?.name ?? "",
    processId: leadPart?.partNumber ?? lead.part.partNumber,
    inspections: inspectionRows.map((i) => ({
      code: i.inspectionCodeName, scale: i.scaleName, min: i.min, max: i.max,
      sampleQty: i.sampleQty, location: i.location,
    })),
    revisionNumber: revision?.revisionNumber ?? null,
    steps: (revision?.steps ?? []).map((s) => ({
      position: s.position, codeName: s.codeName, instruction: s.instruction,
      values: s.values.map((v) => ({ label: v.label, value: v.value, unit: v.unit })),
    })),
    sheets,
  };
}

// ---------------------------------------------------------------------------------------------
// Stored documents. Permanent, create-only (spec §4) — there is no delete path at all.
// ---------------------------------------------------------------------------------------------

export type DocumentMeta = {
  id: string; orderId: string; orderNumber: number; kind: DocumentKind;
  loadNumber: number | null; createdAt: Date;
};

/** The one projection both reads share — everything except the bytes, plus the order number the
 *  filename needs. */
const DOCUMENT_SELECT = {
  id: true, orderId: true, kind: true, loadNumber: true, createdAt: true,
  order: { select: { orderNumber: true } },
} satisfies Prisma.StoredDocumentSelect;

type DocumentSelected = Prisma.StoredDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;
const toMeta = ({ order, ...rest }: DocumentSelected): DocumentMeta =>
  ({ ...rest, orderNumber: order.orderNumber });

/**
 * Renders and archives one traveler, returning the exact bytes stored.
 *
 * Voided orders refuse a NEW print (spec §5c) but keep every earlier print listable and
 * reprintable — `listDocuments`/`getDocument` below deliberately do not filter on `deletedAt`.
 *
 * The render happens OUTSIDE the transaction: it is ~100 ms of pure CPU with nothing to roll
 * back, and holding a write transaction open across it for a 14-load order would be a
 * self-inflicted lock. The void check therefore runs twice — once up front so a refusal costs
 * nothing, and once inside the transaction, which is the one that actually decides, closing the
 * window where an order is voided mid-render.
 */
export async function printTraveler(
  orderId: string, loadNumber?: number,
): Promise<{ documentId: string; orderNumber: number; loadNumber: number | null; pdf: Buffer }> {
  const pre = await prisma.order.findFirst({ where: { id: orderId }, select: { deletedAt: true } });
  if (!pre) throw new HttpError(404, "Order not found");
  if (pre.deletedAt !== null) throw new HttpError(400, VOIDED);

  const data = await collectTravelerData(orderId, loadNumber);
  const pdf = await renderPdf(buildTravelerDefinition(data));

  const row = await withDbErrors({ entity: "Order" }, () =>
    prisma.$transaction(async (tx) => {
      const live = await tx.order.findFirst({ where: { id: orderId }, select: { deletedAt: true } });
      if (!live) throw new HttpError(404, "Order not found");
      if (live.deletedAt !== null) throw new HttpError(400, VOIDED);

      const meta = {
        orderId, kind: "TRAVELER" as const, loadNumber: loadNumber ?? null,
      };
      // Metadata only in the audit payload — the bytes are never handed to the audit layer
      // (CLAUDE.md: redact() is defense in depth, not the mechanism keeping them out). The
      // attachments service does exactly this for the same reason.
      return auditedCreate("storedDocument", meta,
        // `new Uint8Array(pdf)`, not the Buffer itself: Prisma's `Bytes` input is typed
        // `Uint8Array<ArrayBuffer>`, and Node's Buffer is `Uint8Array<ArrayBufferLike>`, which
        // that does not accept.
        () => tx.storedDocument.create({ data: { ...meta, fileData: new Uint8Array(pdf) } }), { tx });
    }));

  // `orderNumber`/`loadNumber` ride along purely so the route can name the download without a
  // second read — `getDocument` would pull the whole PDF back out of the database to learn them.
  return { documentId: row.id, orderNumber: data.orderNumber, loadNumber: loadNumber ?? null, pdf };
}

/** Newest first. Never selects `fileData` — a list of N prints has no reason to pull N PDFs into
 *  memory to render a timestamp. `createdAt` ties break on the id, which is a time-ordered cuid,
 *  so two prints inside the same millisecond still list in the order they happened. */
export async function listDocuments(orderId: string): Promise<DocumentMeta[]> {
  const order = await prisma.order.findFirst({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new HttpError(404, "Order not found");
  const rows = await prisma.storedDocument.findMany({
    where: { orderId },
    select: DOCUMENT_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map(toMeta);
}

/** The stored bytes, untouched — a reprint is a byte-for-byte reissue of what was printed, never
 *  a re-render (spec §5b: loads stay editable after a print, so a re-render could differ). */
export async function getDocument(docId: string): Promise<DocumentMeta & { fileData: Buffer }> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: docId }, select: { ...DOCUMENT_SELECT, fileData: true },
  });
  if (!row) throw new HttpError(404, "Document not found");
  const { fileData, ...meta } = row;
  // Prisma's `Bytes` scalar is a bare Uint8Array; Buffer.from guarantees the real Node Buffer
  // this signature promises (the attachments service precedent).
  return { ...toMeta(meta), fileData: Buffer.from(fileData) };
}

/** `traveler-71246.pdf` / `traveler-71246-load-3.pdf` — what the browser tab and any save-as
 *  dialog show. Shared by the print route and the stored-bytes route so one document never
 *  arrives under two names. */
export function travelerFilename(orderNumber: number, loadNumber: number | null): string {
  return loadNumber === null
    ? `traveler-${orderNumber}.pdf`
    : `traveler-${orderNumber}-load-${loadNumber}.pdf`;
}

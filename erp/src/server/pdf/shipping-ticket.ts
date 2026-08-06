/**
 * The shipping ticket — one sheet per order of a shipment (design spec §10.1, owner ruling §3.20:
 * "five orders on a truck print five shipping tickets and one BOL"; there is NO multi-order ticket
 * layout). PURE by construction, the traveler.ts contract: `TicketData[]` in, a plain-JSON pdfmake
 * definition out — no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`
 * (asserted in tests/shipping-ticket.test.ts). This definition is the built-in default template
 * Phase 7's designer will edit and version; the reads live in shippers.ts
 * (`readShippingTicketData`), the bytes in render.ts.
 *
 * Layout mirrors the owner's `docs/samples/Shipping Ticket Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - no logo top-right — the owner supplied none and Phase 7 owns logo upload (the traveler's own
 *    ruling, spec §10); the company address/phone block stands in where the sample's logo sits.
 *  - no "Page 1 of 1" between the address blocks — a page count is not knowable to a pure JSON
 *    definition (pdfmake only exposes it to header/footer CALLBACKS, which a template-as-data
 *    definition cannot carry), and printing a hard-coded "1 of 1" would lie the moment a long
 *    ticket wraps.
 *  - the sample's stray "Temper Only" annotation has no field behind it in this model and spec
 *    §10.1 does not list it — not printed (do not invent fields, task brief Step 1).
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";

// ---------------------------------------------------------------------------------------------
// TicketData — the builder's whole input (task-18-brief.md's exact shape). Plain data: no
// Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type TicketCompany = { name: string; address: string; phone: string; liabilityText: string };
export type TicketParty = { code: string; name: string; street: string; city: string; state: string; zip: string };
export type TicketLine = { qty: number; partNumber: string; partName: string; partDescription: string; pounds: number };
export type TicketContainer = { typeName: string; count: number; customerContainerId: string };
export type TicketData = {
  company: TicketCompany;
  soldTo: TicketParty;                 // the customer's default BILL_TO
  shipTo: TicketParty;                 // the shipment's ship-to address
  orderLabel: string;                  // "72036-3"
  orderNumber: number;
  shipDate: string;                    // "yyyy-mm-dd"
  poNumber: string;
  packingListNo: number;               // Shipper.shipperNumber
  customerJobNo: string;
  route: string;
  carrierName: string;
  lines: TicketLine[];
  containers: TicketContainer[];
  serials: { serial: string; description: string }[];   // only printOnShipper rows
  shippedComplete: boolean;
  totalQty: number;
  totalWeight: number;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, locale pinned (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated, at most 2 decimals, trailing zeros dropped — "4,128", "192". */
function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Always 2 decimals — the sample's own totals style ("192.00", "4,128.00"). */
function num2(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "2026-07-29" -> "7/29/2026", the sample header's own style. Pure string work — parsing to a
 *  Date would drag a timezone into a date-only value (src/lib/business-days.ts's whole point). */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

/** "2026-07-29" -> "07/29/2026" — the tear-off's zero-padded "Shipped ON" style, as printed. */
function paddedDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/** The packing list number zero-padded to six digits — the sample prints "072826", not "72826". */
function packingListNo(n: number): string {
  return String(n).padStart(6, "0");
}

const head = (text: string, colSpan?: number): TableCell =>
  ({ text, bold: true, alignment: "center", ...(colSpan ? { colSpan } : {}) });

/** LETTER (612pt) minus the 24pt margins — the width every full-bleed rule below draws to. */
const CONTENT_WIDTH = 564;

const rule = (margin: [number, number, number, number]): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1.5 }], margin });

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order.
// ---------------------------------------------------------------------------------------------

/** Company name + "Shipping Ticket" left; Order No. / Ship Date center; the company address block
 *  right, standing in for the sample's logo (see the header comment). */
function headerBlock(d: TicketData): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: d.company.name, bold: true, fontSize: 11 },
          { text: "Shipping Ticket", bold: true, fontSize: 16, margin: [0, 2, 0, 0] },
        ],
      },
      {
        width: 170,
        stack: [
          { text: `Order No.: ${d.orderLabel}`, bold: true, fontSize: 11 },
          { text: `Ship Date: ${shortDate(d.shipDate)}`, fontSize: 10, margin: [0, 4, 0, 0] },
        ],
      },
      {
        width: 130,
        alignment: "right",
        stack: [
          { text: d.company.address, fontSize: 7 },
          { text: d.company.phone, fontSize: 7 },
        ],
      },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 12],
  };
}

/** One boxed address block — "Sold To:"/"Ship To:" with the identifying code in the corner
 *  (spec §10.1: the customer code for Sold To; blank for Ship To, since a CustomerAddress has no
 *  short code in this system and a cuid is not paper). */
function partyBox(label: string, party: TicketParty): Content {
  return {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          {
            columns: [
              { width: "*", text: label, bold: true, fontSize: 13 },
              { width: 60, text: party.code, alignment: "right", fontSize: 9 },
            ],
          },
          { text: party.name, bold: true, fontSize: 9.5 },
          { text: party.street, margin: [0, 1, 0, 0] },
          {
            columns: [
              { width: "*", text: party.city },
              { width: 34, text: party.state },
              { width: 48, text: party.zip },
            ],
            margin: [0, 10, 0, 0],
          },
        ],
        margin: [2, 1, 2, 2],
      }]],
    },
    layout: LAYOUT.boxed,
  };
}

function partiesBlock(d: TicketData): Content {
  return {
    columns: [
      { width: "*", stack: [partyBox("Sold To:", d.soldTo)] },
      { width: 50, text: "" },
      { width: "*", stack: [partyBox("Ship To:", d.shipTo)] },
    ],
    columnGap: 0,
    margin: [0, 0, 0, 6],
  };
}

/** The five-cell field strip: PO / Packing List No / Customer Job No / Route / Carrier. */
function fieldStrip(d: TicketData): Content {
  return {
    table: {
      headerRows: 1,
      widths: ["*", "*", 110, 70, 85],
      body: [
        [head("Purchase Order Number"), head("Packing List No"), head("Customer Job No"), head("Route"), head("Carrier")],
        [
          { text: d.poNumber }, { text: packingListNo(d.packingListNo) },
          { text: d.customerJobNo }, { text: d.route }, { text: d.carrierName },
        ],
      ],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 6],
  };
}

/** Quantity | Part No. / Part Name / Part Description (stacked, the sample's three lines) |
 *  Pounds. Horizontal rules only — the sample's body rows are ruled, not gridded. */
function linesTable(d: TicketData): Content {
  return {
    table: {
      headerRows: 1,
      widths: [70, "*", 90],
      body: [
        [head("Quantity"), head("Part No.  /  Part Name  /  Part Description"), head("Pounds")],
        ...d.lines.map((l): TableCell[] => [
          { text: num(l.qty), alignment: "right" },
          { stack: [l.partNumber, l.partName, l.partDescription].filter((p) => p !== "").map((text) => ({ text })) },
          { text: num(l.pounds), alignment: "right" },
        ]),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 8],
  };
}

/** The container table's two side-by-side column groups (Container Type | # Of Containers |
 *  Cust Cont Id, twice) — the sample folds the container list into two columns. */
function containersTable(d: TicketData): Content {
  const half = Math.ceil(d.containers.length / 2);
  const left = d.containers.slice(0, half);
  const right = d.containers.slice(half);
  const rows = Math.max(left.length, 1);

  const group = (c: TicketContainer | undefined): TableCell[] => [
    { text: c?.typeName ?? "" },
    { text: c === undefined ? "" : num(c.count), alignment: "center" },
    { text: c?.customerContainerId ?? "" },
  ];

  return {
    table: {
      headerRows: 1,
      widths: [80, "*", 62, 80, "*", 62],
      body: [
        [
          head("Container Type"), head("# Of Containers"), head("Cust Cont Id"),
          head("Container Type"), head("# Of Containers"), head("Cust Cont Id"),
        ],
        ...Array.from({ length: rows }, (_, i): TableCell[] => [...group(left[i]), ...group(right[i])]),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 6],
  };
}

/** Serial numbers where `printOnShipper` (spec §10.1) — the sample order carried none, so this
 *  block's shape is this design's own: a labelled list, description (the heat/lot field) beside
 *  each serial. Renders nothing at all when no serial is flagged. */
function serialsBlock(d: TicketData): Content[] {
  if (d.serials.length === 0) return [];
  return [{
    stack: [
      { text: "Serial Numbers:", bold: true, margin: [0, 0, 0, 2] },
      ...d.serials.map((s) => ({ text: s.description === "" ? s.serial : `${s.serial} — ${s.description}` })),
    ],
    margin: [0, 0, 0, 6],
  }];
}

/** The standing liability text (`shipper_liability_text`, spec §3.21) in the sample's own fine
 *  print, one paragraph per blank-line-separated block, closed by the sample's heavy rule. */
function liabilityBlock(d: TicketData): Content {
  return {
    stack: [
      ...d.company.liabilityText.split(/\n\s*\n/).map((paragraph) => (
        { text: paragraph, fontSize: 5.5, margin: [0, 0, 0, 4] as [number, number, number, number] })),
      rule([0, 2, 0, 0]),
    ],
    margin: [0, 2, 0, 8],
  };
}

/** "Shipped Complete" (only when every line on this ticket is lineComplete), then the Quantity
 *  Shipped / Pounds Shipped pair, right of center as on the sample. */
function totalsBlock(d: TicketData): Content[] {
  return [
    ...(d.shippedComplete
      ? [{ text: "Shipped Complete", bold: true, fontSize: 12, alignment: "center" as const, margin: [0, 2, 0, 6] as [number, number, number, number] }]
      : []),
    {
      columns: [
        { width: "*", text: "" },
        {
          width: 260,
          table: {
            widths: ["*", 80],
            body: [
              [
                { text: "Quantity Shipped:", bold: true, fontSize: 12, alignment: "right" },
                { text: num(d.totalQty), fontSize: 11, alignment: "right" },
              ],
              [
                { text: "Pounds Shipped:", bold: true, fontSize: 12, alignment: "right" },
                { text: num2(d.totalWeight), fontSize: 11, alignment: "right" },
              ],
            ],
          },
          layout: "noBorders",
        },
      ],
    },
  ];
}

/**
 * The footer tear-off strip, pinned to the page bottom with `absolutePosition` (plain JSON —
 * the one instrument a data-only definition has for the sample's page-bottom placement; the
 * blank middle of the sample page is genuinely blank). Bare order number — the sample's
 * tear-off prints "72036", not "72036-3" — totals again in their boxed pair, the hand-completed
 * Received By / Date rules, then Sold To and Shipped ON.
 */
function tearOff(d: TicketData): Content {
  return {
    absolutePosition: { x: 24, y: 648 },
    stack: [
      rule([0, 0, 0, 6]),
      {
        columns: [
          { width: "*", text: `Order No.: ${d.orderNumber}`, bold: true, fontSize: 11 },
          {
            width: 150,
            text: d.shippedComplete ? "Shipped Complete" : "",
            bold: true, fontSize: 11, alignment: "center",
          },
          {
            width: 200,
            table: {
              widths: ["*", 62],
              body: [
                [
                  { text: "Quantity Shipped:", bold: true, fontSize: 10.5 },
                  { text: num2(d.totalQty), alignment: "right" },
                ],
                [
                  { text: "Pounds Shipped:", bold: true, fontSize: 10.5 },
                  { text: num2(d.totalWeight), alignment: "right" },
                ],
              ],
            },
            layout: LAYOUT.boxed,
          },
        ],
        columnGap: 8,
      },
      {
        columns: [
          { width: 220, text: "Received By: _______________________", bold: true, fontSize: 9.5 },
          { width: "*", text: "Date: _______________", bold: true, fontSize: 9.5 },
        ],
        margin: [0, 12, 0, 0],
      },
      {
        columns: [
          { width: "*", text: `Sold To: ${d.soldTo.name}`, bold: true, fontSize: 9.5 },
          { width: 180, text: `Shipped ON: ${paddedDate(d.shipDate)}`, bold: true, fontSize: 9.5, alignment: "right" },
        ],
        margin: [0, 10, 0, 0],
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default shipping-ticket template (spec §10.1). PURE — data in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * One sheet per `TicketData` — the traveler's per-load mechanic reused for orders (spec §3.20):
 * "print tickets" hands this every order on the shipment; "print this order's ticket" hands it
 * exactly one.
 */
export function buildShippingTicketDefinition(input: TicketData[]): TDocumentDefinitions {
  const content: Content[] = [];
  for (const [index, ticket] of input.entries()) {
    content.push({
      // Page break BEFORE every sheet but the first — never a trailing blank page (the traveler's
      // own rule).
      ...(index === 0 ? {} : { pageBreak: "before" as const }),
      stack: [
        headerBlock(ticket),
        partiesBlock(ticket),
        fieldStrip(ticket),
        linesTable(ticket),
        containersTable(ticket),
        ...serialsBlock(ticket),
        liabilityBlock(ticket),
        ...totalsBlock(ticket),
        tearOff(ticket),
      ],
    });
  }
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: "Roboto", fontSize: 8 },
    // No `info.creationDate`, no clock anywhere — two prints of the same shipment must not differ
    // for no reason (the traveler's purity rule).
    content,
  };
}

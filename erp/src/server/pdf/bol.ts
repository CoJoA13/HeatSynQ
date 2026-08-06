/**
 * The bill of lading — THE multi-order document (design spec §10.2, owner rulings §3.19/§3.20):
 * one per shipment, listing every order number on the truck, its own lazily-allocated
 * `bolNumber`, and the straight-bill-of-lading form completed by hand where the sample leaves
 * blanks. PURE by construction, the traveler.ts contract: `BolData` in, a plain-JSON pdfmake
 * definition out — no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`
 * (asserted in tests/bol.test.ts). The reads live in shippers.ts (`readBolData`), the bytes in
 * render.ts.
 *
 * Layout mirrors the owner's `docs/samples/Bill of Lading Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - the UDSBL boilerplate below is transcribed from the sample and lives IN this builder, not in
 *    a setting — spec §3.21 deliberately made exactly TWO standing blocks settings
 *    (`cert_statement`, `shipper_liability_text`); the BOL's legal form text is the form itself,
 *    and Phase 7's template designer is its editing path. Apparent typos in the sample's fine
 *    print ("here under", "(I) … (2)", "Comerce") are preserved as printed — the
 *    `SHIPPER_LIABILITY_DEFAULT` precedent (settings.ts): the source document wins, not the
 *    transcriber's spelling instinct. One exception, on the spec's own explicit wording: §10.2
 *    writes "Car or Vehicle Initials", so that spelling is used here.
 *  - `Delivering Carrier`, `Car or Vehicle Initials`, `Received $`, `Charges Advanced` and every
 *    signature line print as blank rules for hand completion, exactly as on the sample (§10.2).
 *  - everything is flow-laid; no `absolutePosition` anywhere (the Task 18 review's tear-off
 *    lesson — a pinned block collides with flow content on a long form).
 */
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT } from "./render";

// ---------------------------------------------------------------------------------------------
// BolData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type BolCompany = { name: string; address: string };
export type BolParty = { name: string; street: string; city: string; state: string; zip: string };
export type BolData = {
  company: BolCompany;
  bolNumber: number;                   // Shipper.bolNumber, allocated at first print (§3.19)
  proNumber: string;
  scacCode: string;
  carrierName: string;
  shipDate: string;                    // "yyyy-mm-dd"
  consignee: BolParty;                 // the shipment's ship-to address (§3's closing note)
  orderNumbers: number[];              // every order on the shipment, ticket print order (§3.20)
  poNumbers: string[];                 // the orders' POs — "Consignee's Ref/PO No."
  packageCount: number | null;
  freightDescription: string;
  totalWeight: number;                 // the shipment's total pounds
  freightClass: string;
  freightTerms: "PREPAID" | "COLLECT";
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, locale pinned (the traveler's own rule).
// ---------------------------------------------------------------------------------------------

/** Thousands-separated, at most 2 decimals, trailing zeros dropped — "11,415". */
function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-06" -> "Jul - 06 - 2026", the sample's own date style. Pure string work — parsing to
 *  a Date would drag a timezone into a date-only value (src/lib/business-days.ts's whole point). */
function bolDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} - ${d} - ${y}`;
}

/** LETTER (612pt) minus the 24pt margins. */
const CONTENT_WIDTH = 564;

const line = (width: number): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.8 }] });

const fullRule = (margin: [number, number, number, number], lineWidth = 1.2): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth }], margin });

/** A form field: bold label left, the value sitting on its own rule right. */
function labeledRule(label: string, value: string, labelWidth: number, valueWidth: number): Content {
  return {
    columns: [
      { width: labelWidth, text: label, bold: true, fontSize: 7.5 },
      { width: valueWidth, stack: [{ text: value === "" ? " " : value, fontSize: 8, alignment: "center" }, line(valueWidth)] },
    ],
    columnGap: 4,
    margin: [0, 0, 0, 3],
  };
}

// ---------------------------------------------------------------------------------------------
// The sample's standing form text, transcribed (see the header comment for the verbatim rule).
// ---------------------------------------------------------------------------------------------

const RECEIVED_TEXT =
  "RECEIVED, subject to individually determined rates of contracts that have been agreed upon in " +
  "writing between the carrier and shipper. If applicable, otherwise to the rates, classifications " +
  "and rules that have been established by the carrier and are available to the shipper, on request;";

const PROPERTY_TEXT =
  "the property described below, in apparent good order, except as noted (contents and condition " +
  "of contents of packages unknown), marked, consigned, and destined as indicated below, which " +
  "said carrier (the word carrier being understood throughout the contract as meaning any person " +
  "or corporation in possession of the property under the contract), agree to carry to its usual " +
  "place of delivery at said destination, if on its route, otherwise to deliver to another carrier " +
  "on the route to said destination. It is mutually agreed, as to each carrier of all or any of " +
  "said property over all or any portion of said route to destination, and as to each party at any " +
  "time interested in all or any said property, that every service to be performed here under " +
  "shall be subject to all the terms and conditions of the Uniform Domestic Straight Bill of " +
  "Lading set forth (I) in Official, Southern, Western and Illinois Freight Classification in " +
  "effect on the date hereof, if this is a rail or a rail-water shipment, or (2) in the applicable " +
  "motor carrier classification or tariff if this is a motor carrier shipment.";

const CERTIFIES_TEXT =
  "Shipper hereby certifies that he is familiar with all the terms and conditions of the said " +
  "bill of lading, set forth in the classification of tariff which governs the transportation of " +
  "this shipment, and the said terms and conditions are hereby agreed to by the shipper and " +
  "accepted for himself and his assigns.";

const SECTION_7_TEXT =
  "Subject to Section 7 of Conditions of applicable bill of lading, if this shipment is to be " +
  "delivered to the consignee without recourse on the consignor, the consignor shall sign the " +
  "following statement.";

const NO_DELIVERY_TEXT =
  "The carrier shall not make delivery of this shipment without payment of freight and all other " +
  "lawful charges.";

const IMPRINT_TEXT =
  "†Shipper's imprint in lieu of stamps, not a part of Bill of Lading approved by the Interstate " +
  "Comerce Commission.";

const WATER_NOTE =
  "* If the shipment moves between two ports by a carrier by water, the law requires that the " +
  "bill of lading state whether it is carrier's or shipper's weight.";

const VALUE_NOTE =
  "NOTE - Where the rate is dependent on value, shippers are required to state specifically in " +
  "writing the agreed or declared value of the property.";

const DECLARED_VALUE_TEXT =
  "The agreed or declared value of the property is hereby specifically stated by the shipper to " +
  "be not exceeding";

const LIABILITY_NOTE =
  "Liability Limitation for loss or damage on this shipment may be applicable. See 49 U.S.C. " +
  "§ 14706(c)(1)(A) and (B).";

const FIBRE_NOTE =
  "†The fibre boxes used for this shipment conform to the specifications set forth in the box " +
  "marker's certificate thereon, and all other requirements of the Consolidated Freight " +
  "Classification.";

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order.
// ---------------------------------------------------------------------------------------------

/** "Original - Not Negotiable" + the title left; the four labeled form rules right. */
function headerBlock(d: BolData): Content {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: "Original - Not Negotiable", bold: true, fontSize: 9 },
          { text: "STRAIGHT BILL OF LADING", bold: true, fontSize: 15, margin: [0, 4, 0, 0] },
        ],
      },
      {
        width: 250,
        stack: [
          labeledRule("Carrier's Pro No.", d.proNumber, 110, 130),
          labeledRule("Shipper's Bill of Lading No.", String(d.bolNumber), 110, 130),
          labeledRule("Consignee's Ref/PO No.", d.poNumbers.filter((p) => p !== "").join(", "), 110, 130),
          labeledRule("Carrier's Code (SCAC)", d.scacCode, 110, 130),
        ],
      },
    ],
    columnGap: 12,
    margin: [0, 0, 0, 4],
  };
}

/** The carrier's name over its rule, "(Name of Carrier)" beneath — blank rule when the shipment
 *  has no carrier (the sample's own hand-completed style; a customer-owned truck has none). */
function carrierBlock(d: BolData): Content {
  return {
    columns: [
      { width: 60, text: "" },
      {
        width: 260,
        stack: [
          { text: d.carrierName === "" ? " " : d.carrierName, bold: true, fontSize: 10, alignment: "center" },
          line(260),
          { text: "(Name of Carrier)", fontSize: 6.5, alignment: "center", margin: [0, 1, 0, 0] },
        ],
      },
      { width: "*", text: "" },
    ],
    margin: [0, 0, 0, 4],
  };
}

/** "at <ship-from> <date> From <company>" — ship-from is the company settings (spec §10.2). */
function shipFromLine(d: BolData): Content {
  return {
    columns: [
      { width: "*", text: `at ${d.company.address}`, fontSize: 8.5 },
      { width: 100, text: bolDate(d.shipDate), bold: true, fontSize: 8.5, alignment: "center" },
      { width: 30, text: "From", fontSize: 8.5 },
      { width: 180, text: d.company.name, fontSize: 8.5 },
    ],
    columnGap: 6,
    margin: [0, 2, 0, 2],
  };
}

/** Consigned to / Destination, from the ship-to address — how a third-party consignee like the
 *  sample's "Max Coating" is expressed (spec §10.2, §3's closing note). */
function consignedBlock(d: BolData): Content {
  return {
    stack: [
      {
        columns: [
          { width: 70, text: "Consigned to", bold: true, fontSize: 9 },
          { width: 180, stack: [{ text: d.consignee.name === "" ? " " : d.consignee.name, fontSize: 9 }, line(180)] },
          { width: "*", text: "(Mail or street address of consign - For purposes of notification only.)", fontSize: 5.5, margin: [8, 2, 0, 0] },
        ],
        columnGap: 4,
      },
      {
        columns: [
          { width: 70, text: "" },
          { width: 180, stack: [{ text: d.consignee.street === "" ? " " : d.consignee.street, fontSize: 9 }, line(180)] },
          { width: "*", text: "" },
        ],
        columnGap: 4,
        margin: [0, 3, 0, 0],
      },
      {
        columns: [
          { width: 70, text: "Destination", bold: true, fontSize: 9 },
          { width: 150, stack: [{ text: d.consignee.city === "" ? " " : d.consignee.city, fontSize: 9 }, line(150)] },
          { width: 16, text: "St", bold: true, fontSize: 7.5 },
          { width: 40, stack: [{ text: d.consignee.state === "" ? " " : d.consignee.state, fontSize: 9, alignment: "center" }, line(40)] },
          { width: 18, text: "Zip", bold: true, fontSize: 7.5 },
          { width: 60, stack: [{ text: d.consignee.zip === "" ? " " : d.consignee.zip, fontSize: 9, alignment: "center" }, line(60)] },
          { width: "*", text: "Delivery Address *", fontSize: 6, margin: [8, 2, 0, 0] },
        ],
        columnGap: 4,
        margin: [0, 3, 0, 0],
      },
      {
        text: "* To be filled in only when shipper desires and governing tariffs provide for delivery thereof.",
        fontSize: 5, alignment: "right", margin: [0, 2, 0, 0],
      },
    ],
    margin: [0, 2, 0, 4],
  };
}

/** TRV NO. — every order number on the shipment, the §3.20 point of the whole document. */
function trvLine(d: BolData): Content {
  return {
    columns: [
      { width: 55, text: "TRV NO.", bold: true, fontSize: 9.5 },
      { width: "*", text: d.orderNumbers.join(","), bold: true, fontSize: 9.5 },
    ],
    margin: [0, 2, 0, 4],
  };
}

/** Delivering Carrier / Car or Vehicle Initials / No. — blank rules for hand completion. */
function deliveringCarrierLine(): Content {
  return {
    columns: [
      { width: 80, text: "Delivering Carrier", bold: true, fontSize: 8 },
      { width: 150, stack: [{ text: " " }, line(150)] },
      { width: 105, text: "Car or Vehicle Initials", bold: true, fontSize: 8, alignment: "right" },
      { width: 90, stack: [{ text: " " }, line(90)] },
      { width: 22, text: "No.", bold: true, fontSize: 8, alignment: "right" },
      { width: "*", stack: [{ text: " " }, line(55)] },
    ],
    columnGap: 4,
    margin: [0, 2, 0, 6],
  };
}

const head = (text: string): TableCell => ({ text, bold: true, alignment: "center", fontSize: 6.5 });

/** The freight table (left) beside the Section 7 / prepaid-collect sidebar (right). */
function freightBlock(d: BolData): Content {
  const freightTable: Content = {
    table: {
      headerRows: 1,
      widths: [40, "*", 62, 44, 42],
      body: [
        [
          head("No. Packages"),
          { stack: [{ text: "Kind Of Package, Description of Articles", bold: true, alignment: "center", fontSize: 6.5 }, { text: "Special Marks, and Exceptions", bold: true, alignment: "center", fontSize: 6.5 }] },
          head("*Weight (Subject to Correction)"),
          head("Class or Rate"),
          head("Check Column"),
        ],
        [
          { text: d.packageCount === null ? "" : num(d.packageCount), alignment: "center", fontSize: 9 },
          { text: d.freightDescription, fontSize: 9 },
          { text: num(d.totalWeight), alignment: "right", fontSize: 9 },
          { text: d.freightClass, alignment: "center", fontSize: 9 },
          { text: "" },
        ],
      ],
    },
    layout: LAYOUT.boxed,
  };

  const smallRule = (margin: [number, number, number, number]): Content =>
    ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 160, y2: 0, lineWidth: 0.8 }], margin });

  const sidebar: Content = {
    stack: [
      { text: SECTION_7_TEXT, fontSize: 6 },
      { text: NO_DELIVERY_TEXT, fontSize: 6, margin: [0, 6, 0, 0] },
      smallRule([0, 14, 0, 1]),
      { text: "(Signature of consignor)", fontSize: 5.5, alignment: "center" },
      { text: "Freight charges are PREPAID unless marked collect.", fontSize: 6, margin: [0, 8, 0, 2] },
      {
        columns: [
          { width: "*", text: "CHECK BOX IF COLLECT", bold: true, fontSize: 6.5, margin: [0, 2, 0, 0] },
          {
            width: 14,
            // The one data-driven mark on the whole form (spec §10.2's "prepaid/collect block
            // driven by freightTerms"): an X in the box for COLLECT, an empty box for PREPAID.
            table: { widths: [10], body: [[{ text: d.freightTerms === "COLLECT" ? "X" : "", alignment: "center", fontSize: 7, bold: true }]] },
            layout: LAYOUT.boxed,
          },
        ],
        margin: [0, 0, 0, 6],
      },
      smallRule([0, 8, 0, 1]),
      { text: "RECEIVED $", fontSize: 6.5, bold: true },
      { text: "to apply in prepayment of the charges on the property described hereon.", fontSize: 6, margin: [0, 2, 0, 0] },
      smallRule([0, 12, 0, 1]),
      { text: "Agent or Cashier", fontSize: 5.5, alignment: "center" },
      smallRule([0, 8, 0, 1]),
      { text: "Per", fontSize: 6.5 },
      { text: "(The signature here acknowledges only the amount prepaid.)", fontSize: 6, margin: [0, 2, 0, 0] },
      { text: "Charges Advanced:", fontSize: 6.5, bold: true, margin: [0, 8, 0, 0] },
      smallRule([0, 8, 0, 1]),
      { text: "$", fontSize: 6.5 },
      { text: IMPRINT_TEXT, fontSize: 6, margin: [0, 8, 0, 0] },
    ],
  };

  return {
    columns: [
      { width: "*", stack: [freightTable] },
      { width: 170, stack: [sidebar] },
    ],
    columnGap: 8,
    margin: [0, 0, 0, 10],
  };
}

/** The bottom note stack: value declaration, liability limitation, fibre boxes, and the
 *  hand-signed Shipper/Agent lines. */
function bottomBlock(): Content {
  return {
    stack: [
      { text: WATER_NOTE, fontSize: 5.5 },
      { text: VALUE_NOTE, fontSize: 5.5, margin: [0, 2, 0, 0] },
      { text: DECLARED_VALUE_TEXT, bold: true, fontSize: 7, margin: [0, 3, 0, 0] },
      {
        columns: [
          { width: 200, text: "" },
          { width: 30, text: "Per", bold: true, fontSize: 6.5 },
          { width: 160, stack: [{ text: " " }, line(160)] },
          { width: "*", text: "" },
        ],
        margin: [0, 1, 0, 2],
      },
      { text: LIABILITY_NOTE, fontSize: 5.5 },
      fullRule([0, 4, 0, 2], 0.8),
      { text: FIBRE_NOTE, bold: true, fontSize: 5.5 },
      fullRule([0, 2, 0, 8], 0.8),
      {
        columns: [
          { width: 60, text: "Shipper, Per", bold: true, fontSize: 7.5 },
          { width: 160, stack: [{ text: " " }, line(160)] },
          { width: 60, text: "Agent, Per", bold: true, fontSize: 7.5, alignment: "right" },
          { width: "*", stack: [{ text: " " }, line(200)] },
        ],
        columnGap: 6,
        margin: [0, 6, 0, 8],
      },
      {
        columns: [
          { width: 165, text: "Permanent Post-office address of shipper", bold: true, fontSize: 7.5 },
          { width: "*", stack: [{ text: " " }, line(300)] },
        ],
        columnGap: 4,
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default bill-of-lading template (spec §10.2). PURE — data in, JSON out.
// ---------------------------------------------------------------------------------------------

export function buildBolDefinition(input: BolData): TDocumentDefinitions {
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: "Roboto", fontSize: 7 },
    // No `info.creationDate`, no clock anywhere — two prints of the same shipment must not differ
    // for no reason (the traveler's purity rule).
    content: [
      headerBlock(input),
      fullRule([0, 0, 0, 3]),
      carrierBlock(input),
      { text: RECEIVED_TEXT, fontSize: 5.5, margin: [0, 0, 0, 2] },
      shipFromLine(input),
      { text: PROPERTY_TEXT, fontSize: 5.5, margin: [0, 0, 0, 2] },
      { text: CERTIFIES_TEXT, fontSize: 6, bold: true, margin: [8, 0, 0, 2] },
      fullRule([0, 0, 0, 4], 0.8),
      consignedBlock(input),
      trvLine(input),
      fullRule([0, 0, 0, 3], 0.8),
      deliveringCarrierLine(),
      freightBlock(input),
      bottomBlock(),
    ],
  };
}

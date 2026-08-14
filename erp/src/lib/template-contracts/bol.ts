/**
 * The bill of lading's template contract (spec §5.3), derived from `src/server/pdf/bol.ts`'s
 * `buildBolDefinition` — sections are the builder's stacked blocks in stack order, fields are
 * its printed labels and data slots, and the ELEVEN named UDSBL form constants become this
 * contract's text blocks with today's transcriptions as their defaults (spec §8's "edited in
 * place": the template designer is the legal text's editing path).
 *
 * Text defaults are copied VERBATIM from the builder's constants, transcription quirks intact
 * ("here under", "(I) … (2)", "Comerce") — the source document wins, not the transcriber's
 * spelling instinct (the builder's own rule). The builder's small inline form glue (the
 * parenthetical notes, "RECEIVED $", "Agent or Cashier", signature-rule captions) is NOT
 * enumerated: it is the form's own furniture, rendered by the builder, not a knob.
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

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

export const BOL_CONTRACT: TemplateContract = {
  docType: "BOL",
  name: "Bill of lading",
  sections: [
    {
      // headerBlock — title left, the four labeled form rules right.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        {
          key: "original_label", name: "Original label", defaultLabel: "Original - Not Negotiable",
          removable: true,
        },
        {
          key: "title", name: "Document title", defaultLabel: "STRAIGHT BILL OF LADING",
          removable: true,
        },
        {
          key: "pro_number", name: "Carrier's pro number", defaultLabel: "Carrier's Pro No.",
          removable: true,
        },
        {
          key: "bol_number", name: "Bill-of-lading number",
          defaultLabel: "Shipper's Bill of Lading No.", removable: true,
        },
        {
          key: "consignee_ref", name: "Consignee's ref/PO", defaultLabel: "Consignee's Ref/PO No.",
          removable: true,
        },
        {
          key: "scac_code", name: "Carrier's SCAC code", defaultLabel: "Carrier's Code (SCAC)",
          removable: true,
        },
      ],
    },
    {
      // carrierBlock — the carrier's name over its rule.
      key: "carrier", name: "Carrier", hideable: true, reorderable: true,
      fields: [
        {
          key: "carrier_name", name: "Carrier name", defaultLabel: "(Name of Carrier)",
          removable: true,
        },
      ],
    },
    {
      // The legal preamble: bol_received_text, the ship-from line, bol_property_text,
      // bol_certifies_text — one section, three text blocks and one composite data line. The
      // ship-from line's "at"/"From" connectives are the form's own wording, carried by the
      // builder, so the line is ONE field rather than a field per connective.
      key: "received", name: "Received / legal preamble", hideable: true, reorderable: true,
      fields: [
        { key: "ship_from", name: "Ship-from line", defaultLabel: "", removable: true },
      ],
    },
    {
      // consignedBlock — Consigned to / Destination / St / Zip over their rules.
      key: "consigned", name: "Consignee", hideable: true, reorderable: true,
      fields: [
        { key: "consigned_to", name: "Consigned to", defaultLabel: "Consigned to", removable: true },
        { key: "destination", name: "Destination", defaultLabel: "Destination", removable: true },
        { key: "destination_state", name: "State", defaultLabel: "St", removable: true },
        { key: "destination_zip", name: "Zip", defaultLabel: "Zip", removable: true },
      ],
    },
    {
      // trvLine — every order number on the shipment, the §3.20 point of the whole document.
      key: "trv", name: "TRV numbers", hideable: true, reorderable: true,
      fields: [
        { key: "trv_no", name: "TRV numbers", defaultLabel: "TRV NO.", removable: true },
      ],
    },
    {
      // deliveringCarrierLine — blank rules for hand completion.
      key: "delivering_carrier", name: "Delivering carrier", hideable: true, reorderable: true,
      fields: [
        {
          key: "delivering_carrier", name: "Delivering carrier", defaultLabel: "Delivering Carrier",
          removable: true,
        },
        {
          // Spec §10.2's own "Car or Vehicle Initials" spelling, used over the sample's.
          key: "vehicle_initials", name: "Vehicle initials", defaultLabel: "Car or Vehicle Initials",
          removable: true,
        },
        { key: "vehicle_no", name: "Vehicle number", defaultLabel: "No.", removable: true },
      ],
    },
    {
      // freightBlock — the freight table (widths [40, "*", 62, 44, 42]) beside the 170pt
      // Section-7/prepaid-collect sidebar with an 8pt gap, so the table's real budget is
      // 564 − 170 − 8 = 386pt (see tableBudgets). The sidebar's paragraphs are text blocks; its
      // one data-driven mark is the collect checkbox.
      key: "freight", name: "Freight", hideable: true, reorderable: true,
      fields: [
        {
          key: "package_count", name: "Package count", defaultLabel: "No. Packages",
          removable: true, column: { table: "freight", defaultWidth: 40 },
        },
        {
          // The header cell stacks a second line ("Special Marks, and Exceptions") under this
          // label — the builder's rendering, not a second column.
          key: "freight_description", name: "Freight description",
          defaultLabel: "Kind Of Package, Description of Articles", removable: true,
          column: { table: "freight", defaultWidth: "*" },
        },
        {
          key: "freight_weight", name: "Weight", defaultLabel: "*Weight (Subject to Correction)",
          removable: true, column: { table: "freight", defaultWidth: 62 },
        },
        {
          key: "freight_class", name: "Class or rate", defaultLabel: "Class or Rate",
          removable: true, column: { table: "freight", defaultWidth: 44 },
        },
        {
          key: "check_column", name: "Check column", defaultLabel: "Check Column",
          removable: true, column: { table: "freight", defaultWidth: 42 },
        },
        {
          key: "collect_checkbox", name: "Collect checkbox", defaultLabel: "CHECK BOX IF COLLECT",
          removable: true,
        },
      ],
    },
    {
      // bottomBlock — the note stack and the hand-signed lines.
      key: "bottom", name: "Notes and signatures", hideable: true, reorderable: true,
      fields: [
        {
          key: "shipper_per", name: "Shipper signature", defaultLabel: "Shipper, Per",
          removable: true,
        },
        { key: "agent_per", name: "Agent signature", defaultLabel: "Agent, Per", removable: true },
        {
          key: "po_address", name: "Post-office address",
          defaultLabel: "Permanent Post-office address of shipper", removable: true,
        },
      ],
    },
  ],
  textBlocks: [
    { key: "bol_received_text", name: "Received clause", defaultText: RECEIVED_TEXT },
    { key: "bol_property_text", name: "Property clause", defaultText: PROPERTY_TEXT },
    { key: "bol_certifies_text", name: "Shipper certification", defaultText: CERTIFIES_TEXT },
    { key: "bol_section_7_text", name: "Section 7 clause", defaultText: SECTION_7_TEXT },
    { key: "bol_no_delivery_text", name: "No-delivery clause", defaultText: NO_DELIVERY_TEXT },
    { key: "bol_imprint_text", name: "Imprint note", defaultText: IMPRINT_TEXT },
    { key: "bol_water_note", name: "Water-carrier note", defaultText: WATER_NOTE },
    { key: "bol_value_note", name: "Declared-value note", defaultText: VALUE_NOTE },
    {
      key: "bol_declared_value_text", name: "Declared-value statement",
      defaultText: DECLARED_VALUE_TEXT,
    },
    { key: "bol_liability_note", name: "Liability limitation note", defaultText: LIABILITY_NOTE },
    { key: "bol_fibre_note", name: "Fibre-box certification", defaultText: FIBRE_NOTE },
  ],
  // `num()` groups thousands ("11,415"); the date knob defaults to `bolDate`'s own style
  // ("Jul - 06 - 2026").
  formats: { thousandsSeparator: true, dateFormat: "MMM - DD - YYYY" },
  // Today's builder: defaultStyle 7pt; "STRAIGHT BILL OF LADING" (15pt) is the heading; 5.5pt is
  // the fine-print clause size.
  fonts: { family: "Roboto", baseSize: 7, headingSize: 15, smallSize: 5.5 },
  tableBudgets: { freight: 386 }, // 564 − 170 (sidebar) − 8 (column gap)
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(BOL_CONTRACT);

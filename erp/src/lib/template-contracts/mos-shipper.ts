/**
 * The multi-order-shipment shipping ticket's template contract (spec §5.3). One builder
 * (`buildShippingTicketDefinition`) serves both ticket shapes today, and this contract starts
 * STRUCTURALLY IDENTICAL to ./shipper.ts — deliberately as its own full copy, not a shared
 * object or factory: `SHIPPER` and `MOS_SHIPPER` are distinct docTypes free to diverge (spec
 * §4.1 — a multi-order shipment's paper resolves this type, a single-order shipment's the
 * other), and sharing the declaration would put one template's paper at the mercy of the
 * other's edits (the spec §5.4 per-file rule). A test pins that they start identical; when they
 * diverge, that test — not this comment — is what changes.
 *
 * Derivation notes (the two-group container fold and its 282pt budget, the one-date-knob
 * default, the copied liability literal) live in ./shipper.ts and apply here unchanged.
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

// Copied verbatim from src/server/settings.ts's SHIPPER_LIABILITY_DEFAULT — see ./shipper.ts's
// comment for why it is copied rather than imported, and why the middle paragraph's spelling
// ("AMERICAN HEAT TREAT - ALABAMA") is preserved as the source sample prints it.
const SHIPPER_LIABILITY_TEXT_DEFAULT =
  "Above pricing is based on American Heat Treating - Alabama STATEMENT OF LIMITED LIABILITY " +
  "which is sent with our quotation. If quoted pricing is accepted by the customer these terms " +
  "are in effect. IMPORTANT NOTICE: PURCHASE ORDERS ARE SUBJECT TO THE AMERICAN HEAT TREAT - " +
  "ALABAMA TERMS AND CONDITIONS AS GENERALLY ADOPTED BY THE METAL TREATING INSTITUTE. A COPY OF " +
  "THESE TERMS AND CONDITIONS IS ON THE LEAD SHEET OF THIS FAX. IF ADDITIONAL LIABILITY (IN " +
  "EXCESS OF OUR LIMITS) IS REQUESTED, WE MUST KNOW THE VALUE OF YOUR PARTS PRIOR TO PROCESSING. " +
  "AN ADDITIONAL CHARGE MAY BE ASSESSED TO COMPENSATE FOR THE INCREASED EXPOSURE.\n\n" +
  "NO ADDITIONAL LIABILITY WILL BE IMPOSED UPON AMERICAN HEAT TREATING - ALABAMA, IN THE " +
  "ABSENCE OF A WRITTEN AGREEMENT SPECIFICALLY COVERING SAME SIGNED BY A PRINCIPAL OWNER OF " +
  "AMERICAN HEAT TREATING - ALABAMA.";

export const MOS_SHIPPER_CONTRACT: TemplateContract = {
  docType: "MOS_SHIPPER",
  name: "Multi-order shipping ticket",
  sections: [
    {
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "title", name: "Document title", defaultLabel: "Shipping Ticket", removable: true },
        { key: "order_no", name: "Order number", defaultLabel: "Order No.:", removable: true },
        { key: "ship_date", name: "Ship date", defaultLabel: "Ship Date:", removable: true },
        { key: "company_address", name: "Company address", defaultLabel: "", removable: true },
        { key: "company_phone", name: "Company phone", defaultLabel: "", removable: true },
      ],
    },
    {
      key: "parties", name: "Sold to / Ship to", hideable: true, reorderable: true,
      fields: [
        { key: "sold_to", name: "Sold-to box", defaultLabel: "Sold To:", removable: true },
        { key: "ship_to", name: "Ship-to box", defaultLabel: "Ship To:", removable: true },
      ],
    },
    {
      key: "field_strip", name: "Order fields", hideable: true, reorderable: true,
      fields: [
        {
          key: "po_number", name: "Purchase order", defaultLabel: "Purchase Order Number",
          removable: true, column: { table: "field_strip", defaultWidth: "*" },
        },
        {
          key: "packing_list_no", name: "Packing list number", defaultLabel: "Packing List No",
          removable: true, column: { table: "field_strip", defaultWidth: "*" },
        },
        {
          key: "customer_job_no", name: "Customer job number", defaultLabel: "Customer Job No",
          removable: true, column: { table: "field_strip", defaultWidth: 110 },
        },
        {
          key: "route", name: "Route", defaultLabel: "Route", removable: true,
          column: { table: "field_strip", defaultWidth: 70 },
        },
        {
          key: "carrier", name: "Carrier", defaultLabel: "Carrier", removable: true,
          column: { table: "field_strip", defaultWidth: 85 },
        },
      ],
    },
    {
      key: "lines", name: "Part lines", hideable: true, reorderable: true,
      fields: [
        {
          key: "line_qty", name: "Quantity", defaultLabel: "Quantity", removable: true,
          column: { table: "lines", defaultWidth: 70 },
        },
        {
          key: "line_part", name: "Part identity",
          defaultLabel: "Part No.  /  Part Name  /  Part Description", removable: true,
          column: { table: "lines", defaultWidth: "*" },
        },
        {
          key: "line_pounds", name: "Pounds", defaultLabel: "Pounds", removable: true,
          column: { table: "lines", defaultWidth: 90 },
        },
      ],
    },
    {
      key: "containers", name: "Containers", hideable: true, reorderable: true,
      fields: [
        {
          key: "container_type", name: "Container type", defaultLabel: "Container Type",
          removable: true, column: { table: "containers", defaultWidth: 80 },
        },
        {
          key: "container_count", name: "Container count", defaultLabel: "# Of Containers",
          removable: true, column: { table: "containers", defaultWidth: "*" },
        },
        {
          key: "cust_cont_id", name: "Customer container id", defaultLabel: "Cust Cont Id",
          removable: true, column: { table: "containers", defaultWidth: 62 },
        },
      ],
    },
    {
      key: "serials", name: "Serial numbers", hideable: true, reorderable: true,
      fields: [
        { key: "serials", name: "Serial numbers", defaultLabel: "Serial Numbers:", removable: true },
      ],
    },
    {
      key: "liability", name: "Liability text", hideable: true, reorderable: true, fields: [],
    },
    {
      key: "totals", name: "Totals", hideable: true, reorderable: true,
      fields: [
        {
          key: "shipped_complete", name: "Shipped-complete banner",
          defaultLabel: "Shipped Complete", removable: true,
        },
        {
          key: "total_qty", name: "Quantity shipped", defaultLabel: "Quantity Shipped:",
          removable: true,
        },
        {
          key: "total_weight", name: "Pounds shipped", defaultLabel: "Pounds Shipped:",
          removable: true,
        },
      ],
    },
    {
      key: "tear_off", name: "Tear-off strip", hideable: true, reorderable: true,
      fields: [
        { key: "tear_order_no", name: "Order number", defaultLabel: "Order No.:", removable: true },
        {
          key: "tear_shipped_complete", name: "Shipped complete", defaultLabel: "Shipped Complete",
          removable: true,
        },
        {
          key: "tear_total_qty", name: "Quantity shipped", defaultLabel: "Quantity Shipped:",
          removable: true,
        },
        {
          key: "tear_total_weight", name: "Pounds shipped", defaultLabel: "Pounds Shipped:",
          removable: true,
        },
        { key: "received_by", name: "Received by", defaultLabel: "Received By:", removable: true },
        { key: "received_date", name: "Received date", defaultLabel: "Date:", removable: true },
        { key: "tear_sold_to", name: "Sold to", defaultLabel: "Sold To:", removable: true },
        { key: "shipped_on", name: "Shipped on", defaultLabel: "Shipped ON:", removable: true },
      ],
    },
  ],
  textBlocks: [
    {
      key: "shipper_liability_text", name: "Liability text",
      defaultText: SHIPPER_LIABILITY_TEXT_DEFAULT,
    },
  ],
  formats: { thousandsSeparator: true, dateFormat: "M/D/YYYY" },
  fonts: { family: "Roboto", baseSize: 8, headingSize: 16, smallSize: 5.5 },
  tableBudgets: { containers: 282 },
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(MOS_SHIPPER_CONTRACT);

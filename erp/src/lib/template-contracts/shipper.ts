/**
 * The single-order shipping ticket's template contract (spec §5.3), derived from
 * `src/server/pdf/shipping-ticket.ts`'s `buildShippingTicketDefinition` — sections are the
 * builder's stacked blocks in stack order, fields are its printed labels and columns.
 *
 * One builder serves both ticket shapes today, but `SHIPPER` and `MOS_SHIPPER` are distinct
 * docTypes free to diverge (spec §4.1) — so ./mos-shipper.ts carries its own full copy of this
 * declaration rather than sharing one object: sharing would put one template's paper at the
 * mercy of another's edits, the same reason the builders keep per-file formatters (spec §5.4).
 * A test pins that they start identical.
 *
 * Nothing here is locked: spec §5.6's locks are traveler-only.
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

/**
 * `shipper_liability_text`'s code default, copied VERBATIM from `src/server/settings.ts`'s
 * `SHIPPER_LIABILITY_DEFAULT` — copied, not imported: importing the server module would drag
 * Prisma into the client bundle (the SESSION_COOKIE keep-in-sync-by-hand rule). The setting
 * itself retires into template content later this phase (spec §8); until then the two literals
 * must match. The middle paragraph's "AMERICAN HEAT TREAT - ALABAMA" (missing "ING") is how the
 * source sample prints — not a transcription error to silently "fix".
 */
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

export const SHIPPER_CONTRACT: TemplateContract = {
  docType: "SHIPPER",
  name: "Shipping ticket",
  sections: [
    {
      // headerBlock — company/title left, order/date center, address block right.
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
      // partiesBlock — the two boxed address blocks; each box is one bound blob (name, street,
      // city/state/zip, corner code), so each is one field.
      key: "parties", name: "Sold to / Ship to", hideable: true, reorderable: true,
      fields: [
        { key: "sold_to", name: "Sold-to box", defaultLabel: "Sold To:", removable: true },
        { key: "ship_to", name: "Ship-to box", defaultLabel: "Ship To:", removable: true },
      ],
    },
    {
      // fieldStrip — widths ["*", "*", 110, 70, 85].
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
      // linesTable — widths [70, "*", 90]. The part label's double spacing is the builder's own.
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
      // containersTable — the builder folds the container list into TWO side-by-side column
      // groups (widths [80, "*", 62, 80, "*", 62]), so the three declared columns print twice
      // and their budget is HALF the content width: 282pt (see tableBudgets below).
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
      // serialsBlock — one labelled list; renders nothing when no serial is flagged.
      key: "serials", name: "Serial numbers", hideable: true, reorderable: true,
      fields: [
        { key: "serials", name: "Serial numbers", defaultLabel: "Serial Numbers:", removable: true },
      ],
    },
    {
      // liabilityBlock — renders the shipper_liability_text text block; no fields of its own.
      key: "liability", name: "Liability text", hideable: true, reorderable: true, fields: [],
    },
    {
      // totalsBlock.
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
      // tearOff — the hand-completed page-bottom strip.
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
  // `num()` groups thousands; the ONE date knob defaults to the header's `shortDate` style
  // ("7/29/2026") — the tear-off's zero-padded "07/29/2026" is the builder's own second slot,
  // for the conversion task to map.
  formats: { thousandsSeparator: true, dateFormat: "M/D/YYYY" },
  // Today's builder: defaultStyle 8pt; "Shipping Ticket" (16pt) is the heading; 5.5pt is the
  // liability fine print.
  fonts: { family: "Roboto", baseSize: 8, headingSize: 16, smallSize: 5.5 },
  tableBudgets: { containers: 282 }, // 564 / 2 — the two-group fold above
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(SHIPPER_CONTRACT);

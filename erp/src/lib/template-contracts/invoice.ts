/**
 * The invoice/credit template contract (spec §5.3), derived from `src/server/pdf/invoice.ts`'s
 * `buildInvoiceDefinition` — sections are the builder's stacked blocks in stack order, fields
 * are its printed labels and data-bound slots. ONE contract covers both kinds (spec §4.1:
 * `INVOICE` covers credits): the builder is kind-agnostic — "Invoice"/"Credit" is DATA (`title`,
 * off the row's own kind), so the title field here is value-only and a credit's paper differs
 * only in its number and signs.
 *
 * FROZEN COLUMNS ONLY (the frozen-paper rule, spec §5.3): every field maps onto
 * `InvoicePdfData`, which is built exclusively from the invoice row's frozen snapshot columns
 * plus the two sanctioned live identity reads (company / remit-to — spec §4.2: identity, not
 * layout). The contract-vs-`InvoicePdfData` walk in tests/template-contracts.test.ts pins the
 * mapping — a field with no frozen source cannot land.
 *
 * This contract is `negativeStyle`'s first real declarer (ruling 3): a credit's negative
 * amounts are what the knob formats. Today's value is `SIGN_AFTER_SYMBOL` — the 5A ruling's
 * "$-937.44", the sign between the "$" and the digits.
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

export const INVOICE_CONTRACT: TemplateContract = {
  docType: "INVOICE",
  name: "Invoice / credit",
  sections: [
    {
      // headerBlock — the big title over the company name, both centered. The title is DATA
      // (the row's kind), so its field is value-only.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "title", name: "Document title", defaultLabel: "", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
      ],
    },
    {
      // identityBlock — Invoice No. / Invoice Date / Terms left (NO Page No. — the builder's
      // recorded 5A deviation), the boxed Remit To blob right. The builder's trailing
      // label-value spacing ("Invoice No.:  ") is alignment glue, not label content.
      key: "identity", name: "Invoice identity", hideable: true, reorderable: true,
      fields: [
        { key: "invoice_no", name: "Invoice number", defaultLabel: "Invoice No.:", removable: true },
        { key: "invoice_date", name: "Invoice date", defaultLabel: "Invoice Date:", removable: true },
        { key: "terms", name: "Terms", defaultLabel: "Terms:", removable: true },
        { key: "remit_to", name: "Remit-to box", defaultLabel: "Remit To", removable: true },
      ],
    },
    {
      // partiesBlock — the two frozen snapshot address stacks; "Billto:"/"Shipto:" are the
      // sample's own spellings.
      key: "parties", name: "Bill to / ship to", hideable: true, reorderable: true,
      fields: [
        { key: "bill_to", name: "Bill-to address", defaultLabel: "Billto:", removable: true },
        { key: "ship_to", name: "Ship-to address", defaultLabel: "Shipto:", removable: true },
      ],
    },
    {
      // columnHeaderStrip — the one boxed strip naming the four data columns, widths
      // [52, "*", 66, 84]. Everything beneath (order strip, parts, prices, totals) is free-flow
      // text the builder aligns to these same widths, so THESE columns carry the width knobs and
      // the body fields below are value-only.
      key: "column_header", name: "Column headers", hideable: true, reorderable: true,
      fields: [
        {
          key: "col_qty", name: "Quantity column", defaultLabel: "Quantity", removable: true,
          column: { table: "columns", defaultWidth: 52 },
        },
        {
          key: "col_info", name: "Information column",
          defaultLabel: "Order Information / Part No. / Description / Pricing Information",
          removable: true, column: { table: "columns", defaultWidth: "*" },
        },
        {
          key: "col_each_weight", name: "Each-weight column", defaultLabel: "Each weight",
          removable: true, column: { table: "columns", defaultWidth: 66 },
        },
        {
          key: "col_amount", name: "Amount column", defaultLabel: "Total Wt / Price",
          removable: true, column: { table: "columns", defaultWidth: 84 },
        },
      ],
    },
    {
      // orderStrip — Our Order # / Your PO #, Material / Process, the underlined PARTS heading.
      key: "order_strip", name: "Order strip", hideable: true, reorderable: true,
      fields: [
        { key: "our_order_no", name: "Order number", defaultLabel: "Our Order #:", removable: true },
        { key: "your_po", name: "Customer PO", defaultLabel: "Your PO #:", removable: true },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
        // Ruling 4's invoice half binds `part.processName` into the EXISTING processNames
        // snapshot at create time (spec §5.7) — the contract just declares the printed slot.
        { key: "process", name: "Process", defaultLabel: "Process:", removable: true },
        { key: "parts_heading", name: "Parts heading", defaultLabel: "PARTS", removable: true },
      ],
    },
    {
      // partsRows — one free-flow row per part under the strip's columns (value-only; the
      // widths live on column_header, see above).
      key: "parts", name: "Part rows", hideable: true, reorderable: true,
      fields: [
        { key: "part_qty", name: "Part quantity", defaultLabel: "", removable: true },
        { key: "part_identity", name: "Part identity", defaultLabel: "", removable: true },
        { key: "part_each_weight", name: "Each weight", defaultLabel: "", removable: true },
        { key: "part_total_weight", name: "Total weight", defaultLabel: "", removable: true },
      ],
    },
    {
      // priceBlock — the underlined PRICE heading, per-operation description + amount, the
      // centered detail lines beneath ("Price per <unit>:" is composed label + unit glue), and
      // the Phase 6 "Quote #N" source line (frozen `sourceQuoteNumber`; label root "Quote").
      key: "price", name: "Price block", hideable: true, reorderable: true,
      fields: [
        { key: "price_heading", name: "Price heading", defaultLabel: "PRICE", removable: true },
        { key: "price_description", name: "Operation name", defaultLabel: "", removable: true },
        { key: "price_amount", name: "Billed amount", defaultLabel: "", removable: true },
        { key: "quote_source", name: "Quote source line", defaultLabel: "Quote", removable: true },
        { key: "price_per", name: "Per-unit price", defaultLabel: "Price per", removable: true },
        {
          key: "minimum_charge", name: "Minimum charge", defaultLabel: "Minimum Charge:",
          removable: true,
        },
        { key: "setup_charge", name: "Setup charge", defaultLabel: "Setup Charge:", removable: true },
      ],
    },
    {
      // totalsBlock — Sub Total, the named per-line rows (their descriptions are frozen line
      // data), the bold Total Amount Due.
      key: "totals", name: "Totals", hideable: true, reorderable: true,
      fields: [
        { key: "subtotal", name: "Subtotal", defaultLabel: "Sub Total Amount:", removable: true },
        { key: "surcharge_rows", name: "Surcharge lines", defaultLabel: "", removable: true },
        { key: "charge_rows", name: "Charge lines", defaultLabel: "", removable: true },
        { key: "cert_row", name: "Certification line", defaultLabel: "", removable: true },
        { key: "freight_row", name: "Freight line", defaultLabel: "", removable: true },
        { key: "tax_row", name: "Sales-tax line", defaultLabel: "", removable: true },
        { key: "total", name: "Total due", defaultLabel: "Total Amount Due:", removable: true },
      ],
    },
    {
      // footerBlock — the static per-page strip: address left, the sample's own "Contact:
      // Accounts Receivable" center (a pure label — no data behind it), phone right.
      key: "footer", name: "Page footer strip", hideable: true, reorderable: true,
      fields: [
        { key: "footer_address", name: "Company address", defaultLabel: "", removable: true },
        {
          key: "footer_contact", name: "Contact line",
          defaultLabel: "Contact: Accounts Receivable", removable: true,
        },
        { key: "footer_phone", name: "Company phone", defaultLabel: "Phone:", removable: true },
      ],
    },
  ],
  textBlocks: [], // the invoice carries no standing paragraph — its texts are all data or labels
  // `money()` prints "$937.44" / "$-937.44" (SIGN_AFTER_SYMBOL, 2 decimals, grouped thousands);
  // `longDate` prints "July 29, 2026" — "MMM D, YYYY" is the fixed set's token for that long
  // style (the Task 1 DATE_FORMATS note; Task 12 maps token → rendering).
  formats: {
    negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
    dateFormat: "MMM D, YYYY",
  },
  // Today's builder: defaultStyle 9pt; the title (20pt) is the heading; 7.5pt is the footer
  // strip's fine print.
  fonts: { family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 7.5 },
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(INVOICE_CONTRACT);

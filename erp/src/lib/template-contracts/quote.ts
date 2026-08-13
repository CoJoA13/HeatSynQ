/**
 * The quotation's template contract (spec §5.3), derived from `src/server/pdf/quote.ts`'s
 * `buildQuoteDefinition` — sections are the builder's stacked blocks in stack order, fields are
 * its printed labels and data-bound slots.
 *
 * TWO defaults set this contract apart from its seven siblings, both because golden
 * compatibility means reproducing what the quote's builder ALREADY prints:
 *  - `pageFooter` defaults TRUE (the contract-level default, alone among the eight): the
 *    builder's footer callback prints "Page: N of M" today — Phase 6's sanctioned carve-out,
 *    which §6.1's declarative primitive replaces in Task 14.
 *  - `priceDecimals` defaults 4 where the invoice's is 2: unit and break prices print `money4`
 *    ("$0.055") — ruling Q7's accepted deviation, now an editable default. Quote prices are
 *    Decimal(12,4) and rounding them to cents would misstate the agreement.
 *
 * Unlike the invoice, no negative money ever prints on a quote, so `negativeStyle` is off this
 * surface entirely (the Task 1 knob-surface rule).
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

/**
 * The two standing texts' code defaults, copied VERBATIM from `src/server/settings.ts`
 * (`quote_intro_text` / `quote_liability_text`) — copied, not imported: importing the server
 * module would drag Prisma into the client bundle (the SESSION_COOKIE keep-in-sync-by-hand
 * rule). The settings retire into template content in Task 14; until then the literals must
 * match. The liability block SHIPS EMPTY — the owner keys the shop's limited-liability wording,
 * and the builder omits the strip entirely when the text is "".
 */
const QUOTE_INTRO_TEXT_DEFAULT = "We are pleased to provide you with the following quotation:";
const QUOTE_LIABILITY_TEXT_DEFAULT = "";

export const QUOTE_CONTRACT: TemplateContract = {
  docType: "QUOTE",
  name: "Quotation",
  sections: [
    {
      // headerBlock — the centered "Quotation" title over the company block, the quotation
      // number right.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "title", name: "Document title", defaultLabel: "Quotation", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "company_address", name: "Company address", defaultLabel: "", removable: true },
        {
          key: "quote_number", name: "Quotation number", defaultLabel: "Quotation Number:",
          removable: true,
        },
      ],
    },
    {
      // partiesBlock — the Attn/bill-to stack left, the info column right (phone, dates, terms,
      // RFQ, the contact's phone).
      key: "parties", name: "Attention / quote fields", hideable: true, reorderable: true,
      fields: [
        { key: "attn", name: "Attention line", defaultLabel: "Attn:", removable: true },
        { key: "bill_to", name: "Bill-to address", defaultLabel: "", removable: true },
        { key: "company_phone", name: "Company phone", defaultLabel: "Phone:", removable: true },
        { key: "effective", name: "Effective date", defaultLabel: "Effective:", removable: true },
        { key: "expires", name: "Expiry date", defaultLabel: "Expires On:", removable: true },
        { key: "terms", name: "Terms", defaultLabel: "Terms:", removable: true },
        {
          key: "rfq_number", name: "RFQ number", defaultLabel: "Your R.F.Q. Number:",
          removable: true,
        },
        {
          key: "customer_phone", name: "Customer phone", defaultLabel: "Your Phone No.:",
          removable: true,
        },
      ],
    },
    {
      // The intro line — renders the quote_intro_text text block; no fields of its own (the
      // shipper liability precedent).
      key: "intro", name: "Intro line", hideable: true, reorderable: true, fields: [],
    },
    {
      // columnHeaderStrip — the one boxed strip naming the four data columns, widths
      // [52, "*", 66, 84]; the line/price rows beneath are free-flow text aligned to these same
      // widths, so THESE columns carry the width knobs (the invoice's shape).
      key: "column_header", name: "Column headers", hideable: true, reorderable: true,
      fields: [
        {
          key: "col_qty", name: "Quantity column", defaultLabel: "Quantity", removable: true,
          column: { table: "columns", defaultWidth: 52 },
        },
        {
          key: "col_info", name: "Information column",
          defaultLabel: "Part No. / Description / Pricing Information", removable: true,
          column: { table: "columns", defaultWidth: "*" },
        },
        {
          key: "col_each_weight", name: "Each-weight column", defaultLabel: "Each weight",
          removable: true, column: { table: "columns", defaultWidth: 66 },
        },
        {
          key: "col_amount", name: "Amount column", defaultLabel: "Total Lbs / Price",
          removable: true, column: { table: "columns", defaultWidth: 84 },
        },
      ],
    },
    {
      // lineBlock — ONE section: the grid row, Material and the PRICE rows interleave PER LINE
      // (unlike the invoice's document-level parts-then-prices split), so they cannot be two
      // independently ordered sections. All value slots are free-flow (widths live on
      // column_header). "Price per <unit>:" and "<n> or more:" are composed label + glue.
      key: "lines", name: "Quote lines and prices", hideable: true, reorderable: true,
      fields: [
        { key: "line_qty", name: "Quoted quantity", defaultLabel: "", removable: true },
        { key: "line_part", name: "Part identity", defaultLabel: "", removable: true },
        { key: "line_each_weight", name: "Each weight", defaultLabel: "", removable: true },
        { key: "line_total_lbs", name: "Total pounds", defaultLabel: "", removable: true },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
        { key: "price_heading", name: "Price heading", defaultLabel: "PRICE", removable: true },
        { key: "step_name", name: "Operation name", defaultLabel: "", removable: true },
        { key: "step_notes", name: "Quote notes line", defaultLabel: "", removable: true },
        { key: "price_amount", name: "Indicative amount", defaultLabel: "", removable: true },
        // The quote's builder prints these LOWERCASE ("Setup charge:") where the invoice's are
        // title-case — preserved exactly, per document.
        { key: "setup_charge", name: "Setup charge", defaultLabel: "Setup charge:", removable: true },
        { key: "price_per", name: "Per-unit price", defaultLabel: "Price per", removable: true },
        {
          key: "minimum_charge", name: "Minimum charge", defaultLabel: "Minimum charge:",
          removable: true,
        },
        { key: "breaks", name: "Quantity breaks", defaultLabel: "or more:", removable: true },
      ],
    },
    {
      // footerContent — ending statement + printable notes left, the signature block right
      // (rule, quotedBy's name, title — ruling 14).
      key: "closing", name: "Closing and signature", hideable: true, reorderable: true,
      fields: [
        { key: "ending_statement", name: "Ending statement", defaultLabel: "", removable: true },
        { key: "quote_notes", name: "Quote notes", defaultLabel: "", removable: true },
        { key: "signer_name", name: "Signer name", defaultLabel: "", removable: true },
        { key: "signer_title", name: "Signer title", defaultLabel: "", removable: true },
      ],
    },
    {
      // The liability fine print — renders the quote_liability_text text block full-width
      // beneath the closing; no fields of its own.
      key: "liability", name: "Liability text", hideable: true, reorderable: true, fields: [],
    },
  ],
  textBlocks: [
    { key: "quote_intro_text", name: "Intro line", defaultText: QUOTE_INTRO_TEXT_DEFAULT },
    {
      key: "quote_liability_text", name: "Liability text",
      defaultText: QUOTE_LIABILITY_TEXT_DEFAULT,
    },
  ],
  // `money4` prints unit/break prices at up to 4 decimals (the priceDecimals default — see the
  // file comment); `num()`/`qty()` group thousands; every printed date is `paddedDate`
  // ("06/30/2018"). No negative money ever prints, so negativeStyle is off this surface.
  formats: { priceDecimals: 4, thousandsSeparator: true, dateFormat: "MM/DD/YYYY" },
  // Today's builder: defaultStyle 9pt; "Quotation" (20pt) is the heading; 6.5pt is the liability
  // fine print.
  fonts: { family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 6.5 },
  // The builder's footer callback prints "Page: N of M" today — the one contract whose default
  // reproduces a page footer (see the file comment).
  pageFooter: true,
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(QUOTE_CONTRACT);

/**
 * The customer statement's template contract (spec §5.3), derived from
 * `src/server/pdf/statement.ts`'s `buildStatementDefinition` — sections are the builder's
 * stacked blocks in stack order, fields are its printed labels and data-bound slots.
 *
 * The aging labels come from `src/lib/ar-constants.ts` — REFERENCED, not duplicated: that
 * module is pure client-safe constants (the one sanctioned cross-import here), and the builder
 * itself prints from the same `AGING_BUCKET_LABELS`, so the strip's paper and this contract can
 * never drift apart. The finance-charge line and the aging strip are each their own section
 * (the Task 2 brief's explicit shape): the finance line only prints when a run assessed one,
 * and a template may hide either independently.
 */
import { AGING_BUCKET_LABELS } from "../ar-constants";
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

export const STATEMENT_CONTRACT: TemplateContract = {
  docType: "STATEMENT",
  name: "Statement",
  sections: [
    {
      // headerBlock — the "Statement" title over the company name, both centered. Unlike the
      // invoice, the title here is a LABEL (nothing kind-varies it), so it is overridable text.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "title", name: "Document title", defaultLabel: "Statement", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
      ],
    },
    {
      // identityBlock — customer / statement date / live bill-to left, the boxed Remit To right.
      key: "identity", name: "Statement identity", hideable: true, reorderable: true,
      fields: [
        { key: "customer", name: "Customer", defaultLabel: "Customer:", removable: true },
        {
          key: "statement_date", name: "Statement date", defaultLabel: "Statement Date:",
          removable: true,
        },
        { key: "bill_to", name: "Bill-to address", defaultLabel: "Bill To", removable: true },
        { key: "remit_to", name: "Remit-to box", defaultLabel: "Remit To", removable: true },
      ],
    },
    {
      // openItemsTable — widths ["auto", "auto", "auto", "*", "*"]: content-sized, the builder's
      // own hand-laid choice, NOT a per-column width knob (the traveler process-row precedent) —
      // so these fields carry no column membership and templates get label/visibility only.
      key: "open_items", name: "Open items", hideable: true, reorderable: true,
      fields: [
        { key: "document_no", name: "Document number", defaultLabel: "Document #", removable: true },
        { key: "date", name: "Document date", defaultLabel: "Date", removable: true },
        { key: "due_date", name: "Due date", defaultLabel: "Due Date", removable: true },
        { key: "original", name: "Original amount", defaultLabel: "Original", removable: true },
        { key: "open", name: "Open amount", defaultLabel: "Open", removable: true },
      ],
    },
    {
      // agingStrip — seven equal flex columns (the builder's Array(7).fill("*")): the five
      // buckets off AGING_BUCKET_LABELS, then Unapplied (owner ruling 8: never folded into a
      // bucket) and Net.
      key: "aging", name: "Aging strip", hideable: true, reorderable: true,
      fields: [
        {
          key: "aging_current", name: "Current bucket", defaultLabel: AGING_BUCKET_LABELS.CURRENT,
          removable: true, column: { table: "aging", defaultWidth: "*" },
        },
        {
          key: "aging_1_30", name: "1–30 bucket", defaultLabel: AGING_BUCKET_LABELS.D1_30,
          removable: true, column: { table: "aging", defaultWidth: "*" },
        },
        {
          key: "aging_31_60", name: "31–60 bucket", defaultLabel: AGING_BUCKET_LABELS.D31_60,
          removable: true, column: { table: "aging", defaultWidth: "*" },
        },
        {
          key: "aging_61_90", name: "61–90 bucket", defaultLabel: AGING_BUCKET_LABELS.D61_90,
          removable: true, column: { table: "aging", defaultWidth: "*" },
        },
        {
          key: "aging_90_plus", name: "90+ bucket", defaultLabel: AGING_BUCKET_LABELS.D90_PLUS,
          removable: true, column: { table: "aging", defaultWidth: "*" },
        },
        {
          key: "aging_unapplied", name: "Unapplied", defaultLabel: "Unapplied", removable: true,
          column: { table: "aging", defaultWidth: "*" },
        },
        {
          key: "aging_net", name: "Net", defaultLabel: "Net", removable: true,
          column: { table: "aging", defaultWidth: "*" },
        },
      ],
    },
    {
      // The finance-charge line — its own section (see the file comment); prints only when the
      // statement run assessed one.
      //
      // #162 (owner ruling 2026-08-19): the figure is INFORMATIONAL — nothing is posted, nothing
      // ages, and `statements.ts` returns `totalDue: aging.net`, which excludes it. The line
      // therefore prints directly above a Total Due that does not contain it, and the LABEL is
      // what has to say so; "Finance Charge:" alone read as a levied charge, and a customer
      // paying the Total Due below it would have been right to.
      //
      // FIXED IN THE LABEL, DELIBERATELY NOT BY MOVING THIS SECTION BELOW `total`. A stored
      // config renders in ITS OWN stored section order, so a re-order here would reach the
      // default template and silently miss every already-published version; a `defaultLabel` is
      // a null-sentinel in every stored config and re-resolves against this contract at every
      // print, so it reaches all of them alike (#103 — see `types.ts`'s evolution header, which
      // names "changing an existing contract default" as NOT rendering-neutral). That is the
      // whole reason this landed before acceptance: nothing has published a custom statement
      // template yet, so the relabel changes no paper anyone has already designed. Once one has,
      // this same edit would silently relabel their published version too.
      key: "finance_charge", name: "Finance charge", hideable: true, reorderable: true,
      fields: [
        {
          key: "finance_charge", name: "Finance charge",
          // Sized to `totalLine`'s 200pt label column at 10pt (measured: 174pt Roboto, 175pt
          // Liberation Sans, 161pt Liberation Serif) so it does not wrap on the three
          // proportional families; "Total Due" is referenced in lower case because that label is
          // itself overridable.
          defaultLabel: "Finance Charge (not billed, not in total):",
          removable: true,
        },
      ],
    },
    {
      // The bold Total Due line.
      key: "total", name: "Total due", hideable: true, reorderable: true,
      fields: [
        { key: "total_due", name: "Total due", defaultLabel: "Total Due:", removable: true },
      ],
    },
  ],
  textBlocks: [], // the statement carries no standing paragraph
  // `money()` is the invoice's own (SIGN_AFTER_SYMBOL, 2 decimals, grouped thousands) — a credit
  // or on-account payment row prints negative money, so the style knob is on this surface;
  // `longDate` prints "July 29, 2026" ("MMMM D, YYYY", the full-month token — Task 13 maps it).
  formats: {
    negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
    dateFormat: "MMMM D, YYYY",
  },
  // Today's builder: defaultStyle 9pt; "Statement" (20pt) is the heading. No fine print smaller
  // than the base ever prints, so the small role starts pinned to the base size until a
  // conversion task gives it a slot.
  fonts: { family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 9 },
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(STATEMENT_CONTRACT);

/**
 * The certification's template contract (spec §5.3), derived from `src/server/pdf/cert.ts`'s
 * `buildCertDefinition` — sections are the builder's stacked blocks in stack order, fields are
 * its printed labels and data-bound slots.
 *
 * INTERNAL NO-PRINT NOTES ARE NOT HERE, BY DESIGN (spec §5.6: "not in the contract at all —
 * nothing to lock; the field list never offers them"). The same omission-is-the-enforcement
 * shape covers §3.21's other exclusions: `CertPdfData` carries no min/max/pass-fail/override,
 * so no field below could bind one — a template can only re-arrange what the data layer already
 * collects, and the cert's data layer deliberately never collects those.
 *
 * The signature block (§3.11) is a section; its rendering semantics — image over the rule, or
 * the typed name when no image is on file — stay the builder's (Task 11 consumes; this file
 * only declares the printed pieces).
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

/**
 * `cert_statement`'s code default, copied VERBATIM from `src/server/settings.ts`'s
 * `CERT_STATEMENT_DEFAULT` — copied, not imported: importing the server module would drag
 * Prisma into the client bundle (the SESSION_COOKIE keep-in-sync-by-hand rule). The setting
 * itself retires into template content later this phase (spec §8); until then the two literals
 * must match.
 */
const CERT_STATEMENT_TEXT_DEFAULT =
  "We certify that the listed Parts / Materials were heat treated in accordance with " +
  "American Heat Treating - Alabama, LLC. Quality Assurance Manual 08/01/22 and customer " +
  "requirements as follows:";

export const CERT_CONTRACT: TemplateContract = {
  docType: "CERT",
  name: "Certification",
  sections: [
    {
      // headerBlock — company name over the big "Certification" title, centered; the Order No. /
      // Date / Entry Date column right.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "title", name: "Document title", defaultLabel: "Certification", removable: true },
        { key: "order_no", name: "Order number", defaultLabel: "Order No.:", removable: true },
        { key: "print_date", name: "Print date", defaultLabel: "Date:", removable: true },
        { key: "entry_date", name: "Entry date", defaultLabel: "Entry Date:", removable: true },
      ],
    },
    {
      // partiesBlock — the "To:" address stack left (one bound blob, the ticket's party-box
      // shape); PO / Packing List / Material right.
      key: "parties", name: "To / order fields", hideable: true, reorderable: true,
      fields: [
        { key: "to", name: "To box", defaultLabel: "To:", removable: true },
        {
          key: "po_number", name: "Purchase order", defaultLabel: "Purchase Order No.:",
          removable: true,
        },
        {
          key: "packing_list_no", name: "Packing list number", defaultLabel: "Packing List No.:",
          removable: true,
        },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
      ],
    },
    {
      // partsTable — widths [70, "*", 90]. The part label's double spacing is the builder's own.
      key: "parts", name: "Part lines", hideable: true, reorderable: true,
      fields: [
        {
          key: "part_qty", name: "Quantity", defaultLabel: "Quantity", removable: true,
          column: { table: "parts", defaultWidth: 70 },
        },
        {
          key: "part_identity", name: "Part identity",
          defaultLabel: "Part Number  /  Part Name  /  Part Description", removable: true,
          column: { table: "parts", defaultWidth: "*" },
        },
        {
          key: "part_pounds", name: "Pounds", defaultLabel: "Pounds", removable: true,
          column: { table: "parts", defaultWidth: 90 },
        },
      ],
    },
    {
      // The §3.21 certification statement — renders the cert_statement text block; no fields of
      // its own (the shipper liability precedent).
      key: "statement", name: "Certification statement", hideable: true, reorderable: true,
      fields: [],
    },
    {
      // requirementSection — per requirement the specification/scale line and the bare
      // three-across readings grid; a MULTI-part cert heads each frozen line group with its part
      // identity (ruling 27). All three are data-bound slots, label-free.
      key: "requirements", name: "Requirements and readings", hideable: true, reorderable: true,
      fields: [
        {
          key: "part_heading", name: "Multi-part line heading", defaultLabel: "",
          removable: true,
        },
        { key: "spec_line", name: "Specification line", defaultLabel: "", removable: true },
        { key: "readings", name: "Readings grid", defaultLabel: "", removable: true },
      ],
    },
    {
      // serialBlocks — the builder composes "Serial Numbers — {part}:" per part; the label root
      // is the overridable part, the em-dash glue stays the builder's.
      key: "serials", name: "Serial numbers", hideable: true, reorderable: true,
      fields: [
        { key: "serials", name: "Serial numbers", defaultLabel: "Serial Numbers", removable: true },
      ],
    },
    {
      // The cert's PRINTABLE freeform text (spec §7.4's sanctioned half — never internalNotes).
      key: "freeform", name: "Freeform text", hideable: true, reorderable: true,
      fields: [
        { key: "freeform", name: "Freeform text", defaultLabel: "", removable: true },
      ],
    },
    {
      // signatureBlock (§3.11) — the printed pieces, bottom right; rendering semantics are the
      // builder's (see the file comment).
      key: "signature", name: "Signature block", hideable: true, reorderable: true,
      fields: [
        { key: "signature_mark", name: "Signature mark", defaultLabel: "", removable: true },
        { key: "signer_name", name: "Signer name", defaultLabel: "", removable: true },
        { key: "signer_title", name: "Signer title", defaultLabel: "", removable: true },
        { key: "signer_company", name: "Signer company", defaultLabel: "", removable: true },
      ],
    },
    {
      // footerBlock — the static per-page strip: company address left, phone right.
      key: "footer", name: "Page footer strip", hideable: true, reorderable: true,
      fields: [
        { key: "footer_address", name: "Company address", defaultLabel: "", removable: true },
        { key: "footer_phone", name: "Company phone", defaultLabel: "Phone:", removable: true },
      ],
    },
  ],
  textBlocks: [
    {
      key: "cert_statement", name: "Certification statement",
      defaultText: CERT_STATEMENT_TEXT_DEFAULT,
    },
  ],
  // `num()` groups thousands; the header's Date / Entry Date print `paddedDate` ("08/03/2026").
  // No money ever prints on a cert, so the price knobs are off this document's surface; the
  // readings' own 1-to-4-decimal rendering is data precision, not a knob.
  formats: { thousandsSeparator: true, dateFormat: "MM/DD/YYYY" },
  // Today's builder: defaultStyle 9pt; "Certification" (19pt) is the heading; 7.5pt is the
  // footer strip's fine print.
  fonts: { family: "Roboto", baseSize: 9, headingSize: 19, smallSize: 7.5 },
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(CERT_CONTRACT);

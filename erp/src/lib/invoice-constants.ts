// Pure constants only — no server-only imports. Safe to import from client components.
// The arrays must list the same members in the same order as the Prisma enums in Task 2.
export const INVOICE_KINDS = ["INVOICE", "CREDIT"] as const;
export type InvoiceKindValue = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Record<InvoiceKindValue, string> = {
  INVOICE: "Invoice",
  CREDIT: "Credit",
};

/**
 * The paper's own document number: the credit number for a CREDIT, otherwise the prefix + order
 * number (P5A §10; a blank prefix prints the bare order number). The prefix is a print-time setting
 * — `invoice_number_prefix`, read by the caller rather than stored — so changing it re-labels drafts
 * consistently.
 *
 * Lives here, in the client-safe constants, because three server modules need the identical string
 * and had begun keeping copies: `invoices.ts` (the invoice detail), `statements.ts` (a statement
 * line) and `gl-export.ts` (naming the invoice behind a readiness gap, #89). Two of those copies
 * carried a comment saying they were duplicates; a third was the point to stop.
 */
export function invoiceDocumentNumber(
  kind: InvoiceKindValue, creditNumber: number | null, orderNumber: number, prefix: string,
): string {
  if (kind === "CREDIT") return String(creditNumber);
  return prefix === "" ? String(orderNumber) : `${prefix} - ${orderNumber}`;
}

export const INVOICE_STATUSES = ["DRAFT", "FINALIZED"] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  DRAFT: "Draft",
  FINALIZED: "Finalized",
};

export const INVOICE_LINE_KINDS = ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"] as const;
export type InvoiceLineKindValue = (typeof INVOICE_LINE_KINDS)[number];
export const INVOICE_LINE_KIND_LABELS: Record<InvoiceLineKindValue, string> = {
  PART: "Part",
  OPERATION: "Operation",
  SURCHARGE: "Surcharge",
  FREIGHT: "Freight",
  CHARGE: "Charge",
  CERT: "Certification",
  TAX: "Sales tax",
};

// QUOTE (Phase 6): the "Quote #N" display an invoice line actually shows comes from the line's
// own frozen `sourceQuoteNumber`, never from this generic label.
export const PRICE_SOURCES = ["PART_PRICE", "MANUAL", "QUOTE"] as const;
export type PriceSourceValue = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceValue, string> = {
  PART_PRICE: "Part price",
  MANUAL: "Manual",
  QUOTE: "Quote",
};

export const SURCHARGE_KINDS = ["PERCENT", "FLAT"] as const;
export type SurchargeKindValue = (typeof SURCHARGE_KINDS)[number];
export const SURCHARGE_KIND_LABELS: Record<SurchargeKindValue, string> = {
  PERCENT: "Percent",
  FLAT: "Flat amount",
};

export const SURCHARGE_SCOPES = ["ALL", "INCLUDE", "EXCLUDE"] as const;
export type SurchargeScopeValue = (typeof SURCHARGE_SCOPES)[number];
export const SURCHARGE_SCOPE_LABELS: Record<SurchargeScopeValue, string> = {
  ALL: "All operations",
  INCLUDE: "Only these operations",
  EXCLUDE: "All except these",
};

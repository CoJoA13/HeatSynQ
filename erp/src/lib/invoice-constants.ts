// Pure constants only — no server-only imports. Safe to import from client components.
// The arrays must list the same members in the same order as the Prisma enums in Task 2.
export const INVOICE_KINDS = ["INVOICE", "CREDIT"] as const;
export type InvoiceKindValue = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Record<InvoiceKindValue, string> = {
  INVOICE: "Invoice",
  CREDIT: "Credit",
};

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

export const PRICE_SOURCES = ["PART_PRICE", "MANUAL"] as const;
export type PriceSourceValue = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABELS: Record<PriceSourceValue, string> = {
  PART_PRICE: "Part price",
  MANUAL: "Manual",
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

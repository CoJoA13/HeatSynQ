export type StatusTone = "success" | "info" | "warn" | "danger" | "neutral";

export function toneClasses(tone: StatusTone): string {
  return `text-status-${tone} bg-status-${tone}-tint`;
}

export const QUOTE_STATUSES = ["draft","sent","approve","won","lost"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const ORDER_STATUSES = ["received","scheduled","in_process","on_hold","ready_to_ship","shipped"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const INVOICE_STATUSES = ["to_bill","sent","paid"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const CERT_STATUSES = ["pending","released"] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];

export const CUSTOMER_STATUSES = ["active","hold","dormant"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const PRICING_BASES = ["per_lb","per_lot","per_piece","flat"] as const;
export type PricingBasis = (typeof PRICING_BASES)[number];

export const ROLE_KEYS = ["manager","sales","office"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

type Meta<T extends string> = Record<T, { label: string; tone: StatusTone }>;

export const quoteStatusMeta: Meta<QuoteStatus> = {
  draft: { label: "Draft", tone: "warn" },
  sent: { label: "Sent", tone: "info" },
  approve: { label: "Approve", tone: "warn" },
  won: { label: "Won", tone: "success" },
  lost: { label: "Lost", tone: "neutral" },
};
export const orderStatusMeta: Meta<OrderStatus> = {
  received: { label: "Received", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "neutral" },
  in_process: { label: "In Process", tone: "info" },
  on_hold: { label: "On Hold", tone: "warn" },
  ready_to_ship: { label: "Ready to ship", tone: "success" },
  shipped: { label: "Shipped", tone: "success" },
};
export const invoiceStatusMeta: Meta<InvoiceStatus> = {
  to_bill: { label: "To bill", tone: "warn" },
  sent: { label: "Sent", tone: "info" },
  paid: { label: "Paid", tone: "success" },
};
export const certStatusMeta: Meta<CertStatus> = {
  pending: { label: "Pending", tone: "warn" },
  released: { label: "Released", tone: "success" },
};
export const customerStatusMeta: Meta<CustomerStatus> = {
  active: { label: "Active", tone: "success" },
  hold: { label: "Hold", tone: "warn" },
  dormant: { label: "Dormant", tone: "neutral" },
};
export const basisLabel: Record<PricingBasis, string> = {
  per_lb: "per lb", per_lot: "per lot", per_piece: "per piece", flat: "flat",
};

export const AREAS = ["received","rack","in_process","wash","final_inspect","available_to_ship","shipped"] as const;
export type AreaId = (typeof AREAS)[number];
export const areaMeta: Record<AreaId, { label: string; tone: StatusTone }> = {
  received: { label: "Received", tone: "neutral" },
  rack: { label: "Rack", tone: "neutral" },
  in_process: { label: "In Process", tone: "info" },
  wash: { label: "Wash", tone: "info" },
  final_inspect: { label: "Final Inspect", tone: "warn" },
  available_to_ship: { label: "Available to Ship", tone: "success" },
  shipped: { label: "Shipped", tone: "success" },
};

export const ORDER_STEP_STATES = ["pending","in_process","done"] as const;
export type OrderStepState = (typeof ORDER_STEP_STATES)[number];
export const orderStepStateMeta: Record<OrderStepState, { label: string; tone: StatusTone }> = {
  pending: { label: "Pending", tone: "neutral" },
  in_process: { label: "In process", tone: "info" },
  done: { label: "Done", tone: "success" },
};

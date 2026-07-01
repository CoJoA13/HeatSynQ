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

export const EQUIPMENT_KINDS = ["batch_iq","temper","vacuum","pit","continuous","wash","inspect"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export const equipmentKindMeta: Record<EquipmentKind, { label: string }> = {
  batch_iq:   { label: "Batch IQ furnace" },
  temper:     { label: "Temper oven" },
  vacuum:     { label: "Vacuum furnace" },
  pit:        { label: "Pit furnace" },
  continuous: { label: "Continuous belt" },
  wash:       { label: "Wash station" },
  inspect:    { label: "Inspection / Lab" },
};

export const EQUIPMENT = [
  { id: "eq-iq-1",      name: "Batch IQ #1",        kind: "batch_iq" },
  { id: "eq-iq-2",      name: "Batch IQ #2",        kind: "batch_iq" },
  { id: "eq-iq-3",      name: "Batch IQ #3",        kind: "batch_iq" },
  { id: "eq-temper-1",  name: "Temper Oven #1",     kind: "temper" },
  { id: "eq-temper-2",  name: "Temper Oven #2",     kind: "temper" },
  { id: "eq-vac-1",     name: "Vacuum Furnace #1",  kind: "vacuum" },
  { id: "eq-pit-1",     name: "Pit Furnace #1",     kind: "pit" },
  { id: "eq-belt-1",    name: "Continuous Belt #1", kind: "continuous" },
  { id: "eq-wash-1",    name: "Wash Station",       kind: "wash" },
  { id: "eq-inspect-1", name: "Inspection",         kind: "inspect" },
] as const satisfies readonly { id: string; name: string; kind: EquipmentKind }[];
export type EquipmentDef = (typeof EQUIPMENT)[number];
export type EquipmentId = EquipmentDef["id"];

export const EQUIPMENT_STATES = ["running","idle","on_hold"] as const;
export type EquipmentState = (typeof EQUIPMENT_STATES)[number];
export const equipmentStateMeta: Record<EquipmentState, { label: string; tone: StatusTone }> = {
  running: { label: "Running", tone: "success" },
  idle:    { label: "Idle",    tone: "neutral" },
  on_hold: { label: "On hold", tone: "warn" },
};

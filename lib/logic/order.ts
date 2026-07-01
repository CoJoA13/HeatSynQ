import type {
  Quote, Part, ProcessMaster, Customer, WorkOrder, OrderStatus, Certification, ActivityEntry,
} from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { quoteTotalCents, quoteSubtotalCents, lineAmountCents } from "./pricing";

export type NewWorkOrder = CreateInput<WorkOrder>;

export function createOrderFromQuote(
  quote: Quote,
  ctx: { partsById: Record<string, Part>; processMastersById: Record<string, ProcessMaster>; customer: Customer },
): NewWorkOrder {
  const firstPart = ctx.partsById[quote.parts[0]?.partId];
  const pm = firstPart?.processMasterId ? ctx.processMastersById[firstPart.processMasterId] : undefined;
  const processNames = Array.from(new Set(quote.parts.flatMap((p) => p.lines.map((l) => l.process))))
    .filter((p) => p.toLowerCase() !== "certification");

  // Cert requirement: customer default cert spec, else fall back to any quoted part's spec.
  const partSpecId = quote.parts.map((qp) => ctx.partsById[qp.partId]?.specificationId).find((s) => s != null) ?? null;
  const certSpecId = ctx.customer.defaultCertSpecId ?? partSpecId;

  // Carry EVERY quoted part's traveler: dedupe process masters (preserve order), concat steps, renumber 1..N.
  const pmIds = [...new Set(quote.parts.map((qp) => ctx.partsById[qp.partId]?.processMasterId).filter((id): id is string => id != null))];
  const steps = pmIds.flatMap((id) => ctx.processMastersById[id]?.steps ?? []).map((s, i) => ({ ...s, n: i + 1 }));

  const total = quoteTotalCents(quote);
  const subtotal = quoteSubtotalCents(quote.parts);
  const pricing = quote.parts.flatMap((qp) =>
    qp.lines.map((l) => ({ process: l.process, detail: detailFor(l.basis, l.qtyOrWeight), amountCents: lineAmountCents(l) })),
  );
  // If the quote is discounted, add a negative Discount row so pricing lines sum to orderValue.
  if (total !== subtotal) pricing.push({ process: "Discount", detail: "", amountCents: total - subtotal });

  return {
    customerId: quote.customerId,
    customerPO: quote.customerPO,
    quoteId: quote.id,
    processSummary: processNames.join(" + "),
    processMasterId: pm?.id ?? null,
    status: "received",
    orderedDate: quote.date,
    due: quote.requiredBy ?? quote.date,
    certifyRequired: certSpecId != null,
    certSpecId,
    orderValueCents: total,
    progressPct: 0,
    lines: quote.parts.map((qp) => {
      const part = ctx.partsById[qp.partId];
      return { id: qp.id, partId: qp.partId, description: part?.description ?? "", quantity: qp.quantity, spec: part?.hardness ?? "" };
    }),
    pricing,
    steps,
    activity: [{ at: quote.date, actor: "System", message: `Order created from ${quote.number}` }],
  };
}

function detailFor(basis: string, qty: number): string {
  if (basis === "per_lb") return `${qty} lb`;
  if (basis === "per_piece") return `${qty} pc`;
  return "";
}

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  received: ["scheduled", "on_hold"],
  scheduled: ["in_process", "on_hold"],
  in_process: ["ready_to_ship", "on_hold"],
  on_hold: ["received", "scheduled", "in_process"],
  ready_to_ship: ["shipped", "on_hold"],
  shipped: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function createCertForOrder(order: WorkOrder, customer: Customer): CreateInput<Certification> {
  return {
    customerId: order.customerId,
    workOrderId: order.id,
    specificationId: order.certSpecId,
    type: order.processSummary,
    status: "pending",
    copies: customer.defaultCertCopies,
  };
}

export function activityEntry(actor: string, message: string, at: string): ActivityEntry {
  return { actor, message, at };
}

export function canShipOrder(order: WorkOrder, cert: Certification | null): { ok: boolean; reason?: string } {
  if (!order.certifyRequired) return { ok: true };
  if (cert?.status === "released") return { ok: true };
  return { ok: false, reason: "Certification must be released before ship" };
}

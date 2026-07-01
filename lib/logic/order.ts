import type {
  Quote, Part, ProcessMaster, Customer, WorkOrder, OrderStatus, Certification, ActivityEntry, OrderStep,
} from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { quoteTotalCents, quoteSubtotalCents, lineAmountCents } from "./pricing";
import { areaForOp } from "./tracking";

export type NewWorkOrder = CreateInput<WorkOrder>;

export function createOrderFromQuote(
  quote: Quote,
  ctx: { partsById: Record<string, Part>; processMastersById: Record<string, ProcessMaster>; customer: Customer; nowIso: string },
): NewWorkOrder {
  const firstPart = ctx.partsById[quote.parts[0]?.partId];
  const pm = firstPart?.processMasterId ? ctx.processMastersById[firstPart.processMasterId] : undefined;
  const processNames = Array.from(new Set(quote.parts.flatMap((p) => p.lines.map((l) => l.process))))
    .filter((p) => p.toLowerCase() !== "certification");

  // Cert requirement: customer default cert spec, else fall back to any quoted part's spec.
  const partSpecId = quote.parts.map((qp) => ctx.partsById[qp.partId]?.specificationId).find((s) => s != null) ?? null;
  const certSpecId = ctx.customer.defaultCertSpecId ?? partSpecId; // may be null
  // An explicit Certification process line forces cert requirement even when no spec is on file.
  const hasCertLine = quote.parts.some((p) => p.lines.some((l) => l.process.toLowerCase() === "certification"));

  // Carry EVERY quoted part's traveler: dedupe process masters (preserve order), concat steps, renumber 1..N.
  const pmIds = [...new Set(quote.parts.map((qp) => ctx.partsById[qp.partId]?.processMasterId).filter((id): id is string => id != null))];
  const steps: OrderStep[] = pmIds
    .flatMap((id) => ctx.processMastersById[id]?.steps ?? [])
    .map((s, i) => ({
      ...s, n: i + 1, areaId: areaForOp(s.op), state: "pending",
      operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null,
    }));

  const trackableCount = steps.filter((s) => s.track !== "none").length;

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
    status: trackableCount === 0 ? "ready_to_ship" : "received",
    orderedDate: quote.date,
    due: quote.requiredBy ?? ctx.nowIso,
    certifyRequired: certSpecId != null || hasCertLine,
    certSpecId,
    orderValueCents: total,
    progressPct: trackableCount === 0 ? 100 : 0,
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
  on_hold: ["received", "scheduled", "in_process", "ready_to_ship"],
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

export function canShipOrder(order: WorkOrder, cert: Certification | null, customer?: Customer | null): { ok: boolean; reason?: string } {
  if (customer?.status === "hold") return { ok: false, reason: "Customer on credit hold — shipment blocked" };
  if (!order.certifyRequired) return { ok: true };
  if (cert?.status === "released") return { ok: true };
  return { ok: false, reason: "Certification must be released before ship" };
}

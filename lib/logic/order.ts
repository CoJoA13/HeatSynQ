import type {
  Quote, Part, ProcessMaster, Customer, WorkOrder, OrderStatus, Certification,
} from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { quoteTotalCents, lineAmountCents } from "./pricing";

export type NewWorkOrder = CreateInput<WorkOrder>;

export function createOrderFromQuote(
  quote: Quote,
  ctx: { partsById: Record<string, Part>; processMastersById: Record<string, ProcessMaster>; customer: Customer },
): NewWorkOrder {
  const firstPart = ctx.partsById[quote.parts[0]?.partId];
  const pm = firstPart?.processMasterId ? ctx.processMastersById[firstPart.processMasterId] : undefined;
  const processNames = Array.from(new Set(quote.parts.flatMap((p) => p.lines.map((l) => l.process))))
    .filter((p) => p.toLowerCase() !== "certification");

  return {
    customerId: quote.customerId,
    customerPO: quote.customerPO,
    quoteId: quote.id,
    processSummary: processNames.join(" + "),
    processMasterId: pm?.id ?? null,
    status: "received",
    orderedDate: quote.date,
    due: quote.requiredBy ?? quote.date,
    certifyRequired: ctx.customer.defaultCertSpecId != null,
    certSpecId: ctx.customer.defaultCertSpecId,
    orderValueCents: quoteTotalCents(quote),
    progressPct: 0,
    lines: quote.parts.map((qp) => {
      const part = ctx.partsById[qp.partId];
      return { id: qp.id, partId: qp.partId, description: part?.description ?? "", quantity: qp.quantity, spec: part?.hardness ?? "" };
    }),
    pricing: quote.parts.flatMap((qp) =>
      qp.lines.map((l) => ({ process: l.process, detail: detailFor(l.basis, l.qtyOrWeight), amountCents: lineAmountCents(l) })),
    ),
    steps: pm?.steps ?? [],
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

export function canShipOrder(order: WorkOrder, cert: Certification | null): { ok: boolean; reason?: string } {
  if (!order.certifyRequired) return { ok: true };
  if (cert?.status === "released") return { ok: true };
  return { ok: false, reason: "Certification must be released before ship" };
}

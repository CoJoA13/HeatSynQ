import { z } from "zod";
import { Prisma, type Order } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { claimOrder } from "./order-locks";
import { hasReceivableActivity } from "./invoice-guards";
import { assertPeriodOpen } from "./period-locks";
import { currentActor } from "./context";
import { getBillingConfig, type BillingConfigRow } from "./billing-config";
import { listSurcharges, type SurchargeRow } from "./surcharges";
import { listPartPrices } from "./part-prices";
import { listAddresses, type AddressRow } from "./customer-addresses";
import { getSetting, allocateNumber } from "./settings";
import { isDuplicateClientRequestId } from "./orders";
import { shippedTotals, recomputeOrderStatus } from "./ship-ledger";
import {
  priceOrder,
  type PricingInput, type OrderLineInput, type SurchargeInput, type ChargeInput, type GlRef,
  type PricingResult, type ComputedLine,
} from "./pricing";
import { parseDateOnly, formatDateOnly, todayDateOnly, addDays } from "../lib/business-days";
import {
  INVOICE_LINE_KINDS, PRICE_SOURCES,
  type InvoiceKindValue, type InvoiceStatusValue, type InvoiceLineKindValue, type PriceSourceValue,
} from "../lib/invoice-constants";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "../lib/part-constants";
import { renderPdf } from "./pdf/render";
import { buildInvoiceDefinition, type InvoicePdfData, type InvoiceAmountRow } from "./pdf/invoice";
import { storeDocument, assertPrintable } from "./documents";

// -------------------------------------------------------------------------------------------
// Task 11 (P5A §5.4/§5.7/§10): where pricing becomes a customer-facing invoice. `listInvoice
// candidates` finds fully-shipped, not-yet-invoiced orders; `createInvoice` snapshots the shipped
// quantities and the resolved prices into a DRAFT invoice a later task finalizes and locks.
//
// The math lives entirely in `priceOrder` (pricing.ts, the pure engine). This file's job is to
// assemble that engine's input from live data — and to close the three seams the engine
// deliberately left open, each of which is money reaching (or not reaching) the right place:
//
//   1. CHARGE lines arrive from the engine with a null GL account (`ChargeInput` carries no
//      `GlRef` — the pure engine cannot reach `BillingConfig`). `BillingConfig.otherChargeGlAccount
//      Id` is assigned to CHARGE lines HERE, or a whole class of charge lines posts to no account
//      and the GL export is silently incomplete. See `mapLine`.
//   2. `SurchargeRow.glAccountName` is `string | null`, but `InvoiceLine.glAccountName` is NOT NULL
//      (`String @default("")`). The `?? ""` normalization is done deliberately at the surcharge
//      seam in `buildSurcharges`.
//   3. A line whose net shipped total is zero is NEVER handed to the engine — the engine bills
//      `max(extended, minimumCharge) + setupCharge`, so a zero-net line would bill the FULL minimum
//      plus setup for no work. Filtered in `buildPricingInput`.
// -------------------------------------------------------------------------------------------

// Either the top-level client or a `tx` — the `readShipperDetail`/`readDetail` precedent: this
// module's read side serves both `getInvoice` and the tail of the create transaction.
type Db = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/** `parseDateOnly` at the service boundary — the `shippers.ts`/`orders.ts` `parseDate` precedent. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

export type InvoiceLineDetail = {
  id: string; position: number; kind: InvoiceLineKindValue; parentLineId: string | null;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: PricePerValue | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: PriceSourceValue | null; needsPrice: boolean;
  amount: number;
};

export type InvoiceDetail = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  sourceInvoiceId: string | null; creditNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; dueDate: string | null; poNumber: string; termsName: string;
  billTo: string; shipTo: string; materialName: string; processNames: string;
  taxRate: number | null;
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
  finalizedAt: string | null; deletedAt: string | null;
  lines: InvoiceLineDetail[];
};

export type InvoiceCandidate = {
  orderId: string; orderNumber: number; customerCode: string; customerName: string;
  poNumber: string; lastShipDate: string | null;
};

export type InvoiceCreateResult = { invoice: InvoiceDetail; warnings: string[]; deduped: boolean };

// -------------------------------------------------------------------------------------------
// Read side — `readShipperDetail`'s shape (shippers.ts:334-348).
// -------------------------------------------------------------------------------------------

const DETAIL_INCLUDE = {
  // `terms` is read here (not a second query) so `finalizeInvoiceInTx` can compute `dueDate` off the
  // SAME row this transaction already claimed via `claimInvoiceRow` — no new lock (Task 3/§4.3).
  customer: { select: { code: true, name: true, terms: { select: { netDays: true } } } },
  order: { select: { orderNumber: true } },
  lines: { orderBy: { position: "asc" } },
} satisfies Prisma.InvoiceInclude;

type DetailRow = Prisma.InvoiceGetPayload<{ include: typeof DETAIL_INCLUDE }>;
type LineRow = DetailRow["lines"][number];

/** An invoice line reads its snapshot columns UNCONDITIONALLY (§5.4) — unlike a shipper line's
 *  live-join-first `toDetail`. An invoice is frozen paper: ruling 24's refinement says a frozen
 *  document reads its own snapshot, never a live join that a later part rename could drift. */
function toLineDetail(l: LineRow): InvoiceLineDetail {
  return {
    id: l.id, position: l.position, kind: l.kind, parentLineId: l.parentLineId,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: num(l.weight), eachWeight: num(l.eachWeight),
    pricePer: l.pricePer, unitPrice: num(l.unitPrice),
    setupCharge: num(l.setupCharge), minimumCharge: num(l.minimumCharge),
    breakThreshold: num(l.breakThreshold), minimumApplied: l.minimumApplied,
    rate: num(l.rate), priceSource: l.priceSource, needsPrice: l.needsPrice,
    amount: l.amount.toNumber(),
  };
}

/** The paper's "Invoice No." — the credit number for a CREDIT, otherwise the prefix + order number
 *  (P5A §10; a blank prefix prints the bare order number). The prefix is a print-time setting, read
 *  here rather than stored, so changing it re-labels drafts consistently. */
function documentNumber(kind: InvoiceKindValue, creditNumber: number | null, orderNumber: number, prefix: string): string {
  if (kind === "CREDIT") return String(creditNumber);
  return prefix === "" ? String(orderNumber) : `${prefix} - ${orderNumber}`;
}

function toInvoiceDetail(row: DetailRow, prefix: string): InvoiceDetail {
  return {
    id: row.id, kind: row.kind, status: row.status,
    orderId: row.orderId, orderNumber: row.order.orderNumber,
    documentNumber: documentNumber(row.kind, row.creditNumber, row.order.orderNumber, prefix),
    sourceInvoiceId: row.sourceInvoiceId, creditNumber: row.creditNumber,
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    invoiceDate: formatDateOnly(row.invoiceDate),
    dueDate: row.dueDate ? formatDateOnly(row.dueDate) : null,
    poNumber: row.poNumber, termsName: row.termsName,
    billTo: row.billTo, shipTo: row.shipTo,
    materialName: row.materialName, processNames: row.processNames,
    taxRate: num(row.taxRate),
    subtotal: row.subtotal.toNumber(), surchargeTotal: row.surchargeTotal.toNumber(),
    chargeTotal: row.chargeTotal.toNumber(), certTotal: row.certTotal.toNumber(),
    freightTotal: row.freightTotal.toNumber(), taxTotal: row.taxTotal.toNumber(),
    total: row.total.toNumber(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    lines: row.lines.map(toLineDetail),
  };
}

/** Exported for callers that need the full detail on a `tx` — the `readShipperDetail` precedent.
 *  Never filters `deletedAt`: a discarded draft stays readable (the voided-order `readDetail`
 *  precedent). */
export async function readInvoiceDetail(db: Db, id: string): Promise<InvoiceDetail> {
  const row = await db.invoice.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!row) throw new HttpError(404, "Invoice not found");
  const prefix = await getSetting("invoice_number_prefix", db);
  return toInvoiceDetail(row, prefix);
}

export async function getInvoice(id: string): Promise<InvoiceDetail> {
  return readInvoiceDetail(prisma, id);
}

// -------------------------------------------------------------------------------------------
// Candidates — orders at SHIPPED with no live INVOICE (§5.4).
// -------------------------------------------------------------------------------------------

export async function listInvoiceCandidates(
  filter: { customerId?: string; from?: string; to?: string },
): Promise<InvoiceCandidate[]> {
  const from = filter.from ? parseDate(filter.from, "From date") : undefined;
  const to = filter.to ? parseDate(filter.to, "To date") : undefined;
  const shipDateWindow = from || to
    ? { shipDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
    : undefined;

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: "SHIPPED",
      // The live partial-unique guard's own predicate: no live invoice (a CREDIT does not count).
      invoices: { none: { kind: "INVOICE", deletedAt: null } },
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(shipDateWindow ? { shipperOrders: { some: { shipper: { deletedAt: null, ...shipDateWindow } } } } : {}),
    },
    orderBy: { orderNumber: "asc" },
    select: {
      id: true, orderNumber: true, poNumber: true,
      customer: { select: { code: true, name: true } },
      // Every LIVE shipment's ship date — `lastShipDate` is the max across them.
      shipperOrders: {
        where: { shipper: { deletedAt: null } },
        select: { shipper: { select: { shipDate: true } } },
      },
    },
  });

  return orders.map((o) => {
    const times = o.shipperOrders.map((so) => so.shipper.shipDate.getTime());
    const last = times.length ? new Date(Math.max(...times)) : null;
    return {
      orderId: o.id, orderNumber: o.orderNumber,
      customerCode: o.customer.code, customerName: o.customer.name,
      poNumber: o.poNumber, lastShipDate: last ? formatDateOnly(last) : null,
    };
  });
}

// -------------------------------------------------------------------------------------------
// List — every invoice/credit (Task 16, the routes task: the worklist's second section, and the
// order hub's Invoices section, both need the actual documents rather than the candidates above).
// Row shape stays a thin summary — `getInvoice`/`readInvoiceDetail` is still the source of the
// full detail a single page reads — the `listShippers`/`ShipperRow` precedent (shippers.ts).
// -------------------------------------------------------------------------------------------

export type InvoiceListRow = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; total: number; finalizedAt: string | null; deletedAt: string | null;
};

export type InvoiceFilter = { customerId?: string; status?: InvoiceStatusValue; from?: string; to?: string };

const LIST_SELECT = {
  id: true, kind: true, status: true, orderId: true, customerId: true, creditNumber: true,
  order: { select: { orderNumber: true } },
  customer: { select: { code: true, name: true } },
  invoiceDate: true, total: true, finalizedAt: true, deletedAt: true,
} satisfies Prisma.InvoiceSelect;

type ListRowShape = Prisma.InvoiceGetPayload<{ select: typeof LIST_SELECT }>;

function toListRow(row: ListRowShape, prefix: string): InvoiceListRow {
  return {
    id: row.id, kind: row.kind, status: row.status,
    orderId: row.orderId, orderNumber: row.order.orderNumber,
    documentNumber: documentNumber(row.kind, row.creditNumber, row.order.orderNumber, prefix),
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    invoiceDate: formatDateOnly(row.invoiceDate), total: row.total.toNumber(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function invoiceListWhere(filter: InvoiceFilter): Prisma.InvoiceWhereInput {
  const invoiceDate = filter.from || filter.to ? {
    ...(filter.from ? { gte: parseDate(filter.from, "Invoice date from") } : {}),
    ...(filter.to ? { lte: parseDate(filter.to, "Invoice date to") } : {}),
  } : undefined;
  return {
    deletedAt: null, // a discarded draft never printed and is a candidate again (listInvoiceCandidates)
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(invoiceDate ? { invoiceDate } : {}),
  };
}

/** Every live invoice/credit, newest first — Task 17's worklist "Invoices" section. */
export async function listInvoices(filter: InvoiceFilter): Promise<InvoiceListRow[]> {
  const prefix = await getSetting("invoice_number_prefix");
  const rows = await prisma.invoice.findMany({
    where: invoiceListWhere(filter), select: LIST_SELECT,
    orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => toListRow(r, prefix));
}

/** Every invoice/credit ever raised against this order, discarded drafts included — the order
 *  hub's own Invoices section, the `shipmentsForOrder` precedent (shippers.ts): full history, not
 *  just the live state. */
export async function invoicesForOrder(orderId: string): Promise<InvoiceListRow[]> {
  const prefix = await getSetting("invoice_number_prefix");
  const rows = await prisma.invoice.findMany({
    where: { orderId }, select: LIST_SELECT,
    orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => toListRow(r, prefix));
}

// -------------------------------------------------------------------------------------------
// Create — the bracket is `saveNewShipper` with the shipment parts removed: read deps outside,
// then claim -> refuse -> read state -> build the engine input -> price -> write.
// -------------------------------------------------------------------------------------------

const CREATE = z.object({
  orderId: z.string().min(1),
  clientRequestId: z.string().min(1).max(200).optional(),
  invoiceDate: z.string().optional(),
}).strict();

type CreateInvoiceInput = z.infer<typeof CREATE>;

/** The plant-wide reads that do not depend on which order is being invoiced — read on the top-level
 *  client OUTSIDE the transaction (the `createOrder` settings-read precedent: a second-connection
 *  read inside a Serializable transaction is the shape a deadlock/pool starvation gets introduced
 *  through). The per-customer surcharge overrides are read INSIDE, off the customer row. */
type InvoiceDeps = { config: BillingConfigRow; surcharges: SurchargeRow[]; today: Date };

async function loadInvoiceDeps(): Promise<InvoiceDeps> {
  const [config, surcharges] = await Promise.all([getBillingConfig(), listSurcharges()]);
  return { config, surcharges, today: todayDateOnly() };
}

function pickDefault(addresses: AddressRow[], kind: AddressRow["kind"]): AddressRow | null {
  const of = addresses.filter((a) => a.kind === kind);
  return of.find((a) => a.isDefault) ?? of[0] ?? null;
}

/** A multi-line address block for the invoice snapshot (§10). Name falls back to the customer's own
 *  name when the address row has none; blank components are dropped so no empty line prints. */
function renderAddress(addr: AddressRow | null, fallbackName: string): string {
  const name = addr && addr.name !== "" ? addr.name : fallbackName;
  const cityLine = addr ? [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  return [name, addr?.street ?? "", cityLine].filter((s) => s !== "").join("\n");
}

type LeadPart = {
  partNumber: string; name: string; description: string; eachWeight: Prisma.Decimal;
  billForCert: boolean | null; certCharge: Prisma.Decimal | null; material: { name: string } | null;
};
type OrderLineRow = { id: string; position: number; partId: string; part: LeadPart };

/** The surcharges the engine should price, after this customer's blanket opt-out and per-surcharge
 *  overrides (§4.2). Seam #2 lands here: `SurchargeRow.glAccountName` (string | null) is normalized
 *  to the `string` the engine's `SurchargeInput` — and `InvoiceLine.glAccountName` — require. */
function buildSurcharges(
  surcharges: SurchargeRow[],
  customer: { surchargeOptOut: boolean; surchargeRules: { surchargeId: string; optOut: boolean; rate: Prisma.Decimal | null; amount: Prisma.Decimal | null }[] },
): SurchargeInput[] {
  if (customer.surchargeOptOut) return []; // the blanket switch wins over every plant-wide row
  const overrideById = new Map(customer.surchargeRules.map((r) => [r.surchargeId, r]));
  const out: SurchargeInput[] = [];
  for (const s of surcharges) {
    const ov = overrideById.get(s.id);
    if (ov?.optOut) continue;
    out.push({
      surchargeId: s.id, name: s.name, kind: s.kind,
      rate: ov?.rate?.toNumber() ?? s.rate,
      amount: ov?.amount?.toNumber() ?? s.amount,
      minimumAmount: s.minimumAmount,
      scope: s.scope, stepCodeIds: s.stepCodeIds, position: s.position,
      glAccountId: s.glAccountId, glAccountName: s.glAccountName ?? "", // seam #2
    });
  }
  return out;
}

/** Assembles the pure engine's whole input from the claimed order's live state. Seam #3 is the
 *  `qty === 0 && weight === 0` filter: a line that shipped nothing (a fully-returned or never-really
 *  -shipped line marked complete) must never reach the engine, which would bill it the full minimum
 *  plus setup for no work. */
async function buildPricingInput(
  tx: Db, config: BillingConfigRow, surcharges: SurchargeRow[],
  order: { id: string; certRequired: boolean },
  customer: { taxable: boolean; salesTaxRate: Prisma.Decimal | null; certChargeSuppressed: boolean; surchargeOptOut: boolean; surchargeRules: { surchargeId: string; optOut: boolean; rate: Prisma.Decimal | null; amount: Prisma.Decimal | null }[] },
  orderLines: OrderLineRow[],
): Promise<{ input: PricingInput; otherChargeGlName: string }> {
  const shipped = await shippedTotals(tx, orderLines.map((l) => l.id));

  // GL account names for the config-driven line kinds (freight, other-charge, sales tax). The cert
  // charge posts to its STEP CODE's GL account, resolved separately below.
  const glIds = [config.freightGlAccountId, config.otherChargeGlAccountId, config.salesTaxGlAccountId]
    .filter((id): id is string => id !== null);
  const glRows = glIds.length === 0 ? [] : await tx.glAccount.findMany({
    where: { id: { in: glIds } }, select: { id: true, name: true },
  });
  const glNameById = new Map(glRows.map((r) => [r.id, r.name]));
  const glRef = (id: string | null): GlRef => ({ glAccountId: id, glAccountName: id === null ? "" : (glNameById.get(id) ?? "") });
  // Seam #1's name half: `otherChargeGlAccountId` is already in `glIds` above, so its name is
  // already resolved here — the caller (createInvoiceInTx) reuses it rather than re-querying.
  const otherChargeGlName = config.otherChargeGlAccountId === null
    ? "" : (glNameById.get(config.otherChargeGlAccountId) ?? "");

  // Operation lines — one per order line with a NON-ZERO net shipped total (seam #3).
  const lines: OrderLineInput[] = [];
  for (const ol of orderLines) {
    const totals = shipped.get(ol.id) ?? { qty: 0, weight: 0 };
    if (totals.qty === 0 && totals.weight === 0) continue;
    const prices = await listPartPrices(ol.partId);
    lines.push({
      orderLineId: ol.id, position: ol.position,
      partNumber: ol.part.partNumber, partName: ol.part.name, partDescription: ol.part.description,
      eachWeight: ol.part.eachWeight.toNumber(),
      shippedQty: totals.qty, shippedWeight: totals.weight,
      prices: prices.map((p) => ({
        processStepCodeId: p.processStepCodeId, stepCode: p.stepCode, stepName: p.stepName, position: p.position,
        setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
        pricePer: p.pricePer, breaks: p.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
        glAccountId: p.glAccountId, glAccountName: p.glAccountName,
      })),
    });
  }

  // Extra charges — every live OrderCharge (this table has no deletedAt; §7.5.3 allows a null
  // amount, which the engine flags `needsPrice`).
  const orderCharges = await tx.orderCharge.findMany({
    where: { orderId: order.id }, orderBy: { position: "asc" },
    select: { id: true, position: true, description: true, amount: true },
  });
  const charges: ChargeInput[] = orderCharges.map((c) => ({
    orderChargeId: c.id, position: c.position, description: c.description, amount: num(c.amount),
  }));

  // Freight — the sum of freight billed across this order's LIVE shipments (spec §5, freight rides
  // the Shipper). Accumulated in integer cents (Decimal(12,2)) so summing several shipments is
  // exact. A shipment that does not bill freight, or carries no amount, contributes nothing.
  const shipperOrders = await tx.shipperOrder.findMany({
    where: { orderId: order.id },
    select: { shipper: { select: { id: true, deletedAt: true, billFreight: true, freightAmount: true } } },
  });
  let freightCents = 0;
  let anyFreight = false;
  const seenShippers = new Set<string>();
  for (const so of shipperOrders) {
    const s = so.shipper;
    if (s.deletedAt !== null || !s.billFreight || s.freightAmount === null) continue;
    if (seenShippers.has(s.id)) continue;
    seenShippers.add(s.id);
    anyFreight = true;
    freightCents += Math.round(s.freightAmount.toNumber() * 100);
  }
  const freight = anyFreight ? { ...glRef(config.freightGlAccountId), amount: freightCents / 100 } : null;

  // Certification charge (§6) — billed only when the order requires a cert, the lead part's
  // bill-for-cert resolves true (part overrides the plant default), the customer is not blanket-
  // suppressed, and an amount actually resolves. It posts to the config cert step code's GL account.
  const lead = orderLines[0]?.part ?? null; // orderLines is position-asc, so [0] is the lead line
  const billForCert = lead?.billForCert ?? config.billForCertDefault;
  const certAmount = lead?.certCharge?.toNumber() ?? config.certChargeDefault;
  let cert: (GlRef & { amount: number; description: string }) | null = null;
  if (order.certRequired && billForCert && !customer.certChargeSuppressed && certAmount !== null) {
    let certStep: { name: string; glAccountId: string | null; glAccountName: string } | null = null;
    if (config.certChargeStepCodeId) {
      const sc = await tx.processStepCode.findFirst({
        where: { id: config.certChargeStepCodeId },
        select: { name: true, glAccountId: true, glAccount: { select: { name: true } } },
      });
      if (sc) certStep = { name: sc.name, glAccountId: sc.glAccountId, glAccountName: sc.glAccount?.name ?? "" };
    }
    cert = {
      glAccountId: certStep?.glAccountId ?? null, glAccountName: certStep?.glAccountName ?? "",
      amount: certAmount, description: certStep?.name ?? "Certification",
    };
  }

  // Sales tax (§4.4/§5) — the customer's own rate wins over the plant rate; the flag decides IF,
  // the rate decides AT WHAT. Freight is excluded from the tax base inside the engine (ruling 8).
  const taxRate = customer.taxable ? (customer.salesTaxRate?.toNumber() ?? config.salesTaxRate) : null;
  const tax = taxRate !== null ? { ...glRef(config.salesTaxGlAccountId), rate: taxRate } : null;

  return {
    input: { lines, surcharges: buildSurcharges(surcharges, customer), charges, freight, cert, tax },
    otherChargeGlName,
  };
}

// -------------------------------------------------------------------------------------------
// Shared line-writing helpers. Create and recalculate MUST turn `priceOrder`'s output into
// InvoiceLine rows the same way — same seam #1 assignment, same FK guards, same parent wiring —
// or the two paths drift and a recalculated invoice stops matching a freshly created one (the
// task's single most important correctness property). So the mapping lives here, once, and both
// callers use it. `replaceInvoiceLines` shares only the FK guard and the totals math; its lines
// come from the caller, not the engine, so it wires parents from payload keys instead.
// -------------------------------------------------------------------------------------------

/** The columns of one InvoiceLine, minus `invoiceId`/`parentLineId` (both wired after insert). */
type InvoiceLineWrite = {
  position: number; kind: InvoiceLineKindValue;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: PricePerValue | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: PriceSourceValue | null; needsPrice: boolean;
  amount: number;
};

/** `priceOrder`'s computed lines → InvoiceLine write rows at positions 1..n. Seam #1 lands here
 *  (CLAUDE.md / this file's header): a CHARGE line arrives from the pure engine with a null GL
 *  account, so the config's `otherChargeGlAccountId` (and its resolved name) is assigned to CHARGE
 *  lines HERE, exactly as create always did — factored out so recalculate cannot post them to a
 *  different account than create would. */
function mapComputedLines(computed: PricingResult, otherChargeGl: GlRef): InvoiceLineWrite[] {
  return computed.lines.map((l, i) => ({
    position: i + 1, kind: l.kind,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId,
    glAccountId: l.kind === "CHARGE" ? otherChargeGl.glAccountId : l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description,
    glAccountName: l.kind === "CHARGE" ? otherChargeGl.glAccountName : l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice, setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, needsPrice: l.needsPrice, amount: l.amount,
  }));
}

/** `assertRefExists` on every registered FK the lines carry (CLAUDE.md's FK-writer pattern; the
 *  Serializable isolation is what this pairs WITH, never a substitute for it). `extraStepCodeIds`
 *  covers the cert charge's step code, which never lands on any line's `processStepCodeId` column
 *  (only its GL account rides along) and so is invisible to the scan otherwise. */
async function assertLineRefs(
  tx: Db,
  lines: { glAccountId: string | null; processStepCodeId: string | null; surchargeId: string | null }[],
  extraStepCodeIds: string[] = [],
): Promise<void> {
  const glAccountIds = new Set(lines.map((l) => l.glAccountId).filter((id): id is string => id !== null));
  const processStepCodeIds = new Set(
    lines.map((l) => l.processStepCodeId).filter((id): id is string => id !== null));
  for (const id of extraStepCodeIds) processStepCodeIds.add(id);
  const surchargeIds = new Set(lines.map((l) => l.surchargeId).filter((id): id is string => id !== null));
  for (const id of glAccountIds) await assertRefExists("glAccount", id, tx);
  for (const id of processStepCodeIds) await assertRefExists("processStepCode", id, tx);
  for (const id of surchargeIds) await assertRefExists("surcharge", id, tx);
}

/** Second pass for the self-relation an OPERATION line has to its PART line: the parent's id does
 *  not exist until its own row is written, so a single nested create cannot express it. The engine's
 *  line order is stable, so `position = index + 1` maps each computed line's `key`/`parentKey` back
 *  to the rows just written. Derived lines occupy positions 1..computed.length; any manual lines
 *  appended after are untouched (they carry no engine key). */
async function wireComputedParents(tx: Db, invoiceId: string, computedLines: ComputedLine[]): Promise<void> {
  const rows = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { id: true, position: true } });
  const idByPosition = new Map(rows.map((r) => [r.position, r.id]));
  const positionByKey = new Map(computedLines.map((l, i) => [l.key, i + 1]));
  for (const [i, l] of computedLines.entries()) {
    if (l.parentKey === null) continue;
    const childId = idByPosition.get(i + 1)!;
    const parentId = idByPosition.get(positionByKey.get(l.parentKey)!)!;
    await tx.invoiceLine.update({ where: { id: childId }, data: { parentLineId: parentId } });
  }
}

/** The six buckets + grand total, as sums of already-rounded line amounts in integer cents (the
 *  pricing engine's own rule: totals are never rebuilt out of dollars that were already rounded).
 *  Used by every path that recomputes totals from a final line set — `replaceInvoiceLines` and
 *  `recalculateInvoice`. PART lines carry `amount = 0` and fall into no bucket. */
function totalsFromLines(lines: { kind: InvoiceLineKindValue; amount: number }[]) {
  const centsFor = (kind: InvoiceLineKindValue) =>
    lines.reduce((sum, l) => (l.kind === kind ? sum + Math.round(l.amount * 100) : sum), 0);
  const buckets = {
    subtotal: centsFor("OPERATION"), surchargeTotal: centsFor("SURCHARGE"),
    chargeTotal: centsFor("CHARGE"), certTotal: centsFor("CERT"),
    freightTotal: centsFor("FREIGHT"), taxTotal: centsFor("TAX"),
  };
  const total = Object.values(buckets).reduce((sum, b) => sum + b, 0);
  return {
    subtotal: buckets.subtotal / 100, surchargeTotal: buckets.surchargeTotal / 100,
    chargeTotal: buckets.chargeTotal / 100, certTotal: buckets.certTotal / 100,
    freightTotal: buckets.freightTotal / 100, taxTotal: buckets.taxTotal / 100,
    total: total / 100,
  };
}

async function createInvoiceInTx(
  tx: Db, data: CreateInvoiceInput, deps: InvoiceDeps,
): Promise<{ detail: InvoiceDetail; deduped: boolean }> {
  // Claim the Order row for the rest of this transaction — the ONE cross-transaction guard behind
  // "one live invoice per order" (order-locks.ts): the refusal below and the write it guards must
  // see the same state, and Serializable/SSI is NOT a substitute for the row lock (the certs.ts
  // discriminating-race lesson — see the concurrency test).
  const order = await claimOrder(tx, data.orderId);
  if (!order) throw new HttpError(404, "Order not found");
  if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
  if (order.status !== "SHIPPED") throw new HttpError(400, "Only a fully shipped order can be invoiced");

  // `findFirst`, NEVER `findUnique`: `@@unique([orderId])` is filtered on
  // `deletedAt IS NULL AND kind = 'INVOICE'`, so the generated client types a plain unique it
  // cannot honour (the partial-unique rule). The same index guarantees at most one live row.
  //
  // Idempotency for THIS shape is caught here, under the claim, not via a clientRequestId P2002 on
  // INSERT (the createShipper shape): a replay carries the same orderId, so the order's own live-
  // invoice guard fires FIRST — every same-order retry serializes through claimOrder and sees the
  // committed first invoice here, before it can ever reach the clientRequestId index. A live
  // invoice whose nonce matches the request IS that request's own prior result, so answer with it
  // (deduped); a live invoice with any other (or null) nonce is a genuine "already invoiced"
  // refusal. The `isDuplicateClientRequestId` catch in the caller stays as the backstop for a
  // collision the order claim did not cover (a nonce reused across orders).
  const existing = await tx.invoice.findFirst({
    where: { orderId: data.orderId, kind: "INVOICE", deletedAt: null },
    select: { id: true, clientRequestId: true },
  });
  if (existing) {
    if (data.clientRequestId && existing.clientRequestId === data.clientRequestId) {
      return { detail: await readInvoiceDetail(tx, existing.id), deduped: true };
    }
    throw new HttpError(400,
      `Order #${order.orderNumber} already has an invoice — discard its draft or credit the finalized one`);
  }

  const customer = await tx.customer.findFirst({
    where: { id: order.customerId },
    select: {
      code: true, name: true, taxable: true, salesTaxRate: true, certChargeSuppressed: true,
      surchargeOptOut: true,
      terms: { select: { name: true } },
      surchargeRules: {
        where: { deletedAt: null },
        select: { surchargeId: true, optOut: true, rate: true, amount: true },
      },
    },
  });
  if (!customer) throw new HttpError(404, "Customer not found");

  const addresses = await listAddresses(order.customerId, undefined, tx);
  const billTo = renderAddress(pickDefault(addresses, "BILL_TO"), customer.name);
  const shipTo = renderAddress(pickDefault(addresses, "SHIP_TO"), customer.name);

  const orderLines: OrderLineRow[] = await tx.orderLine.findMany({
    where: { orderId: data.orderId },
    orderBy: { position: "asc" },
    select: {
      id: true, position: true, partId: true,
      part: {
        select: {
          partNumber: true, name: true, description: true, eachWeight: true,
          billForCert: true, certCharge: true, material: { select: { name: true } },
        },
      },
    },
  });

  const { input, otherChargeGlName } =
    await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
  const computed = priceOrder(input); // the pure engine — all the arithmetic

  // The lead line's priced operations, comma-joined — the invoice header's "process names" (§10).
  const leadPrices = orderLines[0] ? await listPartPrices(orderLines[0].partId) : [];
  const processNames = leadPrices.map((p) => p.stepName).join(", ");
  const materialName = orderLines[0]?.part.material?.name ?? "";

  const invoiceDate = data.invoiceDate ? parseDate(data.invoiceDate, "Invoice date") : deps.today;
  const taxRate = input.tax?.rate ?? null;
  const otherChargeGl: GlRef = {
    glAccountId: deps.config.otherChargeGlAccountId, glAccountName: otherChargeGlName,
  };

  // Engine output -> line rows, with seam #1 assigned inside `mapComputedLines`. Then Fix 1
  // (spec §5.1): this transaction is Serializable specifically to pair with `assertLineRefs`'
  // `assertRefExists` on every registered FK it assigns (CLAUDE.md's FK-writer pattern,
  // `createShipper`'s `carrierId` precedent). Checked fresh on `tx`, after the claim:
  // `deps.config`/`deps.surcharges` were read on the TOP-LEVEL client before this transaction even
  // opened (`loadInvoiceDeps`), so a GL account, step code or surcharge could have been soft-deleted
  // in the gap — a distant delete-blocker (e.g. `BILLING_CONFIG_BLOCKER`) is not a substitute for
  // this local, permanent check. Both the mapping and the guard are shared verbatim with
  // `recalculateInvoice`, so the two write paths cannot drift.
  const lineData = mapComputedLines(computed, otherChargeGl);
  const certStepIds = input.cert && deps.config.certChargeStepCodeId ? [deps.config.certChargeStepCodeId] : [];
  await assertLineRefs(tx, lineData, certStepIds);

  // The `after` snapshot, composed by hand like shippers.ts's `auditPayload` — every FK travels
  // with the live name it points at, and the lines' amounts are included so line changes show in
  // history from the create entry on. Row ids are absent because they do not exist yet.
  const auditData = {
    kind: "INVOICE", status: "DRAFT",
    orderId: data.orderId, orderNumber: order.orderNumber,
    customerId: order.customerId, customerCode: customer.code, customerName: customer.name,
    invoiceDate: formatDateOnly(invoiceDate),
    poNumber: order.poNumber, termsName: customer.terms?.name ?? "",
    materialName, processNames, taxRate,
    subtotal: computed.subtotal, surchargeTotal: computed.surchargeTotal, chargeTotal: computed.chargeTotal,
    certTotal: computed.certTotal, freightTotal: computed.freightTotal, taxTotal: computed.taxTotal,
    total: computed.total,
    lines: lineData.map((l) => ({
      position: l.position, kind: l.kind, description: l.description,
      glAccountName: l.glAccountName, amount: l.amount,
    })),
  };

  const invoice = await auditedCreate("invoice", auditData, async () => {
    const created = await tx.invoice.create({
      data: {
        kind: "INVOICE",
        orderId: data.orderId,
        customerId: order.customerId,
        status: "DRAFT",
        invoiceDate,
        poNumber: order.poNumber,
        termsName: customer.terms?.name ?? "",
        billTo, shipTo, materialName, processNames,
        taxRate,
        subtotal: computed.subtotal, surchargeTotal: computed.surchargeTotal, chargeTotal: computed.chargeTotal,
        certTotal: computed.certTotal, freightTotal: computed.freightTotal, taxTotal: computed.taxTotal,
        total: computed.total,
        clientRequestId: data.clientRequestId ?? null,
        lines: { create: lineData },
      },
      select: { id: true },
    });

    // Second pass for the OPERATION -> PART self-relation (shared with recalculate).
    await wireComputedParents(tx, created.id, computed.lines);
    return created;
  }, { tx });

  return { detail: await readInvoiceDetail(tx, invoice.id), deduped: false };
}

/**
 * `createInvoice` (spec §5.4). Reads the plant-wide deps outside the transaction, then creates the
 * DRAFT invoice under the order's row claim. `clientRequestId` collisions answer with the invoice
 * that request already created (`orders.ts`'s idempotent-replay shape, via the exported
 * `isDuplicateClientRequestId`), recomputing the warnings for the replay (#50 — the lost-response
 * retry is exactly when the operator never saw them).
 *
 * `tx` is optional: internal callers and the discriminating concurrency test pass a manually-opened
 * transaction so the row lock, not SSI, is what serializes competing creates (the `createCert`
 * shape).
 */
export async function createInvoice(input: unknown, tx?: Prisma.TransactionClient): Promise<InvoiceCreateResult> {
  const data = CREATE.parse(input);
  const deps = await loadInvoiceDeps();

  if (tx) {
    const { detail, deduped } = await createInvoiceInTx(tx, data, deps);
    return { invoice: detail, warnings: await invoiceWarnings(detail), deduped };
  }

  return withDbErrors({ entity: "Invoice" }, async () => {
    try {
      const { detail, deduped } = await prisma.$transaction(
        (fresh) => createInvoiceInTx(fresh, data, deps),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { invoice: detail, warnings: await invoiceWarnings(detail), deduped };
    } catch (err) {
      // The backstop replay: inside withDbErrors' callback and OUTSIDE the transaction — by the
      // time this runs the failed attempt has fully rolled back and the winning invoice is
      // committed. The same-order replay is handled under the claim inside `createInvoiceInTx`;
      // this covers only a clientRequestId collision the order claim did not serialize.
      if (!data.clientRequestId || !isDuplicateClientRequestId(err)) throw err;
      const existing = await prisma.invoice.findFirst({
        where: { clientRequestId: data.clientRequestId }, select: { id: true },
      });
      if (!existing) throw err;
      const invoice = await readInvoiceDetail(prisma, existing.id);
      return { invoice, warnings: await invoiceWarnings(invoice), deduped: true };
    }
  });
}

/**
 * The advisory surface every mutating invoice route returns alongside the invoice (§7.5). Pure over
 * the detail — one entry per line that still needs a price, and one per operation line whose step
 * code carries no GL account (advisory in 5A; 5C's QBO export refuses to post without one).
 */
export async function invoiceWarnings(detail: InvoiceDetail): Promise<string[]> {
  const warnings: string[] = [];
  for (const l of detail.lines) {
    if (l.needsPrice) {
      // A CHARGE line (and any other non-part line) carries a blank `partNumber` — fall back to
      // its own description as the label so the message never renders a dangling "·  —".
      const label = l.partNumber === "" ? `${l.description} —` : `${l.partNumber} — ${l.description}`;
      warnings.push(`Line ${l.position} · ${label} needs a price`);
    }
  }
  for (const l of detail.lines) {
    if (l.processStepCodeId !== null && l.glAccountId === null) {
      warnings.push(`Line ${l.position} · ${l.partNumber} — ${l.description} has no GL account`);
    }
  }
  return warnings;
}

// -------------------------------------------------------------------------------------------
// Task 12 (§5.5): draft edits, recalculate, discard. Every mutator here shares one bracket —
// `withDbErrors` → Serializable `$transaction` → `claimLiveInvoice` → `audited*` → writes on
// `tx` — and every one refuses a FINALIZED invoice (immutable until Task 13's unlock) and a
// discarded one, each naming what blocks it. A FINALIZED invoice is customer-facing paper; the
// corrections are unlock or credit, never a silent edit.
// -------------------------------------------------------------------------------------------

/**
 * The lifecycle claim shared by EVERY invoice mutator — Task 12's draft edits (through
 * `claimLiveInvoice` below) and Task 13's finalize/unlock. Factored like `claimLiveShipper`
 * (shippers.ts): an UNLOCKED stub read to learn which order to claim (404 on missing), `claimOrder`
 * on that order, then `FOR UPDATE` on the Invoice row itself — uniformly AFTER the order claim, one
 * fixed order (Order row, then the entity's own row), so no ABBA window opens (order-locks.ts house
 * rule). Only then the liveness re-read, off rows this transaction actually holds.
 *
 * `Invoice.status`/`deletedAt` live on the Invoice row, so a concurrent finalize, unlock, discard or
 * draft edit — every one of which also claims this order first — serializes through these two locks:
 * the caller's refusal and the write it guards see the same state, and a Serializable caller whose
 * Invoice row changed under it raises 40001 (withDbErrors' honest 409) rather than acting on a stale
 * snapshot. Taking the ORDER claim FIRST is the house-rule obligation Task 10's invoice guards rest
 * on (invoice-guards.ts): they read the finalized-invoice state under THEIR order claim, so finalize
 * and unlock must hold the same order claim before they read or write that state.
 *
 * Returns the fresh invoice detail row and the claimed Order row. The FINALIZED check is the
 * caller's, not this helper's — finalize allows a DRAFT, unlock allows a FINALIZED, and the edit
 * mutators refuse a FINALIZED — so each names its own blocker (`claimLiveInvoice` below is the edit
 * mutators' wrapper that adds theirs).
 */
async function claimInvoiceRow(tx: Db, id: string): Promise<{ invoice: DetailRow; order: Order }> {
  const stub = await tx.invoice.findFirst({ where: { id }, select: { orderId: true } });
  if (!stub) throw new HttpError(404, "Invoice not found");
  const order = await claimOrder(tx, stub.orderId);
  if (!order) throw new HttpError(404, "Invoice not found");
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!invoice || invoice.deletedAt !== null) throw new HttpError(404, "Invoice not found");
  return { invoice, order };
}

/**
 * The DRAFT-edit claim: `claimInvoiceRow` plus the refusal that a FINALIZED invoice is immutable
 * until unlock. A FINALIZED invoice is customer-facing paper; the corrections are unlock or credit,
 * never a silent edit (§5.5).
 */
async function claimLiveInvoice(tx: Db, id: string): Promise<{ invoice: DetailRow; order: Order }> {
  const claimed = await claimInvoiceRow(tx, id);
  if (claimed.invoice.status === "FINALIZED") {
    throw new HttpError(400,
      `Invoice #${claimed.invoice.order.orderNumber} is finalized and locked — unlock it before editing`);
  }
  return claimed;
}

// -------------------------------------------------------------------------------------------
// updateInvoice — header only.
// -------------------------------------------------------------------------------------------

const UPDATE_INVOICE = z.object({
  poNumber: z.string().max(200).optional(),
  invoiceDate: z.string().min(1).optional(),
  termsName: z.string().max(200).optional(),
  billTo: z.string().max(4000).optional(),
  shipTo: z.string().max(4000).optional(),
}).strict();

/**
 * Header-only draft edit (§5.5). Customer/order identity, the line-derived totals and the lifecycle
 * columns are all off-limits here — the correctable header snapshots are PO, invoice date, terms and
 * the two address blocks. A partial patch persists exactly the keys the caller sent: every field is
 * an independent scalar, so there is no interdependent state a partial write could leave stale (the
 * Task 6 defect), and an unspecified field keeps its value rather than being blanked.
 */
export async function updateInvoice(id: string, input: unknown): Promise<InvoiceDetail> {
  const data = UPDATE_INVOICE.parse(input);
  const patch: Prisma.InvoiceUpdateInput = {
    ...(data.poNumber !== undefined ? { poNumber: data.poNumber } : {}),
    ...(data.invoiceDate !== undefined ? { invoiceDate: parseDate(data.invoiceDate, "Invoice date") } : {}),
    ...(data.termsName !== undefined ? { termsName: data.termsName } : {}),
    ...(data.billTo !== undefined ? { billTo: data.billTo } : {}),
    ...(data.shipTo !== undefined ? { shipTo: data.shipTo } : {}),
  };

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    await claimLiveInvoice(tx, id);
    await auditedUpdate("invoice", id, () => tx.invoice.update({ where: { id }, data: patch }), { tx });
    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// replaceInvoiceLines — whole-array replace (the replaceCharges / replaceShipperLines precedent).
// The lines come from the CALLER, not the engine, so amounts and snapshots are trusted as given;
// only the registered FKs are guarded and the totals recomputed. Grouping (OPERATION -> PART) is
// expressed by caller-supplied `key`/`parentKey`, re-wired in a second pass — positions are
// reassigned 1..n and row ids reminted, so an id-based parent link could never survive the replace.
// -------------------------------------------------------------------------------------------

const LINE_INPUT = z.object({
  key: z.string().min(1).optional(),
  parentKey: z.string().min(1).nullable().optional(),
  kind: z.enum(INVOICE_LINE_KINDS),
  orderLineId: z.string().min(1).nullable().optional(),
  processStepCodeId: z.string().min(1).nullable().optional(),
  surchargeId: z.string().min(1).nullable().optional(),
  orderChargeId: z.string().min(1).nullable().optional(),
  glAccountId: z.string().min(1).nullable().optional(),
  partNumber: z.string().max(200).optional(),
  partName: z.string().max(200).optional(),
  partDescription: z.string().max(4000).optional(),
  description: z.string().max(4000).optional(),
  glAccountName: z.string().max(200).optional(),
  qty: z.number().int().nullable().optional(),
  weight: decimalField(12, 2),
  eachWeight: decimalField(10, 4),
  pricePer: z.enum(PRICE_PER).nullable().optional(),
  unitPrice: decimalField(12, 4),
  setupCharge: decimalField(12, 2),
  minimumCharge: decimalField(12, 2),
  breakThreshold: decimalField(12, 2),
  minimumApplied: z.boolean().optional(),
  rate: decimalField(9, 6),
  priceSource: z.enum(PRICE_SOURCES).nullable().optional(),
  needsPrice: z.boolean().optional(),
  amount: decimalField(12, 2, { required: true }),
}).strict();

type LineInput = z.infer<typeof LINE_INPUT>;
const REPLACE_LINES = z.array(LINE_INPUT);

/** One payload item -> its InvoiceLine columns (minus `invoiceId`/`position`/`parentLineId`, all
 *  assigned by the caller). Every column is persisted, defaulted the same way the schema defaults
 *  it — so a whole row is written, never a subset (the Task 6 normalize-on-write rule). */
function lineColumns(l: LineInput) {
  return {
    kind: l.kind,
    orderLineId: l.orderLineId ?? null, processStepCodeId: l.processStepCodeId ?? null,
    surchargeId: l.surchargeId ?? null, orderChargeId: l.orderChargeId ?? null, glAccountId: l.glAccountId ?? null,
    partNumber: l.partNumber ?? "", partName: l.partName ?? "", partDescription: l.partDescription ?? "",
    description: l.description ?? "", glAccountName: l.glAccountName ?? "",
    qty: l.qty ?? null, weight: l.weight ?? null, eachWeight: l.eachWeight ?? null,
    pricePer: l.pricePer ?? null, unitPrice: l.unitPrice ?? null,
    setupCharge: l.setupCharge ?? null, minimumCharge: l.minimumCharge ?? null,
    breakThreshold: l.breakThreshold ?? null, minimumApplied: l.minimumApplied ?? false,
    rate: l.rate ?? null, priceSource: l.priceSource ?? null, needsPrice: l.needsPrice ?? false,
    amount: l.amount,
  };
}

export async function replaceInvoiceLines(id: string, input: unknown): Promise<InvoiceDetail> {
  const data = REPLACE_LINES.parse(input);
  const columns = data.map(lineColumns);

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    await claimLiveInvoice(tx, id);
    await assertLineRefs(tx, columns); // every registered FK the payload writes (the create guard)

    await auditedUpdate("invoice", id, async () => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      if (columns.length > 0) {
        await tx.invoiceLine.createMany({ data: columns.map((c, i) => ({ invoiceId: id, position: i + 1, ...c })) });
        await wirePayloadParents(tx, id, data);
      }
      await tx.invoice.update({ where: { id }, data: totalsFromLines(columns) });
    }, { tx });

    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Wires parents from caller keys: each input's `key` -> its new row id (position = index + 1),
 *  then each `parentKey` -> that id. A `parentKey` naming no line in the payload leaves the child
 *  flat rather than dangling. Typed on just `key`/`parentKey` so both `replaceInvoiceLines`' payload
 *  (`LineInput[]`) and `createCredit`'s source-line copy (keyed off the source rows' own ids) reuse
 *  it — the copy has the same "the parent id does not exist until its row is written" second-pass
 *  shape, so it must not fork a second wiring path. */
async function wirePayloadParents(
  tx: Db, invoiceId: string, lines: readonly { key?: string; parentKey?: string | null }[],
): Promise<void> {
  const rows = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { id: true, position: true } });
  const idByPosition = new Map(rows.map((r) => [r.position, r.id]));
  const idByKey = new Map<string, string>();
  lines.forEach((l, i) => { if (l.key) idByKey.set(l.key, idByPosition.get(i + 1)!); });
  for (const [i, l] of lines.entries()) {
    if (!l.parentKey) continue;
    const parentId = idByKey.get(l.parentKey);
    if (parentId) await tx.invoiceLine.update({ where: { id: idByPosition.get(i + 1)! }, data: { parentLineId: parentId } });
  }
}

// -------------------------------------------------------------------------------------------
// recalculateInvoice — re-price from CURRENT data (new part prices, new surcharges, current shipped
// totals) and replace every DERIVED line (priceSource ≠ MANUAL), keeping manual lines at the end.
// It re-runs Task 11's whole build — `buildPricingInput` + `priceOrder` + the shared
// `mapComputedLines`/`assertLineRefs`/`wireComputedParents` — so it produces exactly what a fresh
// `createInvoice` would for the same order today. There is no second pricing path to drift from.
// -------------------------------------------------------------------------------------------

export async function recalculateInvoice(id: string): Promise<InvoiceDetail> {
  const deps = await loadInvoiceDeps(); // plant-wide reads OUTSIDE the tx — the create precedent

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    const { invoice, order } = await claimLiveInvoice(tx, id);
    // A credit's lines are derived from its source invoice with the sign flipped (§5.6), not from
    // the order — the order only ever prices at ordinary POSITIVE amounts. Recalculating a credit
    // would silently overwrite its negated lines/total with a positive re-price of the order (the
    // whole-branch review's money-inverting finding). There is no order pricing that should ever
    // replace a credit's derived lines; the only corrections are line edits (`replaceInvoiceLines`)
    // or discard.
    if (invoice.kind === "CREDIT") {
      throw new HttpError(400, "A credit cannot be recalculated — edit its lines or discard it");
    }
    if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);

    const customer = await tx.customer.findFirst({
      where: { id: order.customerId },
      select: {
        taxable: true, salesTaxRate: true, certChargeSuppressed: true, surchargeOptOut: true,
        surchargeRules: {
          where: { deletedAt: null },
          select: { surchargeId: true, optOut: true, rate: true, amount: true },
        },
      },
    });
    if (!customer) throw new HttpError(404, "Customer not found");

    const orderLines: OrderLineRow[] = await tx.orderLine.findMany({
      where: { orderId: order.id },
      orderBy: { position: "asc" },
      select: {
        id: true, position: true, partId: true,
        part: {
          select: {
            partNumber: true, name: true, description: true, eachWeight: true,
            billForCert: true, certCharge: true, material: { select: { name: true } },
          },
        },
      },
    });

    const { input, otherChargeGlName } =
      await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
    const computed = priceOrder(input);
    const otherChargeGl: GlRef = {
      glAccountId: deps.config.otherChargeGlAccountId, glAccountName: otherChargeGlName,
    };
    const derived = mapComputedLines(computed, otherChargeGl);

    // Manual lines survive untouched and ride at the END (§5.5). Read before the delete, recreated
    // after the regenerated derived lines.
    const manual = await tx.invoiceLine.findMany({
      where: { invoiceId: id, priceSource: "MANUAL" }, orderBy: { position: "asc" },
    });

    const certStepIds = input.cert && deps.config.certChargeStepCodeId ? [deps.config.certChargeStepCodeId] : [];
    await assertLineRefs(tx, [...derived, ...manual], certStepIds);

    const taxRate = input.tax?.rate ?? null;
    const totals = totalsFromLines([
      ...derived, ...manual.map((m) => ({ kind: m.kind, amount: m.amount.toNumber() })),
    ]);

    await auditedUpdate("invoice", id, async () => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceLine.createMany({ data: derived.map((c) => ({ invoiceId: id, ...c })) });
      const base = derived.length;
      if (manual.length > 0) {
        await tx.invoiceLine.createMany({
          data: manual.map((m, j) => ({
            invoiceId: id, position: base + j + 1, kind: m.kind,
            orderLineId: m.orderLineId, processStepCodeId: m.processStepCodeId,
            surchargeId: m.surchargeId, orderChargeId: m.orderChargeId, glAccountId: m.glAccountId,
            partNumber: m.partNumber, partName: m.partName, partDescription: m.partDescription,
            description: m.description, glAccountName: m.glAccountName,
            qty: m.qty, weight: m.weight, eachWeight: m.eachWeight,
            pricePer: m.pricePer, unitPrice: m.unitPrice, setupCharge: m.setupCharge,
            minimumCharge: m.minimumCharge, breakThreshold: m.breakThreshold, minimumApplied: m.minimumApplied,
            rate: m.rate, priceSource: m.priceSource, needsPrice: m.needsPrice, amount: m.amount,
          })),
        });
      }
      // Derived parents wire off the engine keys (positions 1..base). A preserved manual line keeps
      // a parent only if that parent was ALSO manual (remapped old->new id); a parent that was a
      // derived line has been regenerated with a new id, so the link is dropped, never left
      // dangling.
      await wireComputedParents(tx, id, computed.lines);
      if (manual.some((m) => m.parentLineId !== null)) {
        const rows = await tx.invoiceLine.findMany({ where: { invoiceId: id }, select: { id: true, position: true } });
        const idByPosition = new Map(rows.map((r) => [r.position, r.id]));
        const newIdByOldManualId = new Map(manual.map((m, j) => [m.id, idByPosition.get(base + j + 1)!]));
        for (const [j, m] of manual.entries()) {
          if (m.parentLineId === null) continue;
          const parentId = newIdByOldManualId.get(m.parentLineId);
          if (parentId) await tx.invoiceLine.update({ where: { id: idByPosition.get(base + j + 1)! }, data: { parentLineId: parentId } });
        }
      }

      // taxRate is inseparable from the regenerated TAX line — leaving the header column stale would
      // make it disagree with the line. The descriptive header snapshots (PO, terms, addresses,
      // material, process names) are NOT touched: recalculate replaces derived lines, not a user's
      // header edits.
      await tx.invoice.update({ where: { id }, data: { taxRate, ...totals } });
    }, { tx });

    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// discardInvoice — soft-delete a DRAFT that has never printed (§5.5/§5.17). It frees the order for
// a new invoice: the live-rows-only unique on `orderId` sees a discarded row as gone.
// -------------------------------------------------------------------------------------------

export async function discardInvoice(id: string, reason: string): Promise<void> {
  // §5.17: the reason is required and trimmed IN THE SERVICE (the `voidOrder` precedent) — a
  // discard frees the order number, exactly the unique-identifier case that rule governs, so no
  // future caller can bypass it.
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to discard an invoice");

  await withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    await claimLiveInvoice(tx, id);
    // Task 9 (§5.3): DEFENSE-IN-DEPTH. A draft can never carry real A/R activity through the
    // services — `applyPayment`/`applyCredit` require FINALIZED invoices/credits — so this guard is
    // unreachable by construction, but the spec mandates it belt-and-suspenders: paper with money
    // applied to it is never silently discarded. Read under the claim `claimLiveInvoice` holds.
    if (await hasReceivableActivity(tx, id)) {
      throw new HttpError(400,
        "This invoice has payments or credits applied and cannot be discarded — void them first");
    }
    // A printed invoice is paper the customer may hold — it can never be discarded, only credited
    // (§5.5). Any StoredDocument naming this invoice is proof it printed. Read under the claim.
    const printed = await tx.storedDocument.findFirst({ where: { invoiceId: id }, select: { id: true } });
    if (printed) {
      throw new HttpError(400, "This invoice has already printed and cannot be discarded — credit it instead");
    }
    await auditedSoftDelete("invoice", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 13 (§5.5/§5.2): finalize, unlock, and the INVOICED/REOPENED status ownership. Both take the
// order claim FIRST (through the shared `claimInvoiceRow`) before they read or write invoice state,
// so they serialize against every order/shipment mutator whose Task 10 invoice guard
// (`finalizedInvoiceFor`) reads the finalized-invoice state under ITS own order claim (§5.7). Both
// write `Order.status` through `auditedUpdate`, onto the order's own history.
// -------------------------------------------------------------------------------------------

async function finalizeInvoiceInTx(tx: Db, id: string): Promise<InvoiceDetail> {
  const { invoice, order } = await claimInvoiceRow(tx, id);
  // Read under the claim (the whole point of taking it): the order's live state and the invoice's
  // own status both decide the transition, and must be the state this write commits against.
  if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
  // Idempotent: a re-finalize is a 400 naming the state, never a second write (§5.5).
  if (invoice.status === "FINALIZED") throw new HttpError(400, "That invoice is already finalized");
  // Finalize is refused while any line still needs a price (§5.5) — the ONLY finalize block. It reads
  // the RESOLVED price already snapshotted on the line (Task 9), so a break-only line does not block.
  // No GL-account check: spec §15 puts that on 5C's export, not here.
  const offending = invoice.lines.find((l) => l.needsPrice);
  if (offending) {
    const label = offending.partNumber === ""
      ? offending.description
      : `${offending.partNumber} — ${offending.description}`;
    throw new HttpError(400, `Line ${offending.position} · ${label} needs a price — price every line before finalizing`);
  }
  // §4.1: finalizing writes SALES-journal paper effective at `invoiceDate`, so it is refused into a
  // CLOSED accounting period. Read UNDER the invoice-row claim `claimInvoiceRow` holds and BEFORE
  // the status write, so the period read and that write commit against one consistent state; the
  // advisory lock inside serializes this against a concurrent close of the same month (period-locks.ts).
  await assertPeriodOpen(tx, invoice.invoiceDate);

  // Finalize FREEZES the current lines (§5.3): it re-prices nothing, so the number cannot move at the
  // moment of locking. It stamps the finalizer from the actor context (null for a system caller).
  const actor = currentActor();
  // Task 3/§4.3: a finalized INVOICE's `dueDate` = its `invoiceDate` + the customer's
  // `terms.netDays` — a calendar-day add (`addDays`, no weekend skip: a due date is a calendar
  // date). `Terms.netDays` is `Int @default(30)` — never null — so the null case here is a
  // customer with NO terms assigned at all (`Customer.termsId` null -> `invoice.customer.terms`
  // null), not a null `netDays`. A CREDIT never gets a due date (Task 6 owner ruling: it ages from
  // its own `invoiceDate` instead), so the write below is INVOICE-only.
  const netDays = invoice.customer.terms?.netDays ?? null;
  const dueDate = netDays === null ? null : addDays(invoice.invoiceDate, netDays);
  await auditedUpdate("invoice", id,
    () => tx.invoice.update({
      where: { id },
      data: {
        status: "FINALIZED", finalizedAt: new Date(), finalizedById: actor.id,
        ...(invoice.kind === "INVOICE" ? { dueDate } : {}),
      },
    }), { tx });
  // Only an INVOICE owns the order's status (§5.2): finalizing one writes INVOICED. A CREDIT is a
  // correction against an already-invoiced order — it owns no order status, so finalizing it must
  // NOT touch `Order.status` (Task 14). Branch on kind, do not write the order for a CREDIT.
  if (invoice.kind === "INVOICE") {
    await auditedUpdate("order", order.id,
      () => tx.order.update({ where: { id: order.id }, data: { status: "INVOICED" } }), { tx });
  }
  return readInvoiceDetail(tx, id);
}

/**
 * Finalize a DRAFT invoice, locking it (§5.5). `tx` is optional: the discriminating concurrency test
 * passes a manually-opened transaction so the row lock, not SSI, is what serializes a competing
 * caller (the `createInvoice` shape). The public no-`tx` path runs Serializable, pairing with the
 * claim exactly as every other invoice mutator does.
 */
export async function finalizeInvoice(id: string, tx?: Prisma.TransactionClient): Promise<InvoiceDetail> {
  if (tx) return finalizeInvoiceInTx(tx, id);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(
    (fresh) => finalizeInvoiceInTx(fresh, id),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

/**
 * Unlock a FINALIZED invoice back to DRAFT (§5.5), re-permitting every draft edit. The reason is
 * required and trimmed IN THE SERVICE (§5.17 — the `voidShipper`/`discardInvoice` precedent) and
 * recorded on the audit entry, never a column and never printed. Stays available after the invoice
 * has printed.
 *
 * Order matters: clear the invoice's finalized state FIRST, then hand the order back to the ledger.
 * The order sits at INVOICED — an invoice-owned state `recomputeOrderStatus` skips — so it is passed
 * in the `released` set, which lifts the skip for THIS order alone (a shipment-side recompute still
 * leaves INVOICED alone) and lets recompute settle it on its ship-derived value. Recomputing before
 * clearing would leave the order INVOICED forever.
 */
async function unlockInvoiceInTx(tx: Db, id: string, why: string): Promise<InvoiceDetail> {
  const { invoice, order } = await claimInvoiceRow(tx, id);
  if (invoice.status !== "FINALIZED") {
    throw new HttpError(400, "That invoice is not finalized — there is nothing to unlock");
  }
  // Task 9 (§5.3): a finalized invoice with live A/R activity — a payment/discount/write-off applied
  // to it, or a credit applied against it — cannot be unlocked. Unlocking would re-open editable
  // paper that money has already been applied to; the correction is to void the application first.
  // Read under the claim `claimInvoiceRow` holds: `applyPayment`/`applyCredit` write these rows under
  // the SAME order claim, so this read and the status write it guards see one consistent state.
  if (await hasReceivableActivity(tx, id)) {
    throw new HttpError(400,
      `Invoice #${order.orderNumber} has payments applied — void them before unlocking`);
  }
  // §4.1: unlocking reverses the SALES-journal paper that finalize posted at `invoiceDate`, so it is
  // refused into a CLOSED period for the same reason finalize is (period-locks.ts). Under the claim,
  // before the status write.
  await assertPeriodOpen(tx, invoice.invoiceDate);
  await auditedUpdate("invoice", id,
    () => tx.invoice.update({
      where: { id },
      data: { status: "DRAFT", finalizedAt: null, finalizedById: null },
    }), { tx, reason: why });
  await recomputeOrderStatus(tx, [order.id], [order.id]);
  return readInvoiceDetail(tx, id);
}

export async function unlockInvoice(id: string, reason: string, tx?: Prisma.TransactionClient): Promise<InvoiceDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to unlock an invoice");
  // `tx` optional — the discriminating concurrency test passes a manually-opened (Read Committed)
  // transaction so the order+invoice-row claim, not SSI, is what serializes a competing application
  // (the `finalizeInvoice` shape). The public no-`tx` path runs Serializable, pairing with the claim.
  if (tx) return unlockInvoiceInTx(tx, id, why);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(
    (fresh) => unlockInvoiceInTx(fresh, id, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 14 (§5.5/§5.6): credits. A credit is the correction for an already-FINALIZED invoice — it
// derives from a live FINALIZED INVOICE, copies its header and every line with the MONEY sign
// flipped (quantities and weights stay as billed — the paper says what was billed, the money says
// which way it flows), and carries its own `credit_number_next`, NOT an invoice number. It is a
// DRAFT document with its own draft->finalized lifecycle (Task 12's edits, Task 13's finalize),
// and finalizing it writes no order status (the `kind` branch in `finalizeInvoiceInTx`).
// -------------------------------------------------------------------------------------------

/** Money negates, quantity does not. `-0` reads back from Postgres as `+0`, so normalize a zero
 *  line (a PART line always carries `amount = 0`) to `+0` rather than storing `-0`. A Decimal(12,2)
 *  value round-trips through `toNumber()` exactly (its max, 9999999999.99, is well under 2^53), so
 *  negating the number keeps the column's scale on write. */
const negateMoney = (d: Prisma.Decimal) => {
  const n = d.toNumber();
  return n === 0 ? 0 : -n;
};

/**
 * `createCredit` (§5.6). Derives a DRAFT credit from a live FINALIZED INVOICE under the same claim
 * discipline every mutator here uses: `claimInvoiceRow` claims the order row, then locks the SOURCE
 * invoice row `FOR UPDATE`, then re-reads — so the refusals below read the source's status off a row
 * this transaction holds, not a stale snapshot. A credit and its source invoice coexist live: the
 * one-live-invoice-per-order partial index is scoped to `kind = 'INVOICE'`, and a credit is a
 * different kind, so an invoice may be credited more than once.
 *
 * Serializable, pairing with `assertLineRefs`' `assertRefExists` on every FK the copied lines carry
 * (the file's FK-writer pattern) — a GL account / step code / surcharge the source pointed at could
 * have been soft-deleted since it finalized, and fresh paper must not post to a dead account.
 */
export async function createCredit(invoiceId: string): Promise<InvoiceDetail> {
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    // Claim the order, lock and re-read the SOURCE invoice — the guarded state (its status/kind)
    // must be read under the claim. `claimInvoiceRow` 404s a discarded source (deletedAt) already.
    const { invoice: source, order } = await claimInvoiceRow(tx, invoiceId);
    if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
    // A credit derives ONLY from an INVOICE — a credit cannot itself be credited.
    if (source.kind !== "INVOICE") {
      throw new HttpError(400, "That document is a credit, not an invoice — a credit cannot itself be credited");
    }
    // ...and only from a FINALIZED one: a draft is not customer-facing paper, so there is nothing to
    // correct yet (discard or edit it instead).
    if (source.status !== "FINALIZED") {
      throw new HttpError(400,
        `Invoice #${order.orderNumber} is not finalized — only a finalized invoice can be credited`);
    }

    // A credit's number comes from its own series, allocated INSIDE the claim (never hand-rolled).
    const creditNumber = await allocateNumber("credit_number_next", tx);

    // Task 3/§4.3: a credit takes its OWN raise date — never the source invoice's `invoiceDate` —
    // so it ages from its own date (Task 6 owner ruling), not the invoice it corrects. `createCredit`
    // has no `deps` object (unlike `createInvoiceInTx`'s `deps.today`), so `todayDateOnly()` is
    // called directly at this service boundary — once, and reused below in both the create data and
    // the audit `after` snapshot, so the two can never disagree even across a UTC-midnight boundary
    // mid-transaction.
    const creditDate = todayDateOnly();
    // §4.1: a credit is SALES-journal paper effective at its own raise date, so it is refused into a
    // CLOSED period. Under the order claim `claimInvoiceRow` holds, before the audited create; the
    // advisory lock serializes it against a concurrent close of `creditDate`'s month (period-locks.ts).
    await assertPeriodOpen(tx, creditDate);

    // Copy every source line, money sign flipped, everything else (part identity, gl, qty, weight,
    // pricing snapshots) carried as billed. Source lines arrive position-asc (DETAIL_INCLUDE); the
    // copy keeps 1..n so the second-pass parent wiring maps cleanly.
    const lineData = source.lines.map((l, i) => ({
      position: i + 1, kind: l.kind,
      orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
      surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
      partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
      description: l.description, glAccountName: l.glAccountName,
      qty: l.qty, weight: num(l.weight), eachWeight: num(l.eachWeight),
      pricePer: l.pricePer, unitPrice: num(l.unitPrice),
      setupCharge: num(l.setupCharge), minimumCharge: num(l.minimumCharge),
      breakThreshold: num(l.breakThreshold), minimumApplied: l.minimumApplied,
      rate: num(l.rate), priceSource: l.priceSource, needsPrice: l.needsPrice,
      amount: negateMoney(l.amount),
    }));

    // The FK-writer guard, shared verbatim with create/replace/recalculate — no cert extra step
    // code here: a credit only copies the source's stored CERT line (its gl rides on the line), it
    // does not re-resolve the cert charge from BillingConfig.
    await assertLineRefs(tx, lineData);

    // Totals from the already-negated lines, so the header totals and the lines share one sign
    // (never a hand-negated total that could drift from the line it sums). Integer-cent summation.
    const totals = totalsFromLines(lineData);

    // The `after` snapshot, hand-composed like createInvoiceInTx's — the negated line amounts and
    // total are included so the sign flip shows in history from the create entry on.
    const auditData = {
      kind: "CREDIT", status: "DRAFT",
      orderId: source.orderId, orderNumber: order.orderNumber,
      sourceInvoiceId: source.id, creditNumber,
      customerId: source.customerId, customerCode: source.customer.code, customerName: source.customer.name,
      invoiceDate: formatDateOnly(creditDate),
      poNumber: source.poNumber, termsName: source.termsName,
      materialName: source.materialName, processNames: source.processNames,
      taxRate: num(source.taxRate),
      subtotal: totals.subtotal, surchargeTotal: totals.surchargeTotal, chargeTotal: totals.chargeTotal,
      certTotal: totals.certTotal, freightTotal: totals.freightTotal, taxTotal: totals.taxTotal,
      total: totals.total,
      lines: lineData.map((l) => ({
        position: l.position, kind: l.kind, description: l.description,
        glAccountName: l.glAccountName, amount: l.amount,
      })),
    };

    const credit = await auditedCreate("invoice", auditData, async () => {
      const created = await tx.invoice.create({
        data: {
          kind: "CREDIT",
          orderId: source.orderId,
          customerId: source.customerId,
          sourceInvoiceId: source.id,
          creditNumber,
          status: "DRAFT",
          invoiceDate: creditDate,
          poNumber: source.poNumber, termsName: source.termsName,
          billTo: source.billTo, shipTo: source.shipTo,
          materialName: source.materialName, processNames: source.processNames,
          taxRate: source.taxRate,
          ...totals,
          lines: { create: lineData },
        },
        select: { id: true },
      });
      // Second pass for the OPERATION -> PART self-relation, keyed off the SOURCE rows' own ids
      // (positions are preserved 1..n, so `wirePayloadParents` remaps them to the new rows).
      await wirePayloadParents(tx, created.id,
        source.lines.map((l) => ({ key: l.id, parentKey: l.parentLineId })));
      return created;
    }, { tx });

    return readInvoiceDetail(tx, credit.id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 19 (P5A §10): the invoice/credit PRINT — the four-print bracket every document in this
// codebase uses (traveler/ticket/BOL/cert), applied to an invoice: settings read OUTSIDE the
// transaction, then one Serializable transaction bracketing claim → re-read → assertPrintable →
// read-on-tx → render → archive. Reprints reissue the STORED bytes (getDocument), never re-render.
//
// The claim is the load-bearing part (task-19-brief.md's binding requirement, folded in from Task
// 12's review): `discardInvoice` refuses to discard a PRINTED invoice by reading `storedDocument`
// under ITS invoice-row claim, and that invariant lives on the StoredDocument rows, not on the
// Invoice row — so print and discard serialize ONLY if print takes the SAME claim first. Print
// claims the order row then the invoice row (`claimInvoiceForPrint`) BEFORE it inserts the
// StoredDocument; without it a discard and a first print interleave into a discarded invoice with
// an archived PDF that reprints forever (the Phase 4 print-vs-void lesson). Serializable alone is
// NOT the guarantee — the row lock is (the concurrency test, RED with the claim removed).
// -------------------------------------------------------------------------------------------

export type InvoicePrintSettings = {
  company: { name: string; address: string; phone: string };
  remitTo: { name: string; lines: string[] };
};

/** The plant-wide company block, read BEFORE the print transaction opens (the cert/ticket
 *  precedent — a settings read on the top-level client inside a Serializable transaction is the
 *  pool-starvation shape fix-wave R4 finding 8 exists to prevent). `remitTo` is the plant's own
 *  remit address (spec §10's Remit To box); the system carries no separate remit-to setting, so it
 *  is the company itself — the name over the company address split into lines. */
export async function invoicePrintSettings(): Promise<InvoicePrintSettings> {
  const [name, address, phone] = await Promise.all([
    getSetting("company_name"), getSetting("company_address"), getSetting("company_phone"),
  ]);
  return {
    company: { name, address, phone },
    remitTo: { name, lines: address.split("\n").map((l) => l.trim()).filter((l) => l !== "") },
  };
}

const splitAddress = (block: string): string[] => block.split("\n").filter((l) => l !== "");

/** The invoice's whole print payload, off its FROZEN detail (spec §10; invoices.ts's snapshot rule):
 *  the parts from the PART lines, the PRICE grid from the OPERATION lines, and one named total per
 *  surcharge/charge/cert/freight/tax line. `billTo`/`shipTo` are the snapshot strings split into
 *  lines — never a live address re-read, because an invoice is frozen paper. `settings` is optional
 *  so the concurrency and credit tests can call this without threading the company block through. */
export async function readInvoicePdfData(
  db: Db, invoiceId: string, settings?: InvoicePrintSettings,
): Promise<InvoicePdfData> {
  const detail = await readInvoiceDetail(db, invoiceId);
  const s = settings ?? await invoicePrintSettings();
  const linesOf = (kind: InvoiceLineKindValue) => detail.lines.filter((l) => l.kind === kind);
  const amountRows = (kind: InvoiceLineKindValue): InvoiceAmountRow[] =>
    linesOf(kind).map((l) => ({ description: l.description, amount: l.amount }));
  // At most one CERT/FREIGHT/TAX line exists (the engine pushes one of each), so take the first —
  // null when absent, so the totals block renders exactly the rows the invoice actually carries.
  const oneRow = (kind: InvoiceLineKindValue): InvoiceAmountRow | null => {
    const [row] = linesOf(kind);
    return row ? { description: row.description, amount: row.amount } : null;
  };

  return {
    company: s.company,
    remitTo: s.remitTo,
    billTo: splitAddress(detail.billTo),
    shipTo: splitAddress(detail.shipTo),
    title: detail.kind === "CREDIT" ? "Credit" : "Invoice",
    documentNumber: detail.documentNumber,
    invoiceDate: detail.invoiceDate,
    termsName: detail.termsName,
    orderNumber: detail.orderNumber,
    poNumber: detail.poNumber,
    materialName: detail.materialName,
    processNames: detail.processNames,
    parts: linesOf("PART").map((l) => ({
      qty: l.qty, partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
      eachWeight: l.eachWeight, totalWeight: l.weight,
    })),
    priceRows: linesOf("OPERATION").map((l) => ({
      description: l.description,
      pricePerLabel: l.pricePer ? PRICE_PER_LABELS[l.pricePer] : "",
      unitPrice: l.unitPrice, minimumCharge: l.minimumCharge, setupCharge: l.setupCharge,
      amount: l.amount,
    })),
    subtotal: detail.subtotal,
    surchargeRows: amountRows("SURCHARGE"),
    chargeRows: amountRows("CHARGE"),
    certRow: oneRow("CERT"),
    freightRow: oneRow("FREIGHT"),
    taxRow: oneRow("TAX"),
    total: detail.total,
  };
}

/**
 * The PRINT claim: `claimInvoiceRow`'s discipline (Order row, then the Invoice row `FOR UPDATE`, one
 * fixed order — order-locks.ts house rule), but it does NOT 404 a discarded invoice. It returns the
 * row with its `deletedAt` intact so `printInvoice` can refuse a NEW print with the shared
 * VOIDED_PRINT 400 (`assertPrintable`) while every STORED print stays reprintable forever (§5.6).
 * This is the claim print and discard must SHARE for the two to serialize.
 */
async function claimInvoiceForPrint(tx: Db, id: string): Promise<{ invoice: DetailRow; order: Order }> {
  const stub = await tx.invoice.findFirst({ where: { id }, select: { orderId: true } });
  if (!stub) throw new HttpError(404, "Invoice not found");
  const order = await claimOrder(tx, stub.orderId);
  if (!order) throw new HttpError(404, "Invoice not found");
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!invoice) throw new HttpError(404, "Invoice not found");
  return { invoice, order };
}

async function printInvoiceInTx(
  tx: Db, id: string, settings: InvoicePrintSettings,
): Promise<{ documentId: string; documentNumber: string; pdf: Buffer }> {
  const { invoice, order } = await claimInvoiceForPrint(tx, id);
  // Read under the claim just taken (its whole point): a voided ORDER produces no new paper of any
  // kind (§5.6), and a discarded invoice refuses a NEW print while its stored prints remain
  // reprintable. Both refuse with the shared VOIDED_PRINT 400.
  assertPrintable(order);
  assertPrintable(invoice);

  const data = await readInvoicePdfData(tx, id, settings);
  const pdf = await renderPdf(buildInvoiceDefinition(data));

  // The kind follows the invoice ROW's own kind — a credit archives as CREDIT, an invoice as
  // INVOICE, both owning `invoiceId` alone (the kind→owner CHECK). This insert is the ONE mutation
  // here, through the sanctioned `storeDocument` path, on `tx`, UNDER the claim above — so the
  // archive cannot commit against a state (a concurrent discard) that changed out from under it.
  const doc = await storeDocument(
    tx, { kind: invoice.kind === "CREDIT" ? "CREDIT" : "INVOICE", invoiceId: id }, pdf);
  return { documentId: doc.id, documentNumber: data.documentNumber, pdf };
}

/**
 * Render, archive and return the invoice/credit PDF (spec §10, §5.6's print/reprint contract). A
 * voided order or discarded invoice refuses a NEW print; a reprint of a STORED document is the
 * download route's job (`getDocument`), not this function's, and stays available forever.
 *
 * `tx` is optional: the discriminating concurrency test passes a manually-opened transaction so the
 * row lock — not SSI — is what serializes a competing discard (the `createInvoice`/`finalizeInvoice`
 * precedent). The public no-`tx` path runs Serializable, pairing the claim with the archive insert.
 */
export async function printInvoice(
  invoiceId: string, tx?: Prisma.TransactionClient,
): Promise<{ documentId: string; documentNumber: string; pdf: Buffer }> {
  const settings = await invoicePrintSettings(); // OUTSIDE the transaction (the cert/ticket precedent)
  if (tx) return printInvoiceInTx(tx, invoiceId, settings);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(
    (fresh) => printInvoiceInTx(fresh, invoiceId, settings),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

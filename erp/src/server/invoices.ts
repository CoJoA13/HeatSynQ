import { z } from "zod";
import { Prisma, type Order } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors, retryAllocation } from "./db-errors";
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
  priceOrder, taxOnLines,
  type PricingInput, type OrderLineInput, type PriceRowInput, type SurchargeInput, type ChargeInput,
  type GlRef, type ComputedLine,
} from "./pricing";
import { parseDateOnly, formatDateOnly, todayDateOnly, dateOnly, addDays } from "../lib/business-days";
import {
  INVOICE_LINE_KINDS, PRICE_SOURCES, invoiceDocumentNumber,
  type InvoiceKindValue, type InvoiceStatusValue, type InvoiceLineKindValue, type PriceSourceValue,
} from "../lib/invoice-constants";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "../lib/part-constants";
import { renderPdf, jpegDataUri, pngDataUri } from "./pdf/render";
import { buildInvoiceDefinition, type InvoicePdfData, type InvoiceAmountRow } from "./pdf/invoice";
import { storeDocument, assertPrintable } from "./documents";
import { resolveTemplateForPrint } from "./template-assignments";

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
  rate: number | null; priceSource: PriceSourceValue | null;
  /** Frozen at line write when `priceSource = QUOTE`, read UNCONDITIONALLY (the frozen-paper
   *  rule): a later quote delete must never blank sent paper. Never a live join to the quote. */
  sourceQuoteNumber: number | null;
  needsPrice: boolean;
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
  // `netDays` drives `dueDate` at finalize; the discount pair is frozen onto the invoice there too
  // (#79), so the claim reads all three from the customer's terms in one go.
  customer: {
    select: {
      code: true, name: true,
      terms: { select: { name: true, netDays: true, discountPercent: true, discountDays: true } },
    },
  },
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
    rate: num(l.rate), priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
    needsPrice: l.needsPrice,
    amount: l.amount.toNumber(),
  };
}

function toInvoiceDetail(row: DetailRow, prefix: string): InvoiceDetail {
  return {
    id: row.id, kind: row.kind, status: row.status,
    orderId: row.orderId, orderNumber: row.order.orderNumber,
    documentNumber: invoiceDocumentNumber(row.kind, row.creditNumber, row.order.orderNumber, prefix),
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
    documentNumber: invoiceDocumentNumber(row.kind, row.creditNumber, row.order.orderNumber, prefix),
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

/** Seam #1's account, resolved id + name, for the paths that do not build a whole pricing input —
 *  today `replaceInvoiceLines` (#62). Read on the top-level client OUTSIDE the transaction, the
 *  `loadInvoiceDeps` discipline. `buildPricingInput` resolves the same pair from the batch of
 *  config accounts it already reads, and the two must agree: an engine-generated charge and a
 *  hand-typed one post to the SAME account or the export splits one charge class in two. */
async function otherChargeGlRef(): Promise<GlRef> {
  const { otherChargeGlAccountId: id } = await getBillingConfig();
  if (id === null) return { glAccountId: null, glAccountName: "" };
  const row = await prisma.glAccount.findFirst({ where: { id }, select: { name: true } });
  return { glAccountId: id, glAccountName: row?.name ?? "" };
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
  processName: string;
  billForCert: boolean | null; certCharge: Prisma.Decimal | null; material: { name: string } | null;
};
type OrderLineRow = { id: string; position: number; partId: string; quoteLineId: string | null; part: LeadPart };

/** The `select` both `createInvoiceInTx` and `recalculateInvoice` read order lines with — one
 *  shape, so the two assembly paths can never see different line facts. `quoteLineId` is the
 *  Phase 6 tier-1 switch (§5.3): its presence swaps the line's price-row source below. */
const ORDER_LINE_SELECT = {
  id: true, position: true, partId: true, quoteLineId: true,
  part: {
    select: {
      partNumber: true, name: true, description: true, eachWeight: true, processName: true,
      billForCert: true, certCharge: true, material: { select: { name: true } },
    },
  },
} satisfies Prisma.OrderLineSelect;

/**
 * The two INVARIANT asserts a stored quote link has to satisfy — that its target is live, and that
 * it quotes the SAME part the order line does. Neither is an expected failure (plain Error → the
 * handler's 500): §5.14 refuses deleting or re-pointing a quote line any order line references, and
 * every stored link was judged at save time (quote-links.ts), so a dead or wrong-part target here is
 * corrupt state. Falling back to part rows instead would be the silent re-price §7.5 exists to
 * prevent.
 *
 * Split out of `quotePriceRowInputs` below (#96) so a caller that only needs to REFUSE corrupt state
 * — the zero-net line the pricing loop skips — pays for one read rather than also fetching price
 * rows it would discard. Returns the quote line, so the pricing path pays for one read as well.
 */
async function assertQuoteLinkSound(
  tx: Db, ol: { id: string; partId: string; quoteLineId: string },
): Promise<{ id: string; quote: { quoteNumber: number } }> {
  const quoteLine = await tx.quoteLine.findFirst({
    where: { id: ol.quoteLineId },
    select: {
      id: true, partId: true, deletedAt: true,
      quote: { select: { quoteNumber: true, deletedAt: true } },
    },
  });
  if (!quoteLine || quoteLine.deletedAt !== null || quoteLine.quote.deletedAt !== null) {
    throw new Error(
      `Order line ${ol.id} links quote line ${ol.quoteLineId}, which is deleted or missing — ` +
      "§5.14 makes this unreachable; refusing to price the line");
  }
  if (quoteLine.partId !== ol.partId) {
    throw new Error(
      `Order line ${ol.id} links quote line ${ol.quoteLineId}, which quotes a different part ` +
      `(${quoteLine.partId ?? "free-text"} vs ${ol.partId}) — refusing to price the line`);
  }
  return quoteLine;
}

/**
 * Tier-1 substitution (Phase 6 spec §5.3, rulings 4 + 8): the `PriceRowInput[]` for an order line
 * that carries a quote link — the linked quote line's LIVE `QuotePrice` rows with their LIVE
 * breaks, WHOLESALE. When the link is taken the part's rows are not fetched, not merged, not
 * fallen back to: a linked line with zero live rows returns `[]`, which the engine prices as
 * tier 3's needs-price — the link declared the agreement, and an empty agreement is a flag, not
 * permission to bill something else.
 *
 * Reads run on the invoice transaction's OWN client (the #60 lesson): the eligibility the link
 * was judged under is order-entry's business; what matters HERE is that a concurrent quote edit
 * lands inside this Serializable transaction's read set, so SSI sees it.
 *
 * Shape rules, mirrored from `listPartPrices` (part-prices.ts) so tier 1 and tier 2 resolve
 * identically: GL comes from each row's STEP CODE (`glAccountId` + live account name, `?? ""` —
 * quote rows deliberately carry no GL columns, spec §4.1), rows order `position asc, id asc`,
 * breaks `threshold asc`, live-rows-only throughout — and every read here is keyed through the
 * LIVE parent `assertQuoteLinkSound` just verified (the Task 4 dangling-grandchildren shape: live
 * breaks can exist under a soft-deleted row; keying breaks through the live rows is what keeps them
 * unreachable).
 */
async function quotePriceRowInputs(
  tx: Db, ol: { id: string; partId: string; quoteLineId: string },
): Promise<PriceRowInput[]> {
  const quoteLine = await assertQuoteLinkSound(tx, ol);

  const rows = await tx.quotePrice.findMany({
    where: { quoteLineId: quoteLine.id, deletedAt: null },
    include: {
      processStepCode: {
        select: { code: true, name: true, glAccountId: true, glAccount: { select: { name: true } } },
      },
      breaks: { where: { deletedAt: null }, orderBy: { threshold: "asc" } },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    processStepCodeId: r.processStepCodeId,
    stepCode: r.processStepCode.code, stepName: r.processStepCode.name,
    glAccountId: r.processStepCode.glAccountId,
    glAccountName: r.processStepCode.glAccount?.name ?? "",
    position: r.position,
    setupCharge: num(r.setupCharge), unitPrice: num(r.unitPrice), minimumCharge: num(r.minimumCharge),
    pricePer: r.pricePer,
    breaks: r.breaks.map((b) => ({ threshold: b.threshold.toNumber(), price: b.price.toNumber() })),
    priceSource: "QUOTE",
    sourceQuoteNumber: quoteLine.quote.quoteNumber,
  }));
}

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

  // Operation lines — one per order line with a NON-ZERO net shipped total (seam #3). The row
  // source is the Phase 6 tier fork (§5.3): a linked line's rows come from its quote line
  // WHOLESALE (`quotePriceRowInputs` — the part's rows are not even fetched, ruling 4); an
  // unlinked line reads `listPartPrices` exactly as before.
  const lines: OrderLineInput[] = [];
  for (const ol of orderLines) {
    const totals = shipped.get(ol.id) ?? { qty: 0, weight: 0 };
    if (totals.qty === 0 && totals.weight === 0) {
      // #96: a zero-net line is never PRICED (seam #3) — but a corrupt quote link on it is corrupt
      // state either way, and the lead-line header read below resolves `orderLines[0]`'s link
      // UNCONDITIONALLY. So the same corruption threw on a zero-net LEAD line and was silently
      // skipped on a zero-net rider. The asymmetry was the finding; throwing is the safe direction
      // on corrupt state, so the rider is validated here too and the two agree. Constructionally
      // unreachable while the §5.14 guards hold — which is exactly why it must not depend on which
      // position the line happens to occupy.
      if (ol.quoteLineId !== null) {
        await assertQuoteLinkSound(tx, { id: ol.id, partId: ol.partId, quoteLineId: ol.quoteLineId });
      }
      continue;
    }
    const prices: PriceRowInput[] = ol.quoteLineId !== null
      ? await quotePriceRowInputs(tx, { id: ol.id, partId: ol.partId, quoteLineId: ol.quoteLineId })
      // #60: on `tx`, never the singleton — inside a Serializable transaction a second-connection
      // read sits outside the snapshot and the read-set, so SSI cannot see a racing price edit.
      : (await listPartPrices(ol.partId, tx)).map((p) => ({
          processStepCodeId: p.processStepCodeId, stepCode: p.stepCode, stepName: p.stepName, position: p.position,
          setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
          pricePer: p.pricePer, breaks: p.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
          glAccountId: p.glAccountId, glAccountName: p.glAccountName,
        }));
    lines.push({
      orderLineId: ol.id, position: ol.position,
      partNumber: ol.part.partNumber, partName: ol.part.name, partDescription: ol.part.description,
      eachWeight: ol.part.eachWeight.toNumber(),
      shippedQty: totals.qty, shippedWeight: totals.weight,
      prices,
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
  rate: number | null; priceSource: PriceSourceValue | null; sourceQuoteNumber: number | null;
  needsPrice: boolean;
  amount: number;
};

/** `priceOrder`'s computed lines → InvoiceLine write rows at positions 1..n. Seam #1 lands here
 *  (CLAUDE.md / this file's header): a CHARGE line arrives from the pure engine with a null GL
 *  account, so the config's `otherChargeGlAccountId` (and its resolved name) is assigned to CHARGE
 *  lines HERE, exactly as create always did — factored out so recalculate cannot post them to a
 *  different account than create would. */
function mapComputedLines(computedLines: readonly ComputedLine[], otherChargeGl: GlRef): InvoiceLineWrite[] {
  return computedLines.map((l, i) => ({
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
    rate: l.rate, priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
    needsPrice: l.needsPrice, amount: l.amount,
  }));
}

/**
 * The identity a MANUAL line overrides, or null when it carries none.
 *
 * Owner ruling 2026-08-17 (#61): **the manual override wins, silently.** A manual line whose
 * order-side identity matches a regenerated derived line is an OVERRIDE and takes that line's SLOT;
 * one matching nothing is a genuine ADDITION and rides at the end (§5.5). Before this, recalculate
 * regenerated the derived twin AND preserved the override beside it — an outright double bill, and
 * the same shape for every kind, not only the operations the issue was filed about.
 *
 * An OPERATION keys on order line AND step code, so two priced operations on one order line stay
 * distinct — but that identity alone is NOT sufficient, because the derived line can come back under
 * a different step code (the tier-3 "needs price" line carries none at all, `pricing.ts`). The
 * caller therefore falls back to an order-line match; see `recalculateInvoice`. FREIGHT / CERT / TAX
 * are singletons — the engine emits at most one of each — so the kind is the whole identity.
 *
 * The undo path the ruling took INSTEAD of a revert control: remove the row, save, recalculate, and
 * the computed line returns (pinned in `tests/invoices.test.ts`).
 */
function overrideKey(l: {
  kind: InvoiceLineKindValue; orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null;
}): string | null {
  switch (l.kind) {
    case "PART": return l.orderLineId === null ? null : `PART:${l.orderLineId}`;
    case "OPERATION":
      return l.orderLineId === null
        ? null : `OPERATION:${l.orderLineId}:${l.processStepCodeId ?? ""}`;
    case "SURCHARGE": return l.surchargeId === null ? null : `SURCHARGE:${l.surchargeId}`;
    case "CHARGE": return l.orderChargeId === null ? null : `CHARGE:${l.orderChargeId}`;
    case "FREIGHT": case "CERT": case "TAX": return l.kind;
  }
}

/** Seam #1's MANUAL half (#62). The grid renders a charge line's GL account read-only and sends it
 *  blank — and there is deliberately no operator picker (ruling 2026-08-17: the pick-list route
 *  excludes `glAccount`, §5.15) — so the SERVER assigns the same plant default `mapComputedLines`
 *  gives an engine-generated charge. Applied on the whole-array save AND on the recalculate that
 *  preserves the row, so a draft written before the default existed does not stay account-less and
 *  drop out of the GL export. A line that already names an account is never re-pointed. */
function withChargeGl<T extends { kind: InvoiceLineKindValue; glAccountId: string | null; glAccountName: string }>(
  line: T, otherChargeGl: GlRef,
): T {
  if (line.kind !== "CHARGE" || line.glAccountId !== null) return line;
  return { ...line, glAccountId: otherChargeGl.glAccountId, glAccountName: otherChargeGl.glAccountName };
}

/** `assertRefExists` on every registered FK the lines carry (CLAUDE.md's FK-writer pattern; the
 *  Serializable isolation is what this pairs WITH, never a substitute for it). `extraStepCodeIds`
 *  covers the cert charge's step code, which never lands on any line's `processStepCodeId` column
 *  (only its GL account rides along) and so is invisible to the scan otherwise. */
async function assertLineRefs(
  tx: Db,
  lines: { glAccountId?: string | null; processStepCodeId?: string | null; surchargeId?: string | null }[],
  extraStepCodeIds: string[] = [],
): Promise<void> {
  const set = (ids: (string | null | undefined)[]) =>
    new Set(ids.filter((id): id is string => typeof id === "string"));
  const glAccountIds = set(lines.map((l) => l.glAccountId));
  const processStepCodeIds = set(lines.map((l) => l.processStepCodeId));
  for (const id of extraStepCodeIds) processStepCodeIds.add(id);
  const surchargeIds = set(lines.map((l) => l.surchargeId));
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
    select: ORDER_LINE_SELECT,
  });

  const { input, otherChargeGlName } =
    await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
  const computed = priceOrder(input); // the pure engine — all the arithmetic

  // The lead line's priced operations, comma-joined — the invoice header's "process names" (§10).
  // The Phase 6 tier fork applies HERE too (§5.3's wholesale rule reaches every read that
  // assembles this order's price rows): a linked lead line names the QUOTE's operations — the
  // steps this invoice actually bills — and its part's rows are not fetched.
  const lead = orderLines[0] ?? null;
  const leadPrices = lead === null
    ? []
    : lead.quoteLineId !== null
      ? await quotePriceRowInputs(tx, { id: lead.id, partId: lead.partId, quoteLineId: lead.quoteLineId })
      : await listPartPrices(lead.partId, tx); // #60 — the same transaction, for the same reason
  // Ruling 4's invoice half (spec §5.7): the header's Process: snapshot is the lead part's
  // `processName` (presentation vocabulary) when it is non-blank, else today's priced-operation
  // comma-join. CREATE-TIME only — this is the ONLY behavioral change to invoice data, and prints
  // keep reading `Invoice.processNames` UNCONDITIONALLY (frozen paper), so a later processName edit
  // never rewrites raised paper. Pre-existing invoices are untouched (their snapshot already holds
  // the join); a credit copies its source invoice's snapshot as today.
  const leadProcessName = lead?.part.processName ?? "";
  const processNames = leadProcessName.trim() !== ""
    ? leadProcessName
    : leadPrices.map((p) => p.stepName).join(", ");
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
  const lineData = mapComputedLines(computed.lines, otherChargeGl);
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
    // #62: EVERY account-bearing kind, not only the step-code-carrying ones. A hand-typed CHARGE
    // carries no step code, so the old `processStepCodeId !== null` test let it through silently —
    // and 5C's export then drops it (or, since #89, refuses the whole month). The kinds excluded
    // here are the ones that genuinely post nothing: a PART line is a $0 header, and a TAX line's
    // account comes from the billing config at export time, never from the line.
    if (l.kind === "PART" || l.kind === "TAX") continue;
    // A $0 line posts nothing, so it is not a gap — the same test `resolveReadiness` applies, and
    // the two must agree or this warns about a line the export is perfectly happy with.
    if (l.glAccountId === null && Math.round(l.amount * 100) !== 0) {
      // A CHARGE/FREIGHT/CERT line carries a blank part number — fall back to its own description,
      // the same label rule the needs-price warning above uses.
      const label = l.partNumber === "" ? l.description : `${l.partNumber} — ${l.description}`;
      warnings.push(`Line ${l.position} · ${label} has no GL account`);
    }
  }
  for (const l of detail.lines) {
    // Review round 3, and the honest answer to a limit the ruling itself mandates. A typed price on
    // the tier-3 "needs price" line carries NO step code, so it stands in for the WHOLE order line
    // (§5.5 / the #61 ruling) — and it keeps standing in: a priced operation added to that part
    // AFTERWARDS is covered by the typed figure and never bills on its own. That is the ruled
    // behaviour, not a defect, and the stored state genuinely cannot tell "the work this price was
    // typed for" from "work added since. So it is SURFACED rather than guessed at, which is the one
    // thing the recalculate must not do silently.
    if (l.kind === "OPERATION" && l.priceSource === "MANUAL" && l.processStepCodeId === null) {
      const label = l.partNumber === "" ? l.description : `${l.partNumber} — ${l.description}`;
      warnings.push(
        `Line ${l.position} · ${label} is a typed price standing in for every priced operation on ` +
        "this part — re-check it after any pricing change");
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
  // The frozen quote number rides the round-trip: the UI grid echoes every column back on a lines
  // save, and a schema that dropped this one would blank "Quote #N" off the paper on any edit.
  sourceQuoteNumber: z.number().int().nullable().optional(),
  needsPrice: z.boolean().optional(),
  amount: decimalField(12, 2, { required: true }),
}).strict().refine(
  // #98 (whole-branch review F5): the manual-lines save is a trusted, permission-gated, audited
  // surface — but `sourceQuoteNumber` is the frozen tier-1 stamp that prints "Quote #N", and it must
  // not ride a MANUAL (or null-source) line, which would print an agreement number the line never
  // had. This is shape-tightening, not authenticity verification — a live-quote check is a
  // deliberate frozen-paper non-goal (§7.5). The echo-back for genuine QUOTE lines is untouched.
  (l) => l.sourceQuoteNumber === null || l.sourceQuoteNumber === undefined || l.priceSource === "QUOTE",
  { message: "sourceQuoteNumber is only allowed when priceSource is QUOTE", path: ["sourceQuoteNumber"] },
);

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
    rate: l.rate ?? null, priceSource: l.priceSource ?? null,
    sourceQuoteNumber: l.sourceQuoteNumber ?? null,
    needsPrice: l.needsPrice ?? false,
    amount: l.amount,
  };
}

export async function replaceInvoiceLines(id: string, input: unknown): Promise<InvoiceDetail> {
  const data = REPLACE_LINES.parse(input);
  // Seam #1's MANUAL half (#62) — read OUTSIDE the transaction, then applied to every account-less
  // CHARGE the payload carries, so a hand-typed charge can never be persisted posting to nothing.
  const otherChargeGl = await otherChargeGlRef();
  const columns = data.map((l) => withChargeGl(lineColumns(l), otherChargeGl));

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    const { invoice } = await claimLiveInvoice(tx, id);
    // #64's OTHER seam. "Save lines" and "Recalculate" are independent actions — nothing makes an
    // operator recalculate after typing a charge, and finalize freezes whatever is on the invoice —
    // so re-deriving tax only in `recalculateInvoice` still let a taxable charge print under-taxed.
    // Same rule as there: the rate is the invoice's own snapshot, and a MANUALLY overridden TAX line
    // is left exactly as typed (the override wins, uniformly).
    const taxRate = invoice.taxRate === null ? null : invoice.taxRate.toNumber();
    const taxAt = columns.findIndex((c) => c.kind === "TAX");
    if (taxRate !== null && taxAt !== -1 && columns[taxAt].priceSource !== "MANUAL") {
      columns[taxAt] = { ...columns[taxAt], amount: taxOnLines(columns, taxRate) };
    }
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

/** One line of `recalculateInvoice`'s final ordered set. `columns` is the whole write row minus the
 *  three the writer assigns (`invoiceId`/`position`/`parentLineId`) — the Prisma input type rather
 *  than `InvoiceLineWrite`, because a preserved manual row's decimals arrive as `Decimal` while the
 *  engine's arrive as `number`, and both are valid here. `kind`/`amount` are lifted out for the two
 *  passes that read them without caring which side produced the row: the tax recompute and the
 *  totals. */
type RecalcColumns =
  Omit<Prisma.InvoiceLineCreateManyInput, "id" | "invoiceId" | "parentLineId" | "position">
  & { position?: number };
type RecalcLine = {
  key: string; parentKey: string | null; isManual: boolean;
  kind: InvoiceLineKindValue; amount: number; columns: RecalcColumns;
};

// -------------------------------------------------------------------------------------------
// recalculateInvoice — re-price from CURRENT data (new part prices, new surcharges, current shipped
// totals) and replace every DERIVED line (priceSource ≠ MANUAL), keeping the manual ones. It re-runs
// Task 11's whole build — `buildPricingInput` + `priceOrder` + the shared
// `mapComputedLines`/`assertLineRefs` — so it produces exactly what a fresh `createInvoice` would for
// the same order today. There is no second pricing path to drift from.
//
// A manual line is kept in ONE of two places (#61, owner ruling 2026-08-17): substituted into the
// slot of the derived line it overrides, or — matching nothing — appended (§5.5). The whole set is
// then renumbered 1..n and parent-wired through `wirePayloadParents`, the same key-based pass
// `replaceInvoiceLines` uses, so a substituted override keeps its place under its PART line.
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

    // ORDER_LINE_SELECT carries `quoteLineId`, so this whole re-price resolves tier 1 the same
    // way create does (ruling 8's unlock-and-recalculate: the link honored, CURRENT quote rows).
    const orderLines: OrderLineRow[] = await tx.orderLine.findMany({
      where: { orderId: order.id },
      orderBy: { position: "asc" },
      select: ORDER_LINE_SELECT,
    });

    const { input, otherChargeGlName } =
      await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
    const computed = priceOrder(input);
    const otherChargeGl: GlRef = {
      glAccountId: deps.config.otherChargeGlAccountId, glAccountName: otherChargeGlName,
    };
    // The whole previous line set, read before the delete. `manual` is what survives a recalculate
    // (§5.5), re-created below — either in the slot of the derived line it overrides, or at the end
    // if it overrides nothing. The DERIVED identities matter too (review round 2): they are what
    // tells an operation that has newly APPEARED from one that was already being billed in its own
    // right, which is the difference between re-homing an override and stealing a sibling's slot.
    const previous = await tx.invoiceLine.findMany({
      where: { invoiceId: id }, orderBy: { position: "asc" },
    });
    const manual = previous.filter((l) => l.priceSource === "MANUAL");
    const alreadyBilled = new Set(
      previous.filter((l) => l.priceSource !== "MANUAL")
        .map((l) => overrideKey(l))
        .filter((k): k is string => k !== null));

    // #61 (owner ruling 2026-08-17): pair each manual line with the derived line it overrides, by
    // order-side identity. An override REPLACES its twin in place; anything left over is an addition
    // and keeps riding at the end. Pairing on the ENGINE's own key means a manual line whose derived
    // twin no longer exists at all (its order line stopped shipping, say) falls through to the
    // additions rather than vanishing.
    const computedKeyByIdentity = new Map<string, string>();
    const identityByComputedKey = new Map<string, string>();
    const operationKeysByOrderLine = new Map<string, string[]>();
    for (const l of computed.lines) {
      const identity = overrideKey(l);
      if (identity !== null) identityByComputedKey.set(l.key, identity);
      if (identity !== null && !computedKeyByIdentity.has(identity)) computedKeyByIdentity.set(identity, l.key);
      if (l.kind === "OPERATION" && l.orderLineId !== null) {
        operationKeysByOrderLine.set(l.orderLineId,
          [...(operationKeysByOrderLine.get(l.orderLineId) ?? []), l.key]);
      }
    }
    const overrides = new Map<string, (typeof manual)[number]>(); // engine key -> the manual line taking its slot
    const absorbed = new Set<string>(); // engine keys an override standing elsewhere already covers
    const added: (typeof manual)[number][] = [];
    const keyByManualId = new Map<string, string>();
    const isClaimed = (key: string) => overrides.has(key) || absorbed.has(key);

    for (const m of manual) {
      const identity = overrideKey(m);
      const exact = identity === null ? undefined : computedKeyByIdentity.get(identity);
      // `isClaimed` keeps the FIRST claimant of a slot: a second manual line with the same identity
      // rides as an addition rather than being silently dropped.
      let slot = exact !== undefined && !isClaimed(exact) ? exact : undefined;
      let cover: string[] = [];
      if (slot === undefined && exact === undefined && m.kind === "OPERATION" && m.orderLineId !== null) {
        // REVIEW ROUND 1 — a step-exact identity is not enough, and the miss double-billed exactly
        // as the original #61 did. An operation can legitimately regenerate under a step code the
        // override does not name: the operator typed into the tier-3 "needs price" line (which
        // carries NO step code) and the shop has since priced the part, or the operation's part
        // price was retired and re-added under a different step code. So an unmatched OPERATION
        // override falls back to its ORDER LINE.
        //
        // REVIEW ROUND 2 — and only onto an operation that has APPEARED SINCE. Re-homing onto any
        // free operation traded the double bill for its mirror: on a line pricing steps A and B,
        // with A overridden and then A's price retired, the override took B's slot and B's revenue
        // vanished from customer paper. An operation that was ALREADY on the invoice as its own
        // derived line is not the one this override replaced — it is a sibling, and it keeps its
        // line. When nothing qualifies, the override rides as an addition where the operator can
        // see it, which is the honest answer to an ambiguity rather than a guess at money.
        //
        // How much it takes is the remaining care. A manual line with NO step code overrode a line
        // standing for the WHOLE order line, so it covers every operation that line now prices; one
        // whose step code merely no longer prices replaced ONE operation, so it takes one.
        const free = (operationKeysByOrderLine.get(m.orderLineId) ?? []).filter((k) => {
          if (isClaimed(k)) return false;
          // Fails CLOSED: an operation whose identity cannot be read is not re-homed onto. Every key
          // here comes from an OPERATION with a non-null `orderLineId`, for which `overrideKey` never
          // returns null, so this is unreachable — but the permissive direction would silently
          // resurrect the sibling-erasure round 2 closed, and that is not a trade worth taking.
          const derivedIdentity = identityByComputedKey.get(k);
          return derivedIdentity !== undefined && !alreadyBilled.has(derivedIdentity);
        });
        [slot, ...cover] = m.processStepCodeId === null ? free : free.slice(0, 1);
      }
      if (slot !== undefined) {
        overrides.set(slot, m);
        for (const key of cover) absorbed.add(key);
        keyByManualId.set(m.id, slot);
      } else {
        added.push(m);
        keyByManualId.set(m.id, `manual:${m.id}`);
      }
    }

    /** A preserved manual row as a write, with seam #1 backfilled (#62). */
    const manualWrite = (m: (typeof manual)[number]): RecalcColumns => withChargeGl({
      kind: m.kind,
      orderLineId: m.orderLineId, processStepCodeId: m.processStepCodeId,
      surchargeId: m.surchargeId, orderChargeId: m.orderChargeId, glAccountId: m.glAccountId,
      partNumber: m.partNumber, partName: m.partName, partDescription: m.partDescription,
      description: m.description, glAccountName: m.glAccountName,
      qty: m.qty, weight: m.weight, eachWeight: m.eachWeight,
      pricePer: m.pricePer, unitPrice: m.unitPrice, setupCharge: m.setupCharge,
      minimumCharge: m.minimumCharge, breakThreshold: m.breakThreshold, minimumApplied: m.minimumApplied,
      rate: m.rate, priceSource: m.priceSource, sourceQuoteNumber: m.sourceQuoteNumber,
      needsPrice: m.needsPrice, amount: m.amount,
    }, otherChargeGl);

    // The final ordered set: derived lines in engine order, each swapped for its override where one
    // exists, then the genuine additions. Positions stay 1..n and contiguous, so a substituted
    // override keeps its place under its PART line instead of becoming a trailing orphan.
    const derivedWrites = mapComputedLines(computed.lines, otherChargeGl);
    const ordered: RecalcLine[] = computed.lines.flatMap((l, i) => {
      // Covered by an override standing in another slot — dropped outright, never billed twice.
      // OPERATION lines are never a parent, so nothing is orphaned by this; and `wirePayloadParents`
      // leaves a child flat rather than dangling if a `parentKey` names no line in the set.
      if (absorbed.has(l.key)) return [];
      const m = overrides.get(l.key);
      if (m !== undefined) {
        return [{
          key: l.key, parentKey: l.parentKey, isManual: true,
          kind: m.kind, amount: m.amount.toNumber(), columns: manualWrite(m),
        }];
      }
      return [{
        key: l.key, parentKey: l.parentKey, isManual: false,
        kind: l.kind, amount: l.amount, columns: derivedWrites[i],
      }];
    }).concat(added.map((m) => ({
      key: keyByManualId.get(m.id)!,
      parentKey: m.parentLineId === null ? null : (keyByManualId.get(m.parentLineId) ?? null),
      isManual: true, kind: m.kind, amount: m.amount.toNumber(), columns: manualWrite(m),
    })));

    const certStepIds = input.cert && deps.config.certChargeStepCodeId ? [deps.config.certChargeStepCodeId] : [];
    await assertLineRefs(tx, ordered.map((o) => o.columns), certStepIds);

    // #64: the engine priced its TAX line over ITS OWN lines — before any override was substituted
    // in and before the preserved manual lines existed, so a taxable hand-typed charge went untaxed
    // and an overridden operation was taxed at the figure the operator overrode away. Recompute over
    // the FINAL set. A MANUALLY overridden TAX line is left exactly as typed: the override wins,
    // uniformly, and re-deriving it here would be the very thing #61 forbids.
    const taxRate = input.tax?.rate ?? null;
    const tax = ordered.find((o) => o.kind === "TAX");
    if (taxRate !== null && tax !== undefined && !tax.isManual) {
      tax.amount = taxOnLines(ordered, taxRate);
      tax.columns = { ...tax.columns, amount: tax.amount };
    }

    const totals = totalsFromLines(ordered);

    await auditedUpdate("invoice", id, async () => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceLine.createMany({
        // Spread first, then stamp: the engine's writes carry their own `position`, and the set is
        // renumbered 1..n here so a substituted override and a trailing addition land in one series.
        data: ordered.map((o, i) => ({ ...o.columns, invoiceId: id, position: i + 1 })),
      });
      // One wiring pass over the whole set, keyed the same way `replaceInvoiceLines` keys its
      // payload: a substituted override inherits the engine parentKey of the line it replaced, so it
      // stays under its PART line, and an added manual line keeps a manual parent. A parentKey
      // naming no line in the set leaves the child flat rather than dangling.
      await wirePayloadParents(tx, id, ordered);

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
  // #63: an invoice with NO LINES has nothing to bill, and the `needsPrice` check below passes
  // VACUOUSLY over an empty set — so an emptied draft used to finalize into a $0 INVOICED order that
  // `listInvoiceCandidates` then excluded, leaving no way to bill the order at all. Owner ruling
  // 2026-08-17: the guard is on the EMPTY LINE SET, not on a zero total — a warranty or no-charge
  // rework legitimately goes out at $0, listing what was done — and it sits at FINALIZE rather than
  // on the save, so a draft may still be emptied while the operator rebuilds it.
  if (invoice.lines.length === 0) {
    throw new HttpError(400,
      "That invoice has no lines — add the work being billed, or discard it");
  }
  // Finalize is refused while any line still needs a price (§5.5). It reads the RESOLVED price
  // already snapshotted on the line (Task 9), so a break-only line does not block. No GL-account
  // check: spec §15 puts that on 5C's export, not here.
  const offending = invoice.lines.find((l) => l.needsPrice);
  if (offending) {
    const label = offending.partNumber === ""
      ? offending.description
      : `${offending.partNumber} — ${offending.description}`;
    throw new HttpError(400, `Line ${offending.position} · ${label} needs a price — price every line before finalizing`);
  }
  // §4.1 / ruling 8: an invoice is RECOGNIZED in the month it is FINALIZED (`finalizedAt` ≈ now),
  // not its document `invoiceDate`. So the period lock guards the FINALIZE date (today) — a
  // July-dated invoice finalized today in August lands in August and must be allowed even if July is
  // closed; conversely it is refused when TODAY's month is closed. The clock is sampled EXACTLY ONCE
  // (`now`, below) and reused for both the guard's date-only month (`dateOnly(now)`) and the
  // `finalizedAt: now` stamp on the write — two independent `new Date()` reads could straddle a UTC
  // month boundary (the guard seeing month M open while the stamp lands in M+1), which would
  // reintroduce the closed-month leak this guard exists to close. Read UNDER the invoice-row claim
  // `claimInvoiceRow` holds and BEFORE the status write, so the period read and that write commit
  // against one consistent state; the advisory lock inside serializes this against a concurrent
  // close of the finalize month (period-locks.ts).
  const now = new Date();
  await assertPeriodOpen(tx, dateOnly(now));

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
  // #79: freeze the early-pay pair alongside `dueDate`, and for the same reason. `termsName` has
  // always snapshotted the LABEL, but the discount kept reading the customer's CURRENT terms — so
  // reassigning a customer rewrote what invoices already in their hands were worth, in both
  // directions. An invoice is frozen paper (§5.4), so it carries its own numbers from here.
  // INVOICE-only, exactly like `dueDate`: a CREDIT offers no early-pay discount.
  //
  // The LABEL is re-stamped from those same terms (review round 2). `termsName` is written at CREATE
  // and is editable on a draft, while `dueDate` and the pair are derived at FINALIZE — so the paper
  // could say "2/10 Net 30" over a null pair, promising a discount `applyPayment` would refuse, or
  // say "Net 30" while quietly granting one. Finalize is the moment the paper is issued, so the
  // label and the money are stamped from ONE source there.
  //
  // ALWAYS, including blank when the customer has no terms (reversed in review round 3). Round 2
  // kept the label in the no-terms case to protect operator-typed text, and that exception produced
  // the exact bug it was added to prevent: a draft created under `2/10 Net 30` whose customer's
  // terms are then cleared kept the INHERITED label over a null pair — paper promising a discount
  // `applyPayment` refuses. Nothing in the stored state distinguishes an inherited label from a
  // typed one, so a conditional could only ever guess; the label follows the terms, full stop.
  //
  // The cost, stated rather than hidden: a hand-typed label on an invoice for a customer with no
  // terms record is cleared at finalize. Assigning terms to the customer is the fix that also makes
  // every future invoice right. Restoring the typed label would need real state — an
  // `Invoice.termsId`, or a "was edited" flag set by `updateInvoice` — which is a schema change for
  // a case this shop may never hit; PR #135's thread has it if it ever does.
  const issuedTerms = invoice.customer.terms ?? null;
  const issuedDiscount = {
    termsDiscountPercent: issuedTerms?.discountPercent ?? null,
    termsDiscountDays: issuedTerms?.discountDays ?? null,
    termsName: issuedTerms?.name ?? "",
  };
  await auditedUpdate("invoice", id,
    () => tx.invoice.update({
      where: { id },
      data: {
        status: "FINALIZED", finalizedAt: now, finalizedById: actor.id,
        ...(invoice.kind === "INVOICE" ? { dueDate, ...issuedDiscount } : {}),
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
  // §4.1 / ruling 8: unlocking reverses the SALES-journal paper that finalize posted, removing the
  // invoice from its FINALIZE month's figures — so the lock must guard `finalizedAt`, NOT
  // `invoiceDate`. Guarding on `invoiceDate` would let unlocking a July-dated / August-finalized
  // invoice silently change August's frozen close while only checking July was open (the Task-5
  // closed-month leak class). A FINALIZED invoice always carries `finalizedAt` (stamped at finalize),
  // so it is non-null here. Under the claim, before the status write (period-locks.ts).
  await assertPeriodOpen(tx, invoice.finalizedAt!);
  await auditedUpdate("invoice", id,
    () => tx.invoice.update({
      where: { id },
      data: { status: "DRAFT", finalizedAt: null, finalizedById: null },
    }), { tx, reason: why });
  // #59: branch on `kind` exactly as `finalizeInvoiceInTx` does. Only an INVOICE owns the order's
  // status (§5.2), so only an INVOICE hands it back. Unlocking a CREDIT used to pass the order in
  // the `released` set too, lifting `recomputeOrderStatus`'s INVOICE_OWNED skip and settling the
  // order on its ship-derived status — while the source invoice was still FINALIZED and still owned
  // INVOICED. An invoiced order silently fell back to SHIPPED via finalize-credit → unlock-credit.
  if (invoice.kind === "INVOICE") {
    await recomputeOrderStatus(tx, [order.id], [order.id]);
  }
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
  // `retryAllocation` (#115): `credit_number_next` is claimed under this Serializable transaction, so
  // a concurrent allocation ANYWHERE (another credit, an order save, a shipment) aborted this with
  // 40001 and nothing retried. Safe to re-run whole — the claim/status refusals below re-read under a
  // fresh claim, and `HttpError` refusals are not retryable so a genuine "already credited" or
  // "not finalized" still answers on the first attempt. The period guard is a transaction-scoped
  // advisory lock, released on abort and re-taken by the retry.
  return withDbErrors({ entity: "Invoice" }, () => retryAllocation(() => prisma.$transaction(async (tx) => {
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
    // §4.1 / ruling 8: this creates a DRAFT credit — it posts nothing and touches no A/R until it is
    // FINALIZED through the same `finalizeInvoiceInTx` path, whose own period lock (guarding the
    // finalize date) is the real recognition guard. This create-time guard on `creditDate` (= today)
    // is the consistent current-month guard finalize also uses: it simply refuses raising a credit
    // dated into a CLOSED current month (reopen it first). Under the order claim `claimInvoiceRow`
    // holds, before the audited create; the advisory lock serializes it against a concurrent close of
    // `creditDate`'s month (period-locks.ts).
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
      // The frozen source travels with the copy (§4.2): a credit against quote-priced paper still
      // names "Quote #N" — off its own column, exactly like the invoice it corrects.
      rate: num(l.rate), priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
      needsPrice: l.needsPrice,
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
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })));
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
      // §5.3: a quote-priced operation names its source on the paper — off the line's own FROZEN
      // column (never a live join; the quote may be long deleted). Non-QUOTE lines pass null and
      // print exactly as the approved 5A sample.
      sourceQuoteNumber: l.priceSource === "QUOTE" ? l.sourceQuoteNumber : null,
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

  // §5.2 resolution on THIS claimed transaction at its isolation — correct by §5.1 immutability,
  // not by locking (the printCert/printBol precedent); no template row is claimed and none is
  // needed. BOTH an invoice AND a credit resolve the INVOICE docType (spec §4.1: one contract
  // covers credits — the title/signs are data), on the invoice row's OWN frozen customer id.
  const resolved = await resolveTemplateForPrint(tx, "INVOICE", invoice.customerId);
  // Logo bytes → data URI by the STORED mime type (spec §6.3); the builder renders it only when the
  // config also places it, so an unplaced upload converts nothing.
  const logoDataUri = resolved.logoImage !== null && resolved.config.logo !== null
    ? (resolved.logoMimeType === "image/jpeg"
        ? jpegDataUri(Buffer.from(resolved.logoImage))
        : pngDataUri(Buffer.from(resolved.logoImage)))
    : undefined;

  const data = await readInvoicePdfData(tx, id, settings);
  const pdf = await renderPdf(buildInvoiceDefinition(data, resolved.config, logoDataUri));

  // The kind follows the invoice ROW's own kind — a credit archives as CREDIT, an invoice as
  // INVOICE, both owning `invoiceId` alone (the kind→owner CHECK). This insert is the ONE mutation
  // here, through the sanctioned `storeDocument` path, on `tx`, UNDER the claim above — so the
  // archive cannot commit against a state (a concurrent discard) that changed out from under it.
  // `resolved.versionId` is the §5.2 stamp: exactly which template version produced the paper.
  const doc = await storeDocument(
    tx, { kind: invoice.kind === "CREDIT" ? "CREDIT" : "INVOICE", invoiceId: id }, pdf, resolved.versionId);
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

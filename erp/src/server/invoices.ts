import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate } from "./audit";
import { claimOrder } from "./order-locks";
import { getBillingConfig, type BillingConfigRow } from "./billing-config";
import { listSurcharges, type SurchargeRow } from "./surcharges";
import { listPartPrices } from "./part-prices";
import { listAddresses, type AddressRow } from "./customer-addresses";
import { getSetting } from "./settings";
import { isDuplicateClientRequestId } from "./orders";
import { shippedTotals } from "./ship-ledger";
import {
  priceOrder,
  type PricingInput, type OrderLineInput, type SurchargeInput, type ChargeInput, type GlRef,
} from "./pricing";
import { parseDateOnly, formatDateOnly, todayDateOnly } from "../lib/business-days";
import type {
  InvoiceKindValue, InvoiceStatusValue, InvoiceLineKindValue, PriceSourceValue,
} from "../lib/invoice-constants";
import type { PricePerValue } from "../lib/part-constants";

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
  invoiceDate: string; poNumber: string; termsName: string;
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
  customer: { select: { code: true, name: true } },
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
): Promise<PricingInput> {
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

  return { lines, surcharges: buildSurcharges(surcharges, customer), charges, freight, cert, tax };
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

  const input = await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
  const computed = priceOrder(input); // the pure engine — all the arithmetic

  // The lead line's priced operations, comma-joined — the invoice header's "process names" (§10).
  const leadPrices = orderLines[0] ? await listPartPrices(orderLines[0].partId) : [];
  const processNames = leadPrices.map((p) => p.stepName).join(", ");
  const materialName = orderLines[0]?.part.material?.name ?? "";

  const invoiceDate = data.invoiceDate ? parseDate(data.invoiceDate, "Invoice date") : deps.today;
  const taxRate = input.tax?.rate ?? null;
  const otherChargeGl: GlRef = {
    glAccountId: deps.config.otherChargeGlAccountId,
    glAccountName: deps.config.otherChargeGlAccountId === null
      ? ""
      : (await tx.glAccount.findFirst({ where: { id: deps.config.otherChargeGlAccountId }, select: { name: true } }))?.name ?? "",
  };

  // Seam #1: CHARGE lines arrive from the engine with a null GL account — assign the config's
  // `otherChargeGlAccountId` (and its name) here, or these lines post to no account.
  const lineData = computed.lines.map((l, i) => ({
    position: i + 1,
    kind: l.kind,
    orderLineId: l.orderLineId,
    processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId,
    orderChargeId: l.orderChargeId,
    glAccountId: l.kind === "CHARGE" ? otherChargeGl.glAccountId : l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description,
    glAccountName: l.kind === "CHARGE" ? otherChargeGl.glAccountName : l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice, setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, needsPrice: l.needsPrice,
    amount: l.amount,
  }));

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

    // Second pass for the self-relation: an OPERATION line hangs off its PART line, which a single
    // nested create cannot express (the parent's id does not exist until its own row is written).
    // The engine's line order is stable, so `position = index + 1` maps each computed line's `key`
    // back to the row just written.
    const rows = await tx.invoiceLine.findMany({
      where: { invoiceId: created.id }, select: { id: true, position: true },
    });
    const idByPosition = new Map(rows.map((r) => [r.position, r.id]));
    const positionByKey = new Map(computed.lines.map((l, i) => [l.key, i + 1]));
    for (const [i, l] of computed.lines.entries()) {
      if (l.parentKey === null) continue;
      const childId = idByPosition.get(i + 1)!;
      const parentId = idByPosition.get(positionByKey.get(l.parentKey)!)!;
      await tx.invoiceLine.update({ where: { id: childId }, data: { parentLineId: parentId } });
    }
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
      warnings.push(`Line ${l.position} · ${l.partNumber} — ${l.description} needs a price`);
    }
  }
  for (const l of detail.lines) {
    if (l.processStepCodeId !== null && l.glAccountId === null) {
      warnings.push(`Line ${l.position} · ${l.partNumber} — ${l.description} has no GL account`);
    }
  }
  return warnings;
}

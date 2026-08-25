// #33 — the SHARED internals of the order services (Task 5, spec §5), extracted VERBATIM from
// orders.ts (byte-parity verified) so order-create.ts and order-edit.ts both build on ONE copy of
// the line schemas, the part/quote-link resolution and the detail read. `orders.ts` is now a
// re-exporting barrel over this module plus order-create/order-edit/order-board, so every
// `@/server/orders` import site keeps its path. The §5.14 SSI-pairing contract's canonical
// statement lives on `resolveQuoteLinks` below and is referenced from createOrder/addLine/updateLine.
import { z } from "zod";
import { Prisma, type OrderStatus } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";
import { decimalField } from "./decimal-field";
import { judgeQuoteLine, resolveAutoLink, type QuoteLinkCandidate } from "./quote-links";
import { shippedTotals } from "./ship-ledger";
// Type-only, so it is erased at compile time and adds no runtime edge to shippers.ts.
import type { OrderLineShippedToDate } from "./shippers";
import type { Blocker } from "./reference-blockers";
import { splitLoads } from "../lib/load-split";
import { formatDateOnly, parseDateOnly, todayDateOnly } from "../lib/business-days";
import { computeLight, type TrafficLight } from "../lib/traffic-light";
import type { CertScopeValue } from "../lib/cert-constants";
import { INT4_MAX } from "../lib/order-constants";
import type { Traffic } from "./order-board";
export type OrderWarnings = string[];

export type OrderLineDetail = {
  id: string; position: number; partId: string; revisionNumber: number | null;
  qty: number; weight: number;
  /** The per-line quote link (Phase 6, ruling 5) — minimal display exposure for the entry form
   *  and the hub ("Quote #1006", linked): the stored line id plus the quote's id and number,
   *  live-joined (a linked quote line cannot be deleted — §5.14 — so the join always resolves).
   *  Task 9 builds the UI on these three fields. */
  quoteLineId: string | null; quoteId: string | null; quoteNumber: number | null;
  // Fix-wave R3 finding 6: `serializationRequired` rides on the line's OWN part payload — not a
  // second, caller-supplied parts-catalog lookup — so the hub's serialization warning is governed
  // by `orders.view` (this DTO's own gate) rather than an unrelated `parts.view` grant.
  part: { id: string; partNumber: string; name: string; customer: { code: string }; serializationRequired: boolean };
};
export type OrderContainerDetail = {
  id: string; position: number; typeId: string; count: number; qty: number | null;
  tareWeight: number | null; grossWeight: number | null; customerContainerId: string; type: { name: string };
};
export type OrderSerialDetail = {
  id: string; lineId: string; position: number; serial: string; description: string;
};
export type OrderLoadDetail = { id: string; loadNumber: number; qty: number | null; weight: number | null };
export type OrderChargeDetail = {
  id: string; position: number; description: string; amount: number | null;
};

export type OrderDetail = {
  id: string; orderNumber: number; customerId: string;
  /** #46: the order's own identifying data, carried UNCONDITIONALLY under this DTO's own gate
   *  (orders.view) — the board already exposes exactly this pair (BoardRow.customerCode/
   *  customerName) under orders.view alone, so the hub must not hide it behind the unrelated
   *  customers.view grant. The hub renders it as plain text without customers.view (no link —
   *  the customer PAGE stays gated) and as the customer link with it. */
  customer: { code: string; name: string };
  poNumber: string; vsOrderNumber: string; customerJobNo: string;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatus; notes: string; linkGroupId: string | null;
  /** Resolved from the part/customer/plant chain and FROZEN at save (spec §6.1) — overridable at
   *  entry and afterwards (updateOrder), never re-derived from a part edited after the fact. */
  certRequired: boolean; certScope: CertScopeValue;
  /** `deletedAt` is set. Voided orders are returned, not hidden — the hub renders them
   *  read-only, and the reason lives in the `auditedSoftDelete` entry (spec §5c). */
  voided: boolean;
  light: TrafficLight;
  /** Derived, never stored: any StoredDocument row for this order (spec §5b). */
  travelerPrinted: boolean;
  /** Shipped-to-date for EVERY line of this order (Task 14b) — the same dense, per-line ledger
   *  `ShipperOrderDetail.orderLineShippedToDate` carries on the shipment page's own GET (Task 14
   *  review, Important #1), riding here for the one page that has no shipper to read it from: the
   *  shipment CREATE page (`/shipping/new`), whose grids prefill to `ordered − shipped` (design
   *  §5.1) from the same order-detail fetch that already supplies their line/container/serial
   *  catalog. One `shippedTotals` call in `readDetail`, the single §5.1 derivation — never a
   *  second arithmetic. Dense: a never-shipped line reports a real 0/0. */
  orderLineShippedToDate: OrderLineShippedToDate[];
  lines: OrderLineDetail[];
  containers: OrderContainerDetail[];
  serials: OrderSerialDetail[];
  loads: OrderLoadDetail[];
  charges: OrderChargeDetail[];
  linkedOrders: { id: string; orderNumber: number }[];
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on the order tables.
//
// Item shapes shared with Task 5's bulk-replace mutators below (replaceContainers/replaceSerials/
// replaceCharges each accept `z.array(<ITEM>)` directly — same validation as a line's nested
// array here, just without an outer CREATE envelope) — extracted once so both paths stay in sync
// by construction rather than by two hand-kept-identical literals.
const SERIAL_ITEM = z.object({
  serial: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
}).strict();

// Fix-wave R3 finding 2: both columns behind these fields (OrderContainer.count/qty,
// schema.prisma) are Postgres `INTEGER` — a value above this reached the nested create or the
// bulk replace unchecked and failed with an unmapped database range error (a 500) rather than
// this schema's own field-anchored 400. Bounding both here catches it before the transaction
// even opens, the same role `LINE_QTY`'s own `.max()` plays for a line's qty just below.
// `INT4_MAX` itself now lives in `../lib/order-constants` (Task 8 review, 2026-08-04) — see that
// module's own comment for why a `const` consumed at module-evaluation time could not stay here
// once `shippers.ts` needed it too.

const CONTAINER_ITEM = z.object({
  typeId: z.string().min(1),
  count: z.number().int().min(1).max(INT4_MAX),
  qty: z.number().int().min(1).max(INT4_MAX).nullable().optional(),
  tareWeight: decimalField(12, 2, { min: "nonnegative" }),
  grossWeight: decimalField(12, 2, { min: "nonnegative" }),
  // §3.22: the ticket's "Cust Cont Id" column — the customer's own identifier for this bin, not
  // one this shop assigns. Built with no present-day user on the owner's explicit instruction.
  // `.optional()`, not `.default("")`: an omitted key stays omitted through to the Prisma create,
  // which is what lets the column's own DB default ("") apply — functionally identical to
  // `.default("")` here, but the brief's exact schema shape is binding.
  customerContainerId: z.string().max(60).optional(),
}).strict();

const CHARGE_ITEM = z.object({
  description: z.string().trim().min(1).max(500),
  amount: decimalField(12, 2, { min: "nonnegative" }),
}).strict();

// Fix-wave R2 finding 3: a sanity bound on any one line's qty, independent of (and reached
// BEFORE, since zod parses ahead of any transaction) the separate load-COUNT cap `runSplitLoads`
// enforces below — a fat-fingered extra zero is refused as a clean validation error rather than
// riding all the way to the split-count check.
const LINE_QTY = z.number().int().min(1).max(10_000_000);

const LINE = z.object({
  partId: z.string().min(1),
  qty: LINE_QTY,
  weight: decimalField(12, 2, { required: true, min: "positive" }),
  serials: z.array(SERIAL_ITEM).max(10_000).default([]),
  // The per-line quote link (Phase 6, spec §5.2 — rulings 5–7). THREE distinct states, so
  // `.nullable().optional()`, never `.default()`: an EXPLICIT id is the operator's re-pick,
  // validated against the full §5.2 eligibility rule (quote-links.ts) and refused with the line
  // and reason named; an EXPLICIT null is "no link" (the line falls to part prices); an ABSENT
  // key gets the server's auto-resolution (latest-effective-wins, tie → higher quote number) —
  // so API callers, the entry UI, and the idempotent replay all behave identically (§5.2).
  quoteLineId: z.string().min(1).nullable().optional(),
}).strict();


// `z.infer<typeof LINE>` — identical to orders.ts's original `CreateInput["lines"][number]` (CREATE's
// `lines` is `z.array(LINE)`), re-expressed here so the shared line helpers below carry no dependency
// on order-create.ts's CREATE schema. #33.
type LineInput = z.infer<typeof LINE>;
// Either the top-level client or a `tx` — readDetail serves both getOrder and the tail of the
// save transaction (customer-addresses.ts's Db precedent).
type Db = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/**
 * `parseDateOnly` at the service boundary. The lib throws a plain `Error` (it has no server
 * import), and every date that crosses the wire has to fail as a field-anchored 400 naming which
 * one was wrong — "Received date", not "invalid input".
 */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/**
 * "Line 2 (ACME · 3541720C3)" — one label shape shared by every line-anchored rejection and
 * every warning, so the operator reads the same identifier in the refusal, in the warning banner
 * and on the saved order. Falls back to the bare position when the part could not be resolved at
 * all, which is the only case where there is nothing to name it with.
 */
function lineLabel(index: number, part?: { partNumber: string; customer: { code: string } }): string {
  return part ? `Line ${index + 1} (${part.customer.code} · ${part.partNumber})` : `Line ${index + 1}`;
}

/** "Packing List 072826 — void the shipment first" (or "Packing List 072826, Packing List
 *  072830 — void the shipments first") — the shared tail every spec §5.5 refusal appends once
 *  `shipmentBlockers` (shippers.ts) has found at least one live shipment; never called with an
 *  empty list. Names the remedy, not only the block (Task 9's last-order refusal precedent,
 *  shippers.ts's own `removeOrderFromShipper`). */
function shipmentBlockerTail(blockers: Blocker[]): string {
  return `${blockers.map((b) => b.name).join(", ")} — void the shipment${blockers.length > 1 ? "s" : ""} first`;
}

const PART_SELECT = {
  id: true, partNumber: true, customerId: true, active: true,
  loadQty: true, loadWeight: true, requestDaysOverride: true, serializationRequired: true,
  customer: { select: { code: true } },
} as const;

type ResolvedPart = Prisma.PartGetPayload<{ select: typeof PART_SELECT }>;

/**
 * Resolves every line's part — live, active, and owned by the order's customer (spec §5.1). One
 * query for the distinct ids, then a walk in payload order so the FIRST bad line is the one
 * reported and the same part used twice is fetched once.
 *
 * Only `parts[0]`, the lead, goes on to the orderability check when called from createOrder:
 * riders are deliberately exempt (spec §12.4) — the recipe an order is built from is the lead's.
 *
 * `base` (default 0, `lineLabel`'s own indexing) lets `addLine` (Task 5) reuse this exact
 * validation for its one new rider without mislabeling it: a bare 1-element array would otherwise
 * always read "Line 1" in a rejection, even when the rider lands at position 4 — `base` is that
 * line's real `position - 1`, so the label names the part actually being rejected.
 */
async function resolveLineParts(
  tx: Db, customerId: string, lines: LineInput[], base = 0,
): Promise<ResolvedPart[]> {
  const ids = [...new Set(lines.map((l) => l.partId))];
  const found = await tx.part.findMany({ where: { id: { in: ids }, deletedAt: null }, select: PART_SELECT });
  const byId = new Map(found.map((p) => [p.id, p]));

  return lines.map((line, i) => {
    const part = byId.get(line.partId);
    if (!part) throw new HttpError(400, `${lineLabel(base + i)}: that part does not exist`);
    if (part.customerId !== customerId) {
      throw new HttpError(400, `${lineLabel(base + i, part)}: that part belongs to another customer`);
    }
    if (!part.active) throw new HttpError(400, `${lineLabel(base + i, part)}: that part is inactive`);
    return part;
  });
}

/**
 * Resolves every line's quote link (spec §5.2, rulings 5–7) — the three-way `quoteLineId`
 * semantics documented on LINE above, one shared walk for createOrder and addLine (`base` is
 * `resolveLineParts`' same label offset). Returns the full candidate per linked line so the
 * write stores `quoteLineId` and the audit entry prints the quote NUMBER, never a bare cuid.
 *
 * ⚠️ THE READS HERE ARE LOAD-BEARING BEYOND THEIR ANSWERS — the §5.14 SSI pairing (Task 4's
 * review, Important #1). They MUST run on the caller's own Serializable `tx`, never the bare
 * `prisma` client (the #60 lesson): this in-transaction read of the QuoteLine/Quote rows is the
 * order-side half of the guard that keeps `updateQuote`/`deleteQuote` (quotes.ts) from dropping
 * or re-pointing a quote line this save is concurrently linking to. Their Serializable
 * OrderLine-predicate read plus THIS read plus both sides' writes form the rw-antidependency
 * cycle SSI aborts; without this read (or below Serializable) there is one edge, no cycle, and
 * the link lands on a dead line. The dangerous-direction test in tests/quote-links.test.ts is
 * this contract's tripwire.
 */
async function resolveQuoteLinks(
  tx: Db, customerId: string, receivedDate: Date, lines: LineInput[], parts: ResolvedPart[], base = 0,
): Promise<(QuoteLinkCandidate | null)[]> {
  const out: (QuoteLinkCandidate | null)[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.quoteLineId === null) {
      out.push(null);
    } else if (line.quoteLineId !== undefined) {
      const verdict = await judgeQuoteLine(tx, line.quoteLineId,
        { customerId, partId: line.partId, receivedDate });
      if (!verdict.ok) {
        throw new HttpError(400, `${lineLabel(base + i, parts[i])}: ${verdict.reason}`);
      }
      out.push(verdict.candidate);
    } else {
      out.push(await resolveAutoLink(tx, { customerId, partId: line.partId, receivedDate }));
    }
  }
  return out;
}

/**
 * Σqty and Σweight over the lines. The weight sum runs in integer cents: `decimalField(12, 2)`
 * has already bounded every line to two decimal places, so the cents are exact and the single
 * division back to pounds is the only floating step — load-split.ts's reasoning applied one
 * level up, and what keeps the split's own sums landing on the totals exactly.
 *
 * Typed structurally (`{ qty; weight }[]`, not `LineInput[]`) and exported so Task 6's
 * `resplitLoads` (order-loads.ts) can reuse the exact cents-sum technique against a PERSISTED
 * order's lines (mapped to plain numbers first — Prisma returns `weight` as a `Decimal` off a raw
 * select) rather than re-deriving it — every existing call site already satisfies the narrower
 * shape, so this is a widening, not a breaking change.
 */
export function lineTotals(lines: { qty: number; weight: number }[]): { totalQty: number; totalWeightCents: bigint } {
  const totalQty = lines.reduce((sum, l) => sum + l.qty, 0);
  // Each LINE's cents are exact in a double (a legal line weight fits DECIMAL(12,2) — at most
  // 1e12 cents); the SUM is not — ~9,000 ceiling-weight lines push it past 2^53, and a cent lost
  // here is a cent no downstream arithmetic can recover (Codex PR #141 round 4, the accumulation
  // half of round 3's proration finding). So the sum is BigInt from the first add, and it STAYS
  // cents all the way through `splitLoads` — the pipeline never round-trips through a float
  // total again.
  const cents = lines.reduce((sum, l) => sum + BigInt(Math.round(l.weight * 100)), BigInt(0));
  return { totalQty, totalWeightCents: cents };
}

/**
 * `splitLoads` throws a plain `Error` when the split would exceed `MAX_LOADS` (fix-wave R2
 * finding 3) or when a generated load would overflow `Load.qty`/`Load.weight`'s column ranges
 * (#42) — it lives in src/lib and has no server import, so it cannot throw `HttpError`
 * itself. This is the one seam that translates those refusals into the field-anchored 400 every
 * other boundary in this service uses, the same shape `parseDate` gives `parseDateOnly`'s plain
 * throw. Exported for order-loads.ts's `resplitLoads`, the only other caller of `splitLoads` — a
 * live loadQty/loadWeight cap can be edited down against an existing large order exactly as
 * easily as a create-time one can carry a tiny cap from the start, so both call sites need the
 * identical guard.
 */
export function runSplitLoads(input: Parameters<typeof splitLoads>[0]): ReturnType<typeof splitLoads> {
  try {
    return splitLoads(input);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

/**
 * Names the serial behind an `@@unique([lineId, serial])` violation. P2002 reports which COLUMNS
 * collided, never which VALUE did, and on a keyed-or-pasted serial list naming the value is the
 * entire point — so the payload is re-walked here, in entry order, to find the repeat the
 * database just refused. Only ever runs on the failure path, so the happy path pays nothing.
 *
 * `base` (default 0) is `resolveLineParts`'s same label-offset, forwarded from `createSerials` so
 * `addLine`'s one new rider is named by its real position too.
 */
function duplicateSerialError(lines: LineInput[], parts: ResolvedPart[], base = 0): HttpError {
  for (const [i, line] of lines.entries()) {
    const seen = new Set<string>();
    for (const { serial } of line.serials) {
      if (seen.has(serial)) {
        return new HttpError(400, `${lineLabel(base + i, parts[i])}: serial "${serial}" is entered twice`);
      }
      seen.add(serial);
    }
  }
  return new HttpError(400, "That serial is already on this line");
}

/** Serials hang off lines, so they cannot be part of the order's nested create — they are
 *  written once the line ids exist, keyed by the line's position in the payload. `base` (default
 *  0) is forwarded to `duplicateSerialError` — see `resolveLineParts`'s comment on it. */
async function createSerials(
  tx: Db, orderId: string, lineIds: string[], lines: LineInput[], parts: ResolvedPart[], base = 0,
): Promise<void> {
  const rows = lines.flatMap((line, i) => line.serials.map((s, index) => ({
    orderId, lineId: lineIds[i], position: index + 1, serial: s.serial, description: s.description,
  })));
  if (rows.length === 0) return;
  try {
    await tx.orderSerial.createMany({ data: rows });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw duplicateSerialError(lines, parts, base);
    }
    throw err;
  }
}

const DETAIL_INCLUDE = {
  // #46: the hub header's identity line — see OrderDetail.customer's comment.
  customer: { select: { code: true, name: true } },
  lines: {
    orderBy: { position: "asc" },
    include: {
      part: {
        select: {
          id: true, partNumber: true, name: true, serializationRequired: true,
          customer: { select: { code: true } },
        },
      },
      // The link's display pair (OrderLineDetail's own comment) — quote id + number only.
      quoteLine: { select: { quoteId: true, quote: { select: { quoteNumber: true } } } },
    },
  },
  containers: { orderBy: { position: "asc" }, include: { type: { select: { name: true } } } },
  serials: { orderBy: [{ line: { position: "asc" } }, { position: "asc" }] },
  loads: { orderBy: { loadNumber: "asc" } },
  charges: { orderBy: { position: "asc" } },
  // Existence only — the bytes are never read here, and `travelerPrinted` is the one thing the
  // hub needs from them. Filtered to TRAVELER: since Phase 4, a one-order shipping ticket also
  // stores this order's id on its SHIPPER document, and that must not read as a printed traveler.
  documents: { where: { kind: "TRAVELER" }, select: { id: true }, take: 1 },
} satisfies Prisma.OrderInclude;

type DetailRow = Prisma.OrderGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function toDetail(
  row: DetailRow, linkedOrders: { id: string; orderNumber: number }[], traffic: Traffic,
  shipped: Map<string, { qty: number; weight: number }>,
): OrderDetail {
  return {
    id: row.id, orderNumber: row.orderNumber, customerId: row.customerId,
    customer: row.customer,
    poNumber: row.poNumber, vsOrderNumber: row.vsOrderNumber,
    receivedDate: formatDateOnly(row.receivedDate),
    requestDate: formatDateOnly(row.requestDate),
    targetDate: row.targetDate === null ? null : formatDateOnly(row.targetDate),
    status: row.status, notes: row.notes, linkGroupId: row.linkGroupId,
    customerJobNo: row.customerJobNo,
    certRequired: row.certRequired, certScope: row.certScope as CertScopeValue,
    voided: row.deletedAt !== null,
    light: computeLight(row.requestDate, todayDateOnly(), traffic.mayMissDays, traffic.willMissDays),
    travelerPrinted: row.documents.length > 0,
    // Dense (the shippers.ts `toDetail` shape): `shippedTotals` returns a SPARSE map — a line with
    // no live shipper line has no entry — and the grid needs a real "0 / 0", not a hole.
    orderLineShippedToDate: row.lines.map((l) => {
      const totals = shipped.get(l.id) ?? { qty: 0, weight: 0 };
      return { orderLineId: l.id, shippedToDateQty: totals.qty, shippedToDateWeight: totals.weight };
    }),
    lines: row.lines.map((l) => ({
      id: l.id, position: l.position, partId: l.partId, revisionNumber: l.revisionNumber,
      qty: l.qty, weight: l.weight.toNumber(), part: l.part,
      quoteLineId: l.quoteLineId,
      quoteId: l.quoteLine?.quoteId ?? null,
      quoteNumber: l.quoteLine?.quote.quoteNumber ?? null,
    })),
    containers: row.containers.map((c) => ({
      id: c.id, position: c.position, typeId: c.typeId, count: c.count, qty: c.qty,
      tareWeight: num(c.tareWeight), grossWeight: num(c.grossWeight),
      customerContainerId: c.customerContainerId, type: c.type,
    })),
    serials: row.serials.map((s) => ({
      id: s.id, lineId: s.lineId, position: s.position, serial: s.serial, description: s.description,
    })),
    loads: row.loads.map((l) => ({
      id: l.id, loadNumber: l.loadNumber, qty: l.qty, weight: num(l.weight),
    })),
    charges: row.charges.map((c) => ({
      id: c.id, position: c.position, description: c.description, amount: num(c.amount),
    })),
    linkedOrders,
  };
}

/**
 * Deliberately NOT filtered on `deletedAt`: a voided order is still readable (spec §5c) — the
 * hub renders it read-only rather than pretending it never existed. Linked siblings are listed
 * the same way, voided or not; a group member that has been voided is exactly the kind of thing
 * the panel exists to show.
 *
 * Exported for order-loads.ts (Task 6): its mutators end every write the same way every mutator
 * in THIS file does — read the fresh detail back inside the same `tx` — and re-deriving that read
 * would just be a second, easy-to-drift copy of `DETAIL_INCLUDE`/`toDetail`.
 */
export async function readDetail(db: Db, id: string, traffic: Traffic): Promise<OrderDetail> {
  const row = await db.order.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!row) throw new HttpError(404, "Order not found");
  const linkedOrders = row.linkGroupId
    ? await db.order.findMany({
      where: { linkGroupId: row.linkGroupId, id: { not: id } },
      select: { id: true, orderNumber: true },
      orderBy: { orderNumber: "asc" },
    })
    : [];
  const shipped = await shippedTotals(db, row.lines.map((l) => l.id));
  return toDetail(row, linkedOrders, traffic, shipped);
}

/**
 * Recomputed from the order's CURRENT state, not from what a particular edit changed — so any
 * mutator whose signature carries `warnings` (updateOrder, addLine, updateLine) reports the true
 * relationship even when this call didn't touch qty/weight at all, and an edit that restores the
 * match reports `[]` again rather than remembering it once didn't (spec §5a/§5b). Compared in
 * cents, not the rounded-back-to-dollars quotient: two totals that both divide out to the same
 * float are only guaranteed equal when the integer cents behind them already are, so comparing
 * the cents directly (lineTotals' own technique, inlined here for the loads side too) sidesteps
 * any IEEE754 doubt entirely rather than trusting it.
 *
 * Exported for order-loads.ts (Task 6) — `replaceLoads`/`resplitLoads` report the identical
 * mismatch string on the identical condition, reused rather than retyped.
 */
export function loadsMismatchWarnings(order: OrderDetail): OrderWarnings {
  const lineQty = order.lines.reduce((sum, l) => sum + l.qty, 0);
  const lineCents = order.lines.reduce((sum, l) => sum + Math.round(l.weight * 100), 0);
  const loadQty = order.loads.reduce((sum, l) => sum + (l.qty ?? 0), 0);
  const loadCents = order.loads.reduce((sum, l) => sum + Math.round((l.weight ?? 0) * 100), 0);
  return lineQty === loadQty && lineCents === loadCents
    ? []
    : ["Loads no longer sum to the order — re-split or edit loads"];
}


// #33: symbols that were file-private in orders.ts but are now consumed by order-create.ts and/or
// order-edit.ts. Exported here — but deliberately NOT re-exported by the orders.ts barrel, since they
// were never part of the public `@/server/orders` surface. The already-exported lineTotals/
// runSplitLoads/readDetail/loadsMismatchWarnings and the DTO types keep their own `export` above.
export {
  SERIAL_ITEM, CONTAINER_ITEM, CHARGE_ITEM, LINE_QTY, LINE,
  parseDate, lineLabel, shipmentBlockerTail, resolveLineParts, resolveQuoteLinks, createSerials,
};
export type { LineInput, Db, ResolvedPart };

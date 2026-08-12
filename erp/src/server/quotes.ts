import { z } from "zod";
import { Prisma, type Quote } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { finalizedInvoicesFor } from "./invoice-guards";
import type { Blocker } from "./reference-blockers";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { LOT_WITH_BREAKS } from "./part-prices";
import { currentActor } from "./context";
import { getSetting, allocateNumber } from "./settings";
import { addDays, formatDateOnly, parseDateOnly, todayDateOnly } from "../lib/business-days";
import { toXlsx } from "./excel";
import { listAddresses, type AddressRow } from "./customer-addresses";
import { priceOrder, type PriceRowInput } from "./pricing";
import { assertPrintable, storeDocument } from "./documents";
import { renderPdf } from "./pdf/render";
import { buildQuoteDefinition, type QuotePdfData, type QuotePdfLine } from "./pdf/quote";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "../lib/part-constants";
import { INT4_MAX } from "../lib/order-constants";
import {
  QUOTE_STATUS_LABELS, QUOTE_EXPIRED_LABEL, type QuoteStatusValue,
} from "../lib/quote-constants";

// ============================================================================================
// The quote service (Phase 6, spec §5.1/§5.4). A quote is a STANDING PRICE AGREEMENT (ruling
// 3): born numbered and OPEN, effective over a date window, priced in 5A's exact vocabulary
// (QuotePrice/QuotePriceBreak mirror PartPrice/PartPriceBreak — ruling 2, and this module
// mirrors part-prices.ts's validation shapes for the same reason). "Expired" is DERIVED from
// the expiry date against today — never a status flip, never a job.
//
// This file owns the whole lifecycle: create/read/list/worklist/export (Task 3) and the
// mutation half — update/attach-part/close/reopen/delete (Task 4). Every mutation claims the
// Quote row with SELECT … FOR UPDATE (claimQuote below) before reading the state it acts on;
// the order-side eligibility leaf (quote-links.ts) is Task 5.
// ============================================================================================

export type QuoteBreakRow = { id: string; threshold: number; price: number };
// Deliberately NO GL fields, unlike PartPriceRow's glAccountId/glAccountName (spec §4.1): GL is
// internal and resolved live from the step code at invoice assembly (Task 6) — a quote's read
// model feeds paper a customer sees, and it never carries account numbers.
export type QuotePriceRow = {
  id: string;
  processStepCodeId: string;
  stepCode: string;
  stepName: string;
  position: number;
  setupCharge: number | null;
  unitPrice: number | null;
  minimumCharge: number | null;
  pricePer: PricePerValue;
  notes: string;
  breaks: QuoteBreakRow[];
};
// Part identity resolves live-or-text (spec §4.1): a linked line reads partNumber/partName/
// partDescription/material/eachWeight FROM THE PART, live; a free-text line reads its own
// columns. One field set either way, so no reader ever branches on which kind of line it holds.
export type QuoteLineDetail = {
  id: string;
  position: number;
  partId: string | null;
  partNumber: string;
  partName: string;
  partDescription: string;
  material: string;
  eachWeight: number | null;
  quotedQty: number | null;
  quotedUnlimited: boolean;
  linkedOrderCount: number;
  linkedOrders: { id: string; orderNumber: number }[];
  prices: QuotePriceRow[];
};
export type QuoteDetail = {
  id: string;
  quoteNumber: number;
  status: QuoteStatusValue;
  /** Derived, never stored (ruling 3): OPEN + live + expiryDate strictly before today. */
  expired: boolean;
  customerId: string;
  customerCode: string;
  customerName: string;
  contactId: string | null;
  /** Live-join; renders blank ("") when the contact was later deleted — deletion is deliberately
   *  NOT blocked (spec §4.1): the stored PDFs keep the printed name. */
  contactName: string;
  quoteDate: string;
  effectiveDate: string;
  expiryDate: string;
  followUpDate: string | null;
  rfqNumber: string;
  quotedById: string;
  quotedByName: string;
  endingStatementId: string | null;
  endingStatementName: string;
  endingStatementText: string;
  closeReason: string;
  closedAt: string | null;
  closedByName: string;
  notes: string;
  internalNotes: string;
  deletedAt: string | null;
  lines: QuoteLineDetail[];
};

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on QuotePrice/
// QuotePriceBreak — which mirror PartPrice/PartPriceBreak exactly (ruling 2), so these shapes
// mirror part-prices.ts's PRICE_FIELDS/BREAK_FIELDS: same decimalField scales, same min rules.
// No `position` field: the payload ARRAY ORDER is the print order (the order-lines/invoice-lines
// shape) — position is derived as index + 1, and Task 4's array-replace re-derives it.
const BREAK = z.object({
  threshold: decimalField(12, 2, { required: true, min: "positive" }),
  price: decimalField(12, 4, { required: true, min: "nonnegative" }),
}).strict();

const PRICE = z.object({
  processStepCodeId: z.string().min(1),
  setupCharge: decimalField(12, 2, { min: "nonnegative" }),
  unitPrice: decimalField(12, 4, { min: "nonnegative" }),
  minimumCharge: decimalField(12, 2, { min: "nonnegative" }),
  pricePer: z.enum(PRICE_PER).optional(),
  notes: z.string().max(500).default(""), // the sample's per-row "Quote Notes" line
  breaks: z.array(BREAK).default([]),
}).strict();

// Free-text caps mirror the columns they stand in for: Part.partNumber max 60 / name max 200 /
// description max 4000 (parts.ts FIELDS), reference names max 100 (reference.ts BASE) for the
// material text. eachWeight mirrors Part.eachWeight's Decimal(10, 4), positive.
const LINE = z.object({
  partId: z.string().min(1).nullable().optional(),
  partNumberText: z.string().trim().max(60).default(""),
  partNameText: z.string().max(200).default(""),
  partDescriptionText: z.string().max(4000).default(""),
  materialText: z.string().trim().max(100).default(""),
  eachWeight: decimalField(10, 4, { min: "positive" }),
  quotedQty: z.number().int().min(1).max(INT4_MAX).nullable().optional(),
  quotedUnlimited: z.boolean().default(false),
  prices: z.array(PRICE).default([]),
}).strict();

const CREATE = z.object({
  customerId: z.string().min(1),
  contactId: z.string().min(1).nullable().optional(),
  quoteDate: z.string().optional(),
  effectiveDate: z.string().optional(),
  expiryDate: z.string().optional(),
  followUpDate: z.string().nullable().optional(),
  rfqNumber: z.string().trim().max(200).default(""),
  quotedById: z.string().min(1).optional(),
  // Explicit id = validated pick; explicit null = none; ABSENT = the kind's live default row
  // (ruling 13) — three distinct states, so `.nullable().optional()`, never `.default(...)`.
  endingStatementId: z.string().min(1).nullable().optional(),
  notes: z.string().max(4000).default(""), // prints
  internalNotes: z.string().max(4000).default(""), // never prints (the cert notes-pair precedent)
  lines: z.array(LINE).min(1),
}).strict();

type CreateInput = z.infer<typeof CREATE>;
type LineInput = CreateInput["lines"][number];
type PriceInput = LineInput["prices"][number];

type Db = Prisma.TransactionClient;

// The one line-shape → row-columns mapping, shared by createQuote's nested create and
// updateQuote's create-branch (Task 4's array-replace) so the two can never drift. Positions are
// always derived from array order (index + 1) — the payload array IS the print order.
function priceCreateData(price: PriceInput, position: number) {
  return {
    position,
    processStepCodeId: price.processStepCodeId,
    setupCharge: price.setupCharge ?? null,
    unitPrice: price.unitPrice ?? null,
    minimumCharge: price.minimumCharge ?? null,
    pricePer: price.pricePer ?? ("EACH" as const),
    notes: price.notes,
    breaks: {
      create: price.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
    },
  };
}

function lineCreateData(line: LineInput, position: number) {
  return {
    position,
    partId: line.partId ?? null,
    partNumberText: line.partNumberText,
    partNameText: line.partNameText,
    partDescriptionText: line.partDescriptionText,
    materialText: line.materialText,
    eachWeight: line.eachWeight ?? null,
    quotedQty: line.quotedQty ?? null,
    quotedUnlimited: line.quotedUnlimited,
    prices: { create: line.prices.map((price, j) => priceCreateData(price, j + 1)) },
  };
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/** `parseDateOnly` at the service boundary — the lib throws a plain `Error`, and every date that
 *  crosses the wire must fail as a field-anchored 400 naming which one was wrong (the orders.ts
 *  `parseDate` shape). */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** "Line 2 (ACME · P-100)" for part-linked lines, "Line 2 (FT-1)" for free-text ones, bare
 *  "Line 2" when nothing resolved — the orders.ts `lineLabel` shape, so a rejection names the
 *  same identifier the operator sees on the entry grid. */
function lineLabel(index: number, display?: string): string {
  return display ? `Line ${index + 1} (${display})` : `Line ${index + 1}`;
}

type ResolvedQuoteLine = {
  part: { id: string; partNumber: string } | null;
  label: string;
};

/**
 * Per-line identity and part validation (spec §4.1, ruling 1):
 * - `partId` XOR a non-empty trimmed `partNumberText` (zod has already trimmed it);
 * - quotedQty and quotedUnlimited are mutually exclusive (the paper prints one or the other);
 * - a linked part must exist, be live, and belong to the quote's customer (one query for the
 *   distinct ids, then a walk in payload order so the FIRST bad line is the one reported — the
 *   orders.ts `resolveLineParts` shape). Deliberately NO `active` check, unlike order entry:
 *   inactive hides a part from pick lists, it does not invalidate a standing agreement over it
 *   (the reference-guards precedent), and the Task 3 brief's own rule is "live", not "active".
 */
async function resolveQuoteLines(
  tx: Db, customerId: string, lines: LineInput[],
): Promise<ResolvedQuoteLine[]> {
  for (const [i, line] of lines.entries()) {
    const hasPart = line.partId != null;
    const hasText = line.partNumberText !== "";
    if (hasPart && hasText) {
      throw new HttpError(400, `${lineLabel(i)}: a line cannot carry both a part and a free-text part number`);
    }
    if (!hasPart && !hasText) {
      throw new HttpError(400, `${lineLabel(i)}: each line needs a part or a free-text part number`);
    }
    if (line.quotedQty != null && line.quotedUnlimited) {
      throw new HttpError(400, `${lineLabel(i)}: a line cannot be both quoted for a quantity and unlimited`);
    }
  }

  const ids = [...new Set(lines.flatMap((l) => (l.partId ? [l.partId] : [])))];
  const found = ids.length === 0 ? [] : await tx.part.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, customerId: true, partNumber: true, customer: { select: { code: true } } },
  });
  const byId = new Map(found.map((p) => [p.id, p]));

  // One live line per part per quote (spec §4.1) — SERVICE-enforced, and it must catch two lines
  // for one part inside a single payload: the DB's only unique here is QuotePrice's
  // (quoteLineId, processStepCodeId) partial, which two sibling LINES sail straight through
  // (RED-verified — without this check the create lands both lines).
  const seenParts = new Set<string>();

  return lines.map((line, i) => {
    if (!line.partId) return { part: null, label: lineLabel(i, line.partNumberText) };
    const part = byId.get(line.partId);
    if (!part) throw new HttpError(400, `${lineLabel(i)}: that part does not exist`);
    const label = lineLabel(i, `${part.customer.code} · ${part.partNumber}`);
    if (part.customerId !== customerId) {
      throw new HttpError(400, `${label}: that part belongs to another customer`);
    }
    if (seenParts.has(part.id)) {
      throw new HttpError(400, `${label}: that part is already quoted on this quote`);
    }
    seenParts.add(part.id);
    return { part: { id: part.id, partNumber: part.partNumber }, label };
  });
}

/**
 * Price-row validation, mirroring part-prices.ts rule for rule:
 * - every step code live (`assertRefExists` — the FK-writer pattern's read half, on this same
 *   Serializable `tx`);
 * - one row per step code per LINE — the service message beats the partial unique's P2002, and
 *   catches the two-rows-in-one-payload case the DB check never sees until the insert;
 * - LOT rows refuse breaks (the exact part-prices message, line-anchored);
 * - one break per threshold within a row (same reasoning as the step-code dup).
 * Returns the step id → {code, name} map the audit payload prints instead of cuids.
 */
async function validateQuotePrices(
  tx: Db, lines: LineInput[], resolved: ResolvedQuoteLine[],
): Promise<Map<string, { code: string; name: string }>> {
  const stepIds = [...new Set(lines.flatMap((l) => l.prices.map((p) => p.processStepCodeId)))];
  for (const id of stepIds) await assertRefExists("processStepCode", id, tx);
  const steps = stepIds.length === 0 ? [] : await tx.processStepCode.findMany({
    where: { id: { in: stepIds } }, select: { id: true, code: true, name: true },
  });
  const stepById = new Map(steps.map((s) => [s.id, { code: s.code, name: s.name }]));

  for (const [i, line] of lines.entries()) {
    const seenSteps = new Set<string>();
    for (const price of line.prices) {
      if (seenSteps.has(price.processStepCodeId)) {
        throw new HttpError(400, `${resolved[i].label}: that operation is already priced on this line`);
      }
      seenSteps.add(price.processStepCodeId);
      if ((price.pricePer ?? "EACH") === "LOT" && price.breaks.length > 0) {
        throw new HttpError(400, `${resolved[i].label}: ${LOT_WITH_BREAKS}`);
      }
      const seenThresholds = new Set<number>();
      for (const brk of price.breaks) {
        if (seenThresholds.has(brk.threshold)) {
          throw new HttpError(400, `${resolved[i].label}: a price break with that threshold already exists`);
        }
        seenThresholds.add(brk.threshold);
      }
    }
  }
  return stepById;
}

/**
 * The create entry's `after` snapshot, composed by hand (the orders.ts `auditPayload`
 * precedent): every collection ordered by construction, every foreign key travelling with the
 * live name it points at — history reads "P-100" and "HT", never a cuid. Row ids are absent
 * because they do not exist yet.
 */
function auditPayload(args: {
  quoteNumber: number;
  data: CreateInput;
  customer: { id: string; code: string };
  contactName: string;
  quoteDate: Date; effectiveDate: Date; expiryDate: Date; followUpDate: Date | null;
  quotedById: string; quotedByName: string;
  endingStatementId: string | null; endingStatementName: string;
  resolved: ResolvedQuoteLine[];
  stepById: Map<string, { code: string; name: string }>;
}) {
  const { data, resolved, stepById } = args;
  return {
    quoteNumber: args.quoteNumber,
    customerId: args.customer.id, customerCode: args.customer.code,
    contactId: data.contactId ?? null, contactName: args.contactName,
    // Not written by createQuote — the column default, recorded so the create entry and every
    // later update diff describe the same set of fields.
    status: "OPEN",
    quoteDate: formatDateOnly(args.quoteDate),
    effectiveDate: formatDateOnly(args.effectiveDate),
    expiryDate: formatDateOnly(args.expiryDate),
    followUpDate: args.followUpDate === null ? null : formatDateOnly(args.followUpDate),
    rfqNumber: data.rfqNumber,
    quotedById: args.quotedById, quotedByName: args.quotedByName,
    endingStatementId: args.endingStatementId, endingStatementName: args.endingStatementName,
    notes: data.notes, internalNotes: data.internalNotes,
    lines: data.lines.map((line, i) => ({
      position: i + 1,
      partId: line.partId ?? null,
      partNumber: resolved[i].part?.partNumber ?? line.partNumberText,
      partNameText: line.partNameText, partDescriptionText: line.partDescriptionText,
      materialText: line.materialText,
      eachWeight: line.eachWeight ?? null,
      quotedQty: line.quotedQty ?? null, quotedUnlimited: line.quotedUnlimited,
      prices: line.prices.map((price, j) => ({
        position: j + 1,
        processStepCodeId: price.processStepCodeId,
        stepCode: stepById.get(price.processStepCodeId)?.code ?? "",
        setupCharge: price.setupCharge ?? null,
        unitPrice: price.unitPrice ?? null,
        minimumCharge: price.minimumCharge ?? null,
        pricePer: price.pricePer ?? "EACH",
        notes: price.notes,
        breaks: price.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
      })),
    })),
  };
}

/**
 * One transaction (spec §5.1): allocate the number, write the whole header → lines → prices →
 * breaks tree through `auditedCreate`, read the detail back on the same `tx`.
 *
 * Serializable for the same two reasons `createOrder` is: it assigns registered FKs
 * (`processStepCodeId`, `endingStatementId` — the FK-writer pattern pairs `assertRefExists`'s
 * live read with the write inside one Serializable transaction), and `allocateNumber` claims the
 * Setting counter row with `SELECT … FOR UPDATE` inside it. A concurrent create may therefore
 * lose with a clean 409 (translated by `withDbErrors`) — retried by the caller, never a shared
 * or skipped number. Settings are read BEFORE the transaction opens (the createOrder shape): a
 * second-connection read inside a transaction that locks a Setting row is the deadlock shape.
 *
 * Entry defaults (spec §5.1): quoteDate today; effective = quoteDate; expiry = quoteDate +
 * `quote_valid_days` CALENDAR days (ruling 9 — a validity window, not a lead-time, so no
 * business-day skipping); ending statement = the kind's live default row; quotedBy = the actor.
 *
 * The response carries ruling 7's overlap-save warnings (`overlapWarnings` — advisory, never a
 * refusal), computed inside this same transaction after the write.
 */
export async function createQuote(input: unknown): Promise<QuoteMutationResult> {
  const data = CREATE.parse(input);
  const validDays = await getSetting("quote_valid_days");

  return withDbErrors({ entity: "Quote", conflictField: "quote number" }, () =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: data.customerId, deletedAt: null },
        select: { id: true, code: true, active: true },
      });
      if (!customer) throw new HttpError(400, "That customer does not exist");
      if (!customer.active) throw new HttpError(400, "That customer is inactive");

      let contactName = "";
      if (data.contactId) {
        const contact = await tx.customerContact.findFirst({
          where: { id: data.contactId, customerId: customer.id, deletedAt: null },
          select: { name: true },
        });
        if (!contact) throw new HttpError(400, "That contact does not exist for this customer");
        contactName = contact.name;
      }

      // The actor's own id is the default (spec §5.1), overridable by input. `Quote.quotedById`
      // is NOT NULL — an actor-less caller (a script, a test running "as system") must name one.
      const quotedById = data.quotedById ?? currentActor().id;
      if (!quotedById) throw new HttpError(400, "Quoted by is required when no user is signed in");
      const quotedBy = await tx.user.findFirst({
        where: { id: quotedById, deletedAt: null }, select: { displayName: true },
      });
      if (!quotedBy) throw new HttpError(400, "That quoted-by user does not exist");

      const quoteDate = data.quoteDate ? parseDate(data.quoteDate, "Quote date") : todayDateOnly();
      const effectiveDate = data.effectiveDate
        ? parseDate(data.effectiveDate, "Effective date") : quoteDate;
      const expiryDate = data.expiryDate
        ? parseDate(data.expiryDate, "Expiry date") : addDays(quoteDate, validDays);
      if (effectiveDate.getTime() > expiryDate.getTime()) {
        throw new HttpError(400, "The effective date must be on or before the expiry date");
      }
      const followUpDate = data.followUpDate ? parseDate(data.followUpDate, "Follow-up date") : null;

      let endingStatementId: string | null = null;
      let endingStatementName = "";
      if (data.endingStatementId === undefined) {
        // The kind's live default, if any (ruling 13). Task 2's normalization keeps at most one
        // and strips the flag on deactivation, so a live default is live AND active by
        // construction; a defaultless kind stores null — legal, nothing prints.
        const def = await tx.endingStatement.findFirst({
          where: { isDefault: true, deletedAt: null }, select: { id: true, name: true },
        });
        endingStatementId = def?.id ?? null;
        endingStatementName = def?.name ?? "";
      } else if (data.endingStatementId !== null) {
        await assertRefExists("endingStatement", data.endingStatementId, tx);
        const picked = await tx.endingStatement.findFirst({
          where: { id: data.endingStatementId }, select: { name: true },
        });
        endingStatementId = data.endingStatementId;
        endingStatementName = picked?.name ?? "";
      }

      const resolved = await resolveQuoteLines(tx, customer.id, data.lines);
      const stepById = await validateQuotePrices(tx, data.lines, resolved);

      const quoteNumber = await allocateNumber("quote_number_next", tx);

      const quote = await auditedCreate(
        "quote",
        auditPayload({
          quoteNumber, data, customer, contactName,
          quoteDate, effectiveDate, expiryDate, followUpDate,
          quotedById, quotedByName: quotedBy.displayName,
          endingStatementId, endingStatementName,
          resolved, stepById,
        }),
        () => tx.quote.create({
          data: {
            quoteNumber, customerId: customer.id, contactId: data.contactId ?? null,
            quoteDate, effectiveDate, expiryDate, followUpDate,
            rfqNumber: data.rfqNumber, quotedById, endingStatementId,
            notes: data.notes, internalNotes: data.internalNotes,
            lines: { create: data.lines.map((line, i) => lineCreateData(line, i + 1)) },
          },
          select: { id: true },
        }),
        { tx },
      );

      const detail = await readDetail(tx, quote.id);
      return { ...detail, warnings: await overlapWarnings(tx, quote.id) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

const DETAIL_INCLUDE = {
  customer: { select: { code: true, name: true } },
  // deletedAt rides along so the read can render a deleted contact BLANK (spec §4.1) — the FK
  // itself survives, only the display goes empty.
  contact: { select: { name: true, deletedAt: true } },
  quotedBy: { select: { displayName: true } },
  closedBy: { select: { displayName: true } },
  endingStatement: { select: { name: true, text: true } },
  lines: {
    where: { deletedAt: null },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    include: {
      part: {
        select: {
          partNumber: true, name: true, description: true, eachWeight: true,
          material: { select: { name: true } },
        },
      },
      prices: {
        where: { deletedAt: null },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        include: {
          processStepCode: { select: { code: true, name: true } },
          // threshold is live-rows-unique per price row, so it orders deterministically alone.
          breaks: { where: { deletedAt: null }, orderBy: { threshold: "asc" } },
        },
      },
    },
  },
} satisfies Prisma.QuoteInclude;

type DetailRow = Prisma.QuoteGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** Distinct LIVE orders referencing each quote line (`OrderLine.quoteLineId`), voided orders
 *  excluded — the informational "already pricing real work" summary, NOT the §5.14 blocker query
 *  (Task 4/5's `linkedOpenOrders` owns the close-warning/delete-block semantics). One batched
 *  query for the whole quote, never per line. */
async function linkedOrdersByLine(
  db: Db, lineIds: string[],
): Promise<Map<string, { id: string; orderNumber: number }[]>> {
  if (lineIds.length === 0) return new Map();
  const links = await db.orderLine.findMany({
    where: { quoteLineId: { in: lineIds }, order: { deletedAt: null } },
    select: { quoteLineId: true, order: { select: { id: true, orderNumber: true } } },
  });
  const byLine = new Map<string, Map<string, number>>();
  for (const link of links) {
    if (!link.quoteLineId) continue;
    const orders = byLine.get(link.quoteLineId) ?? new Map<string, number>();
    orders.set(link.order.id, link.order.orderNumber);
    byLine.set(link.quoteLineId, orders);
  }
  return new Map([...byLine.entries()].map(([lineId, orders]) => [
    lineId,
    [...orders.entries()]
      .map(([id, orderNumber]) => ({ id, orderNumber }))
      .sort((a, b) => a.orderNumber - b.orderNumber),
  ]));
}

/** Serves both `getQuote` and the tail of the create transaction (the orders.ts `readDetail`
 *  precedent) — the caller's own client, so a mid-transaction read sees the write in progress. */
async function readDetail(db: Db, id: string): Promise<QuoteDetail> {
  const row: DetailRow | null = await db.quote.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  // A soft-DELETED quote is still readable (the voided-order precedent: shown, never hidden) —
  // only an unknown id 404s. Mutations are what refuse deleted rows (Task 4's claim).
  if (!row) throw new HttpError(404, "Quote not found");

  const linked = await linkedOrdersByLine(db, row.lines.map((l) => l.id));
  const today = todayDateOnly();
  const expired = row.status === "OPEN" && row.deletedAt === null
    && row.expiryDate.getTime() < today.getTime();

  return {
    id: row.id, quoteNumber: row.quoteNumber,
    status: row.status as QuoteStatusValue, expired,
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    contactId: row.contactId,
    contactName: row.contact && row.contact.deletedAt === null ? row.contact.name : "",
    quoteDate: formatDateOnly(row.quoteDate),
    effectiveDate: formatDateOnly(row.effectiveDate),
    expiryDate: formatDateOnly(row.expiryDate),
    followUpDate: row.followUpDate === null ? null : formatDateOnly(row.followUpDate),
    rfqNumber: row.rfqNumber,
    quotedById: row.quotedById, quotedByName: row.quotedBy.displayName,
    endingStatementId: row.endingStatementId,
    endingStatementName: row.endingStatement?.name ?? "",
    endingStatementText: row.endingStatement?.text ?? "",
    closeReason: row.closeReason,
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
    closedByName: row.closedBy?.displayName ?? "",
    notes: row.notes, internalNotes: row.internalNotes,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    lines: row.lines.map((line) => ({
      id: line.id, position: line.position, partId: line.partId,
      partNumber: line.part ? line.part.partNumber : line.partNumberText,
      partName: line.part ? line.part.name : line.partNameText,
      partDescription: line.part ? line.part.description : line.partDescriptionText,
      material: line.part ? (line.part.material?.name ?? "") : line.materialText,
      eachWeight: line.part ? line.part.eachWeight.toNumber() : num(line.eachWeight),
      quotedQty: line.quotedQty, quotedUnlimited: line.quotedUnlimited,
      linkedOrderCount: (linked.get(line.id) ?? []).length,
      linkedOrders: linked.get(line.id) ?? [],
      prices: line.prices.map((price) => ({
        id: price.id, processStepCodeId: price.processStepCodeId,
        stepCode: price.processStepCode.code, stepName: price.processStepCode.name,
        position: price.position,
        setupCharge: num(price.setupCharge),
        unitPrice: num(price.unitPrice),
        minimumCharge: num(price.minimumCharge),
        pricePer: price.pricePer, notes: price.notes,
        breaks: price.breaks.map((b) => ({
          id: b.id, threshold: b.threshold.toNumber(), price: b.price.toNumber(),
        })),
      })),
    })),
  };
}

export async function getQuote(id: string): Promise<QuoteDetail> {
  return readDetail(prisma, id);
}

/** What the three quote mutations return (Task 12): the fresh detail plus ruling 7's
 *  overlap-save warnings — ADVISORY, never blocking. `getQuote` stays a bare detail: the
 *  warnings describe a save the caller just made, not standing state a reader must recompute. */
export type QuoteMutationResult = QuoteDetail & { warnings: string[] };

/**
 * Ruling 7's second sentence (spec §3): "Saving a quote that overlaps an existing open quote for
 * the same part warns but doesn't block." The §5.7 `shipmentWarnings` shape — an advisory
 * surface computed AFTER the write on the caller's own claim-holding `tx`, riding the mutation
 * response — so it describes exactly the state the mutation is committing. WARNS, NEVER BLOCKS:
 * no caller may turn a non-empty result into a refusal.
 *
 * One warning per (part, other-quote): for each live PART-LINKED line of this quote (free-text
 * lines carry no part and never warn), every OTHER live OPEN quote holding a live line for the
 * same part whose [effectiveDate, expiryDate] window overlaps this quote's — INCLUSIVE both
 * ends, the §5.2 eligibility boundary: an order received on the one shared day is priceable by
 * both quotes, which is precisely the ambiguity the warning names. Deterministic order: this
 * quote's lines by position, other quotes ascending by number.
 *
 * Customer scoping is implicit through `partId` (verified for Task 12): `Part.customerId` is a
 * required FK, and every writer of `QuoteLine.partId` (`resolveQuoteLines`, `attachPart`)
 * refuses a part belonging to another customer — so two quotes holding live lines for one part
 * are necessarily the same customer's quotes, and no customer filter is needed here.
 */
async function overlapWarnings(tx: Db, quoteId: string): Promise<string[]> {
  const quote = await tx.quote.findFirst({
    where: { id: quoteId },
    select: {
      status: true, deletedAt: true, effectiveDate: true, expiryDate: true,
      lines: {
        where: { deletedAt: null, partId: { not: null } },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { partId: true, part: { select: { partNumber: true } } },
      },
    },
  });
  // Belt-and-braces: every caller has just mutated a live OPEN quote, but the guard keeps the
  // helper honest if it ever rides another path.
  if (!quote || quote.deletedAt !== null || quote.status !== "OPEN") return [];
  const partIds = quote.lines.flatMap((l) => (l.partId === null ? [] : [l.partId]));
  if (partIds.length === 0) return [];

  const others = await tx.quote.findMany({
    where: {
      id: { not: quoteId }, deletedAt: null, status: "OPEN",
      // Inclusive-boundary window overlap: other.effective ≤ this.expiry AND other.expiry ≥
      // this.effective. Both columns are date-only DateTimes, so lte/gte ARE the inclusive
      // comparisons — two windows sharing exactly one day overlap; adjacent-by-one-day do not.
      effectiveDate: { lte: quote.expiryDate },
      expiryDate: { gte: quote.effectiveDate },
      lines: { some: { deletedAt: null, partId: { in: partIds } } },
    },
    select: {
      quoteNumber: true, effectiveDate: true, expiryDate: true,
      lines: { where: { deletedAt: null, partId: { in: partIds } }, select: { partId: true } },
    },
    orderBy: { quoteNumber: "asc" },
  });
  if (others.length === 0) return [];

  const warnings: string[] = [];
  for (const line of quote.lines) {
    for (const other of others) {
      if (!other.lines.some((l) => l.partId === line.partId)) continue;
      // `part` is non-null by the line filter above (partId: { not: null }).
      warnings.push(
        `Part ${line.part!.partNumber} is also quoted on open quote #${other.quoteNumber} ` +
        `(effective ${formatDateOnly(other.effectiveDate)} – ${formatDateOnly(other.expiryDate)}, ` +
        "overlapping this quote's window) — at order entry, the latest effective date wins");
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// List, worklist (spec §5.4), Excel export — the house list pattern (the certs/orders shape),
// deliberately NOT the order board's saved-views machinery (ruling 11).
// ---------------------------------------------------------------------------------------------

export type QuoteFilter = {
  search?: string;
  status?: QuoteStatusValue;
  /** Derived state (ruling 3), not a status: true narrows to OPEN quotes past expiry, false to
   *  everything not currently rendering as Expired (closed OR still in-date). */
  expired?: boolean;
  /** True narrows to the follow-up-due worklist predicate (OPEN, followUpDate ≤ today). */
  followUpDue?: boolean;
  customerId?: string;
  quoteFrom?: string; quoteTo?: string;
  effectiveFrom?: string; effectiveTo?: string;
  expiryFrom?: string; expiryTo?: string;
};

export type QuoteRow = {
  id: string;
  quoteNumber: number;
  customerId: string;
  customerCode: string;
  customerName: string;
  status: QuoteStatusValue;
  expired: boolean;
  quoteDate: string;
  effectiveDate: string;
  expiryDate: string;
  followUpDate: string | null;
  rfqNumber: string;
  quotedByName: string;
  lineCount: number;
};

// Minimal projection for listing (the certs ROW_SELECT precedent) — no line detail, just a
// filtered live-line count; the detail read is `getQuote`'s job.
const ROW_SELECT = {
  id: true, quoteNumber: true, customerId: true, status: true,
  quoteDate: true, effectiveDate: true, expiryDate: true, followUpDate: true, rfqNumber: true,
  customer: { select: { code: true, name: true } },
  quotedBy: { select: { displayName: true } },
  _count: { select: { lines: { where: { deletedAt: null } } } },
} satisfies Prisma.QuoteSelect;

type RowShape = Prisma.QuoteGetPayload<{ select: typeof ROW_SELECT }>;

/** `today` is sampled ONCE per request and threaded through, so every row in one response
 *  derives its expired state from the same instant. */
function toRow(row: RowShape, today: Date): QuoteRow {
  return {
    id: row.id, quoteNumber: row.quoteNumber,
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    status: row.status as QuoteStatusValue,
    expired: row.status === "OPEN" && row.expiryDate.getTime() < today.getTime(),
    quoteDate: formatDateOnly(row.quoteDate),
    effectiveDate: formatDateOnly(row.effectiveDate),
    expiryDate: formatDateOnly(row.expiryDate),
    followUpDate: row.followUpDate === null ? null : formatDateOnly(row.followUpDate),
    rfqNumber: row.rfqNumber,
    quotedByName: row.quotedBy.displayName,
    lineCount: row._count.lines,
  };
}

function dateRange(
  from: string | undefined, to: string | undefined, fromField: string, toField: string,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, fromField) } : {}),
    ...(to ? { lte: parseDate(to, toField) } : {}),
  };
}

function quoteSearchWhere(term: string): Prisma.QuoteWhereInput[] {
  const clauses: Prisma.QuoteWhereInput[] = [
    { customer: { code: { contains: term, mode: "insensitive" } } },
    { customer: { name: { contains: term, mode: "insensitive" } } },
    { rfqNumber: { contains: term, mode: "insensitive" } },
    // ANY live line, matched on its resolved identity: the linked part's live number or the
    // free-text line's own text. (Unlike the order board's lead-line-only rule — a quote's
    // lines are peers, and no single part labels the row.)
    { lines: { some: { deletedAt: null, OR: [
      { part: { partNumber: { contains: term, mode: "insensitive" } } },
      { partNumberText: { contains: term, mode: "insensitive" } },
    ] } } },
  ];
  // quoteNumber is an Int4 column (the searchWhere precedent, orders.ts): a longer digit string
  // is not a value it can hold, and handing it to Prisma is a validation error, not "no match".
  const asNumber = Number(term);
  if (/^\d+$/.test(term) && Number.isSafeInteger(asNumber) && asNumber <= INT4_MAX) {
    clauses.push({ quoteNumber: asNumber });
  }
  return clauses;
}

// The two §5.4 predicates, shared verbatim by the worklist queries and the list's derived
// filters so the section a quote appears in and the filter that finds it can never disagree.
// Boundaries per spec: follow-up due is `followUpDate ≤ today` (today itself is DUE); expired is
// `expiryDate < today` (a quote expiring today is still in-date).
const followUpDuePredicate = (today: Date): Prisma.QuoteWhereInput =>
  ({ status: "OPEN", followUpDate: { lte: today } });
const expiredPredicate = (today: Date): Prisma.QuoteWhereInput =>
  ({ status: "OPEN", expiryDate: { lt: today } });

function quoteListWhere(filter: QuoteFilter, today: Date): Prisma.QuoteWhereInput {
  const term = filter.search?.trim();
  const quote = dateRange(filter.quoteFrom, filter.quoteTo, "Quote from", "Quote to");
  const effective = dateRange(filter.effectiveFrom, filter.effectiveTo, "Effective from", "Effective to");
  const expiry = dateRange(filter.expiryFrom, filter.expiryTo, "Expiry from", "Expiry to");

  // The derived filters go in an AND list so they compose with the status/date keys above them
  // instead of colliding on the `status` key. The FALSE branches are written as explicit
  // complements, never Prisma `NOT { ... }`: a NULL followUpDate makes `followUpDate <= x`
  // three-valued NULL in SQL, and NOT(NULL) is still NULL — the row would silently vanish from
  // "not due" instead of belonging there.
  const and: Prisma.QuoteWhereInput[] = [];
  if (filter.expired === true) and.push(expiredPredicate(today));
  if (filter.expired === false) {
    and.push({ OR: [{ status: { not: "OPEN" } }, { expiryDate: { gte: today } }] });
  }
  if (filter.followUpDue === true) and.push(followUpDuePredicate(today));
  if (filter.followUpDue === false) {
    and.push({ OR: [{ status: { not: "OPEN" } }, { followUpDate: null }, { followUpDate: { gt: today } }] });
  }

  return {
    deletedAt: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(quote ? { quoteDate: quote } : {}),
    ...(effective ? { effectiveDate: effective } : {}),
    ...(expiry ? { expiryDate: expiry } : {}),
    ...(term ? { OR: quoteSearchWhere(term) } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

/** Newest-first by quoteNumber — unique, so it is its own tiebreak. */
export async function listQuotes(filter: QuoteFilter): Promise<QuoteRow[]> {
  const today = todayDateOnly();
  const rows = await prisma.quote.findMany({
    where: quoteListWhere(filter, today),
    select: ROW_SELECT,
    orderBy: { quoteNumber: "desc" },
  });
  return rows.map((row) => toRow(row, today));
}

export type QuoteWorklist = {
  followUpDue: { count: number; rows: QuoteRow[] };
  expired: { count: number; rows: QuoteRow[] };
};

/**
 * The two §5.4 sections, both OPEN + live, each with its count. A quote may appear in BOTH
 * (overdue follow-up on an already-expired quote) — that is information, not a bug. Ordered
 * most-overdue first (the section exists to be worked oldest-debt-down), quoteNumber desc
 * breaking date ties deterministically.
 */
export async function quoteWorklist(): Promise<QuoteWorklist> {
  const today = todayDateOnly();
  const [due, expired] = await Promise.all([
    prisma.quote.findMany({
      where: { deletedAt: null, ...followUpDuePredicate(today) },
      select: ROW_SELECT,
      orderBy: [{ followUpDate: "asc" }, { quoteNumber: "desc" }],
    }),
    prisma.quote.findMany({
      where: { deletedAt: null, ...expiredPredicate(today) },
      select: ROW_SELECT,
      orderBy: [{ expiryDate: "asc" }, { quoteNumber: "desc" }],
    }),
  ]);
  return {
    followUpDue: { count: due.length, rows: due.map((r) => toRow(r, today)) },
    expired: { count: expired.length, rows: expired.map((r) => toRow(r, today)) },
  };
}

const QUOTE_COLUMNS = [
  { key: "quoteNumber", header: "Quote #" },
  { key: "customerCode", header: "Customer code" },
  { key: "customerName", header: "Customer name" },
  { key: "status", header: "Status" },
  { key: "quoteDate", header: "Quote date" },
  { key: "effectiveDate", header: "Effective" },
  { key: "expiryDate", header: "Expires" },
  { key: "followUpDate", header: "Follow-up" },
  { key: "rfqNumber", header: "RFQ" },
  { key: "lineCount", header: "Lines" },
  { key: "quotedByName", header: "Quoted by" },
];

/** Exactly what `listQuotes` returned for the same filter (the `exportOrders` precedent) — same
 *  query, same rows, humanized cells: the status cell renders the DERIVED display state, so an
 *  open-but-expired quote exports as "Expired" exactly as it renders everywhere (ruling 3). */
export async function exportQuotes(filter: QuoteFilter): Promise<Buffer> {
  const rows = await listQuotes(filter);
  const xlsxRows = rows.map((r) => ({
    ...r,
    status: r.expired ? QUOTE_EXPIRED_LABEL : QUOTE_STATUS_LABELS[r.status],
  }));
  return toXlsx("Quotes", QUOTE_COLUMNS, xlsxRows as unknown as Record<string, unknown>[]);
}

// ---------------------------------------------------------------------------------------------
// Mutations (Task 4, spec §5.1): update / attach-part / close / reopen / delete. Every one
// claims the Quote row FIRST (SELECT … FOR UPDATE) and only then reads the state it acts on —
// the claimOrder discipline (order-locks.ts), restated here for the Quote row. Two mutators run
// Serializable, each for a stated reason; the rest ride the claim at default isolation:
//
//   - `updateQuote` is Serializable exactly when the payload can assign a registered FK — the
//     `assignsFk` pattern (reference.ts): a `lines` array can write `QuoteLine.partId` and
//     `QuotePrice.processStepCodeId`, and a non-null `endingStatementId` writes the third
//     registered column, so those payloads pair `assertRefExists`'s live read with the write
//     inside one Serializable transaction (the FK-writer pattern). A header-only patch assigns
//     none and runs at default isolation — the row claim alone is its guard. Being Serializable
//     whenever `lines` is present ALSO covers the §5.14 guard below: "no order line references
//     this quote line" is a predicate over OrderLine rows (rows that may not exist — the
//     period-lock shape, un-claimable by FOR UPDATE), and every writer of
//     `OrderLine.quoteLineId` (the Phase 3 order save, which Task 5 extends) runs Serializable,
//     so SSI aborts the link-vs-line-delete interleaving no serial order could produce.
//   - `attachPart` assigns `QuoteLine.partId` → always Serializable (same FK-writer reasoning).
//   - `deleteQuote` assigns nothing but its §5.14 blocker read is the same OrderLine predicate →
//     Serializable so SSI pairs it with the Serializable order-save linker.
//   - `closeQuote`/`reopenQuote` read and write only the Quote row's own columns; the linked-
//     open-orders list is a WARNING, not a guard (ruling 6 — it never blocks), so a stale read
//     there costs nothing. Default isolation, claim only.
//
// Unlike createQuote, none of this touches `allocateNumber` — the create transaction's second
// Serializable master (Task 3's report) does not apply here.
// ---------------------------------------------------------------------------------------------

/** Claims the Quote row for the rest of the caller's OWN transaction — the `claimOrder` shape
 *  (order-locks.ts): raw because Prisma has no FOR UPDATE of its own; id only, with the full row
 *  read back through the ordinary client once the lock is held. The guarded state every mutator
 *  acts on (`status`, `deletedAt`, and the child rows written under it) lives on or under this
 *  row, so the claim is the guard at ANY caller isolation. */
async function claimQuote(tx: Db, id: string): Promise<Quote | null> {
  await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${id} FOR UPDATE`;
  return tx.quote.findFirst({ where: { id } });
}

/** Missing and soft-deleted quotes both 404 for mutations (the orders `claimOrder` caller
 *  convention) — `getQuote` is the one reader that shows a deleted quote (shown-never-hidden). */
function requireLiveQuote(row: Quote | null): Quote {
  if (!row || row.deletedAt !== null) throw new HttpError(404, "Quote not found");
  return row;
}

// The update shapes: the CREATE tree with an optional `id` at every level. A row WITH an id must
// be a live row of this quote (validated against the claimed tree, never trusted) and is updated
// in place — QuoteLine ids MUST stay stable, because `OrderLine.quoteLineId` points at them
// (ruling 5); price/break ids are kept stable too so an untouched row never diffs in history.
// A row WITHOUT an id is created; a live row missing from the payload is soft-deleted.
const UPDATE_BREAK = BREAK.extend({ id: z.string().min(1).optional() });
const UPDATE_PRICE = PRICE.extend({
  id: z.string().min(1).optional(),
  breaks: z.array(UPDATE_BREAK).default([]),
});
const UPDATE_LINE = LINE.extend({
  id: z.string().min(1).optional(),
  prices: z.array(UPDATE_PRICE).default([]),
});

const UPDATE = z.object({
  // Present-and-equal is tolerated (a full-form client echoes it back); a DIFFERENT id is the
  // immutability 400 (spec §4.1 — the agreement's identity; wrong customer = delete + re-key).
  customerId: z.string().min(1).optional(),
  contactId: z.string().min(1).nullable().optional(),
  quoteDate: z.string().optional(),
  effectiveDate: z.string().optional(),
  expiryDate: z.string().optional(),
  followUpDate: z.string().nullable().optional(),
  rfqNumber: z.string().trim().max(200).optional(),
  quotedById: z.string().min(1).optional(),
  // Explicit id = validated; explicit null = none; ABSENT = keep the stored pick. No re-default:
  // the kind's default row is an ENTRY default (spec §5.1), not a standing rule.
  endingStatementId: z.string().min(1).nullable().optional(),
  notes: z.string().max(4000).optional(),
  internalNotes: z.string().max(4000).optional(),
  // Whole-array replace when present (min 1 — a quote must keep at least one line, the create
  // rule); ABSENT leaves the line tree completely untouched (a header-only patch).
  lines: z.array(UPDATE_LINE).min(1).optional(),
}).strict();

type UpdateInput = z.infer<typeof UPDATE>;
type UpdateLineInput = UpdateInput["lines"] extends (infer L)[] | undefined ? L : never;

/** The quote's live line → price → break tree plus each line's live part number (for §5.14
 *  refusal labels), read on the caller's `tx` UNDER the claim. */
async function loadLiveTree(tx: Db, quoteId: string) {
  return tx.quoteLine.findMany({
    where: { quoteId, deletedAt: null },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    include: {
      part: { select: { partNumber: true } },
      prices: {
        where: { deletedAt: null },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        include: { breaks: { where: { deletedAt: null }, orderBy: { threshold: "asc" } } },
      },
    },
  });
}
type LiveTree = Awaited<ReturnType<typeof loadLiveTree>>;
type LiveLine = LiveTree[number];

/** Every payload id must name a live row of THIS quote, at the level it appears, exactly once —
 *  an id is a claim about existing data and is never trusted. Runs before any write. */
function validateUpdateIds(current: LiveTree, lines: UpdateLineInput[], resolved: ResolvedQuoteLine[]): void {
  const lineById = new Map(current.map((l) => [l.id, l]));
  const seenLines = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const label = resolved[i].label;
    let cur: LiveLine | undefined;
    if (line.id !== undefined) {
      if (seenLines.has(line.id)) {
        throw new HttpError(400, `${label}: the same line appears twice in the payload`);
      }
      seenLines.add(line.id);
      cur = lineById.get(line.id);
      if (!cur) throw new HttpError(400, `${label}: that line does not exist on this quote`);
    }
    const curPrices = new Map((cur?.prices ?? []).map((p) => [p.id, p]));
    const seenPrices = new Set<string>();
    for (const price of line.prices) {
      let curPrice;
      if (price.id !== undefined) {
        if (seenPrices.has(price.id)) {
          throw new HttpError(400, `${label}: the same price row appears twice in the payload`);
        }
        seenPrices.add(price.id);
        curPrice = curPrices.get(price.id);
        if (!curPrice) throw new HttpError(400, `${label}: that price row does not exist on this line`);
      }
      const curBreaks = new Set((curPrice?.breaks ?? []).map((b) => b.id));
      const seenBreaks = new Set<string>();
      for (const brk of price.breaks) {
        if (brk.id === undefined) continue;
        if (seenBreaks.has(brk.id)) {
          throw new HttpError(400, `${label}: the same price break appears twice in the payload`);
        }
        seenBreaks.add(brk.id);
        if (!curBreaks.has(brk.id)) {
          throw new HttpError(400, `${label}: that price break does not exist on this price row`);
        }
      }
    }
  }
}

const orderNumbers = (orders: Map<string, number>): string =>
  [...orders.values()].sort((a, b) => a - b).map((n) => `#${n}`).join(", ");

/**
 * The §5.14 refusals, read under the quote row claim on the caller's own `tx`: a payload that
 * DROPS a line — or changes a kept line's `partId` (re-point, attach, or detach alike) — while
 * any LIVE order's line still references it is refused with every blocking order NAMED. A
 * vanished or re-pointed line would silently re-price those orders, the exact failure §7.5
 * exists to prevent. Free-text and price-row edits on a linked line are always allowed (ruling
 * 8 — live until finalize); voided orders never block (house rule).
 */
async function assertLinkedLinesUntouched(
  tx: Db, current: LiveTree, lines: UpdateLineInput[], resolved: ResolvedQuoteLine[],
): Promise<void> {
  const keptIds = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));
  const curById = new Map(current.map((l) => [l.id, l]));
  const removed = current.filter((l) => !keptIds.has(l.id));
  const rePointed = lines.flatMap((line, i) => {
    if (line.id === undefined) return [];
    const cur = curById.get(line.id)!;
    return cur.partId !== (line.partId ?? null) ? [{ cur, index: i }] : [];
  });
  const affected = [...removed.map((l) => l.id), ...rePointed.map((r) => r.cur.id)];
  if (affected.length === 0) return;

  const links = await tx.orderLine.findMany({
    where: { quoteLineId: { in: affected }, order: { deletedAt: null } },
    select: { quoteLineId: true, order: { select: { id: true, orderNumber: true } } },
  });
  if (links.length === 0) return;
  const byLine = new Map<string, Map<string, number>>();
  for (const link of links) {
    if (!link.quoteLineId) continue;
    const orders = byLine.get(link.quoteLineId) ?? new Map<string, number>();
    orders.set(link.order.id, link.order.orderNumber);
    byLine.set(link.quoteLineId, orders);
  }

  for (const line of removed) {
    const orders = byLine.get(line.id);
    if (!orders) continue;
    const display = line.part?.partNumber ?? line.partNumberText;
    throw new HttpError(400,
      `Line ${line.position} (${display}) cannot be removed — order(s) ${orderNumbers(orders)} ` +
      "still price from it");
  }
  for (const { cur, index } of rePointed) {
    const orders = byLine.get(cur.id);
    if (!orders) continue;
    throw new HttpError(400,
      `${resolved[index].label}: its part cannot be changed — order(s) ${orderNumbers(orders)} ` +
      "still price from it");
  }
}

const decEq = (a: Prisma.Decimal | null, b: number | null): boolean =>
  a === null ? b === null : b !== null && a.toNumber() === b;

/** Only the columns whose values actually changed — an untouched kept row gets NO write, so the
 *  audit diff never shows churn an operator didn't make (the linkOrder "identical value: skip"
 *  rule, applied field-by-field). */
function lineChanges(cur: LiveLine, line: UpdateLineInput, position: number): Prisma.QuoteLineUncheckedUpdateInput {
  const patch: Prisma.QuoteLineUncheckedUpdateInput = {};
  if (cur.position !== position) patch.position = position;
  if (cur.partId !== (line.partId ?? null)) patch.partId = line.partId ?? null;
  if (cur.partNumberText !== line.partNumberText) patch.partNumberText = line.partNumberText;
  if (cur.partNameText !== line.partNameText) patch.partNameText = line.partNameText;
  if (cur.partDescriptionText !== line.partDescriptionText) {
    patch.partDescriptionText = line.partDescriptionText;
  }
  if (cur.materialText !== line.materialText) patch.materialText = line.materialText;
  if (!decEq(cur.eachWeight, line.eachWeight ?? null)) patch.eachWeight = line.eachWeight ?? null;
  if (cur.quotedQty !== (line.quotedQty ?? null)) patch.quotedQty = line.quotedQty ?? null;
  if (cur.quotedUnlimited !== line.quotedUnlimited) patch.quotedUnlimited = line.quotedUnlimited;
  return patch;
}

function priceChanges(
  cur: LiveLine["prices"][number], price: UpdateLineInput["prices"][number], position: number,
): Prisma.QuotePriceUncheckedUpdateInput {
  const patch: Prisma.QuotePriceUncheckedUpdateInput = {};
  if (cur.position !== position) patch.position = position;
  if (!decEq(cur.setupCharge, price.setupCharge ?? null)) patch.setupCharge = price.setupCharge ?? null;
  if (!decEq(cur.unitPrice, price.unitPrice ?? null)) patch.unitPrice = price.unitPrice ?? null;
  if (!decEq(cur.minimumCharge, price.minimumCharge ?? null)) {
    patch.minimumCharge = price.minimumCharge ?? null;
  }
  if (cur.pricePer !== (price.pricePer ?? "EACH")) patch.pricePer = price.pricePer ?? "EACH";
  if (cur.notes !== price.notes) patch.notes = price.notes;
  return patch;
}

/**
 * The array-replace, diff-and-write: kept rows (payload id) update IN PLACE — `QuoteLine` ids
 * must survive an edit because `OrderLine.quoteLineId` points at them, and stable price/break
 * ids keep unchanged rows out of the audit diff; new rows are created; live rows missing from
 * the payload are soft-deleted. NOT the invoice-lines delete-and-recreate (§5.5 reminta ids
 * every save — an id-stable contract can't be built on that shape).
 *
 * Two orderings are load-bearing, both for the live-rows-only partial uniques:
 *   - a kept price row whose `processStepCodeId` changed (and a kept break whose `threshold`
 *     changed) is STAMPED AND RE-MINTED, never patched in place — patching a swap of two rows'
 *     codes collides with the sibling's still-live (quoteLineId, processStepCodeId) index
 *     mid-sequence, since each UPDATE is checked as its own statement;
 *   - all stamps happen BEFORE all creates/patches, so a freed value is genuinely free.
 * Grandchildren of a stamped row are left as-is — unreachable behind the dead parent, the
 * deletePartPrice rule.
 */
async function applyQuoteLines(
  tx: Db, quoteId: string, lines: UpdateLineInput[], current: LiveTree,
): Promise<void> {
  const now = new Date();
  const curLineById = new Map(current.map((l) => [l.id, l]));
  const keptLineIds = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));

  // Pass 1 — every stamp: dropped lines, then dropped/re-keyed price rows and breaks of kept
  // lines. `reMinted` remembers which payload rows must take the create path in pass 2.
  const droppedLines = current.filter((l) => !keptLineIds.has(l.id)).map((l) => l.id);
  if (droppedLines.length > 0) {
    await tx.quoteLine.updateMany({
      where: { id: { in: droppedLines } }, data: { deletedAt: now },
    });
  }
  const reMintedPrices = new Set<UpdateLineInput["prices"][number]>();
  const reMintedBreaks = new Set<UpdateLineInput["prices"][number]["breaks"][number]>();
  const stampPrices: string[] = [];
  const stampBreaks: string[] = [];
  for (const line of lines) {
    if (line.id === undefined) continue;
    const cur = curLineById.get(line.id)!;
    const keptPriceIds = new Set(line.prices.flatMap((p) => (p.id === undefined ? [] : [p.id])));
    stampPrices.push(...cur.prices.filter((p) => !keptPriceIds.has(p.id)).map((p) => p.id));
    const curPriceById = new Map(cur.prices.map((p) => [p.id, p]));
    for (const price of line.prices) {
      if (price.id === undefined) continue;
      const curPrice = curPriceById.get(price.id)!;
      if (curPrice.processStepCodeId !== price.processStepCodeId) {
        reMintedPrices.add(price);
        stampPrices.push(price.id);
        continue; // its breaks ride the re-mint; the old row's breaks stay behind it
      }
      const keptBreakIds = new Set(price.breaks.flatMap((b) => (b.id === undefined ? [] : [b.id])));
      stampBreaks.push(...curPrice.breaks.filter((b) => !keptBreakIds.has(b.id)).map((b) => b.id));
      const curBreakById = new Map(curPrice.breaks.map((b) => [b.id, b]));
      for (const brk of price.breaks) {
        if (brk.id === undefined) continue;
        const curBreak = curBreakById.get(brk.id)!;
        if (curBreak.threshold.toNumber() !== brk.threshold) {
          reMintedBreaks.add(brk);
          stampBreaks.push(brk.id);
        }
      }
    }
  }
  if (stampPrices.length > 0) {
    await tx.quotePrice.updateMany({ where: { id: { in: stampPrices } }, data: { deletedAt: now } });
  }
  if (stampBreaks.length > 0) {
    await tx.quotePriceBreak.updateMany({ where: { id: { in: stampBreaks } }, data: { deletedAt: now } });
  }

  // Pass 2 — creates and in-place patches, positions re-derived from array order throughout.
  for (const [i, line] of lines.entries()) {
    const position = i + 1;
    if (line.id === undefined) {
      await tx.quoteLine.create({ data: { quoteId, ...lineCreateData(line, position) } });
      continue;
    }
    const cur = curLineById.get(line.id)!;
    const patch = lineChanges(cur, line, position);
    if (Object.keys(patch).length > 0) {
      await tx.quoteLine.update({ where: { id: line.id }, data: patch });
    }
    const curPriceById = new Map(cur.prices.map((p) => [p.id, p]));
    for (const [j, price] of line.prices.entries()) {
      const pricePosition = j + 1;
      if (price.id === undefined || reMintedPrices.has(price)) {
        await tx.quotePrice.create({
          data: { quoteLineId: line.id, ...priceCreateData(price, pricePosition) },
        });
        continue;
      }
      const curPrice = curPriceById.get(price.id)!;
      const pricePatch = priceChanges(curPrice, price, pricePosition);
      if (Object.keys(pricePatch).length > 0) {
        await tx.quotePrice.update({ where: { id: price.id }, data: pricePatch });
      }
      const curBreakById = new Map(curPrice.breaks.map((b) => [b.id, b]));
      for (const brk of price.breaks) {
        if (brk.id === undefined || reMintedBreaks.has(brk)) {
          await tx.quotePriceBreak.create({
            data: { quotePriceId: price.id, threshold: brk.threshold, price: brk.price },
          });
          continue;
        }
        const curBreak = curBreakById.get(brk.id)!;
        if (curBreak.price.toNumber() !== brk.price) {
          await tx.quotePriceBreak.update({ where: { id: brk.id }, data: { price: brk.price } });
        }
      }
    }
  }
}

/**
 * Edit an OPEN quote (spec §5.1, `quotes.edit`): header fields patch; a `lines` array replaces
 * the whole line/price/break tree (array-replace, ids kept stable — see `applyQuoteLines`).
 * `customerId` is immutable. Everything create validates is re-validated through the SAME
 * helpers (`resolveQuoteLines`/`validateQuotePrices`); the §5.14 linked-line guards run under
 * the row claim. One `auditedUpdate` wraps every write — the quote-level before/after diff (the
 * order-children precedent: editing the tree IS editing the quote) is the audit trail, and this
 * is SNAPSHOT_INCLUDE.quote's consumer. Isolation: see the section comment above.
 *
 * EVERY update response carries ruling 7's overlap warnings, not only `lines` payloads: a
 * date-only patch can itself create (extend) or dissolve (shrink) the overlap, and the §5.7
 * precedent is that every edit response carries the full advisory surface. The read is
 * advisory-only, so the header-only default-isolation path needs no upgrade for it.
 */
export async function updateQuote(id: string, input: unknown): Promise<QuoteMutationResult> {
  const data = UPDATE.parse(input);
  const assignsFk = data.lines !== undefined || data.endingStatementId != null;

  return withDbErrors({ entity: "Quote", conflictField: "operation" }, () =>
    prisma.$transaction(async (tx) => {
      const quote = requireLiveQuote(await claimQuote(tx, id));
      if (quote.status !== "OPEN") {
        throw new HttpError(400, "This quote is closed — reopen it before editing");
      }
      if (data.customerId !== undefined && data.customerId !== quote.customerId) {
        throw new HttpError(400,
          "The customer on a quote cannot be changed — delete this quote and enter a new one");
      }

      if (data.contactId != null) {
        const contact = await tx.customerContact.findFirst({
          where: { id: data.contactId, customerId: quote.customerId, deletedAt: null },
          select: { id: true },
        });
        if (!contact) throw new HttpError(400, "That contact does not exist for this customer");
      }
      if (data.quotedById !== undefined) {
        const quotedBy = await tx.user.findFirst({
          where: { id: data.quotedById, deletedAt: null }, select: { id: true },
        });
        if (!quotedBy) throw new HttpError(400, "That quoted-by user does not exist");
      }
      if (data.endingStatementId != null) {
        await assertRefExists("endingStatement", data.endingStatementId, tx);
      }

      // The date window is validated on the MERGED result — a payload touching one end must
      // still agree with the stored other end.
      const effectiveDate = data.effectiveDate !== undefined
        ? parseDate(data.effectiveDate, "Effective date") : quote.effectiveDate;
      const expiryDate = data.expiryDate !== undefined
        ? parseDate(data.expiryDate, "Expiry date") : quote.expiryDate;
      if (effectiveDate.getTime() > expiryDate.getTime()) {
        throw new HttpError(400, "The effective date must be on or before the expiry date");
      }

      let current: LiveTree | undefined;
      if (data.lines !== undefined) {
        const resolved = await resolveQuoteLines(tx, quote.customerId, data.lines);
        await validateQuotePrices(tx, data.lines, resolved);
        current = await loadLiveTree(tx, id);
        validateUpdateIds(current, data.lines, resolved);
        await assertLinkedLinesUntouched(tx, current, data.lines, resolved);
      }

      const patch: Prisma.QuoteUncheckedUpdateInput = {
        ...(data.contactId !== undefined ? { contactId: data.contactId } : {}),
        ...(data.quoteDate !== undefined
          ? { quoteDate: parseDate(data.quoteDate, "Quote date") } : {}),
        ...(data.effectiveDate !== undefined ? { effectiveDate } : {}),
        ...(data.expiryDate !== undefined ? { expiryDate } : {}),
        ...(data.followUpDate !== undefined
          ? {
            followUpDate: data.followUpDate === null
              ? null : parseDate(data.followUpDate, "Follow-up date"),
          } : {}),
        ...(data.rfqNumber !== undefined ? { rfqNumber: data.rfqNumber } : {}),
        ...(data.quotedById !== undefined ? { quotedById: data.quotedById } : {}),
        ...(data.endingStatementId !== undefined ? { endingStatementId: data.endingStatementId } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.internalNotes !== undefined ? { internalNotes: data.internalNotes } : {}),
      };

      await auditedUpdate("quote", id, async () => {
        if (Object.keys(patch).length > 0) {
          await tx.quote.update({ where: { id }, data: patch });
        }
        if (data.lines !== undefined) {
          await applyQuoteLines(tx, id, data.lines, current!);
        }
      }, { tx });

      const detail = await readDetail(tx, id);
      return { ...detail, warnings: await overlapWarnings(tx, id) };
    }, assignsFk ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}

const ATTACH = z.object({
  lineId: z.string().min(1),
  partId: z.string().min(1),
}).strict();

/**
 * Attaches a part to a live FREE-TEXT line of an OPEN quote (spec §4.1, ruling 1) — from then on
 * the line auto-links and prices tier 1. Same validation as create (live part, the quote's own
 * customer, one live line per part), refused on a line that already carries one. The free-text
 * columns stay as-is — dormant history the read model stops consulting the moment `partId` is
 * set. Serializable: assigns the registered `QuoteLine.partId` FK (the section comment above).
 * The response carries ruling 7's overlap warnings — attaching a part is exactly the act that
 * can put one part on two open quotes at once.
 */
export async function attachPart(quoteId: string, input: unknown): Promise<QuoteMutationResult> {
  const data = ATTACH.parse(input);

  return withDbErrors({ entity: "Quote" }, () =>
    prisma.$transaction(async (tx) => {
      const quote = requireLiveQuote(await claimQuote(tx, quoteId));
      if (quote.status !== "OPEN") {
        throw new HttpError(400, "This quote is closed — reopen it before editing");
      }
      const line = await tx.quoteLine.findFirst({
        where: { id: data.lineId, quoteId, deletedAt: null },
        select: { id: true, partId: true },
      });
      if (!line) throw new HttpError(404, "Quote line not found");
      if (line.partId !== null) throw new HttpError(400, "That line already carries a part");

      const part = await tx.part.findFirst({
        where: { id: data.partId, deletedAt: null },
        select: { id: true, customerId: true },
      });
      if (!part) throw new HttpError(400, "That part does not exist");
      if (part.customerId !== quote.customerId) {
        throw new HttpError(400, "That part belongs to another customer");
      }
      const dupe = await tx.quoteLine.findFirst({
        where: { quoteId, partId: part.id, deletedAt: null, id: { not: line.id } },
        select: { id: true },
      });
      if (dupe) throw new HttpError(400, "That part is already quoted on this quote");

      await auditedUpdate("quote", quoteId,
        () => tx.quoteLine.update({ where: { id: line.id }, data: { partId: part.id } }), { tx });

      const detail = await readDetail(tx, quoteId);
      return { ...detail, warnings: await overlapWarnings(tx, quoteId) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export type LinkedOpenOrder = { id: string; orderNumber: number };

/**
 * The close warning's order list (ruling 6): every LIVE order still linked to any of this
 * quote's lines that is not yet FULLY INVOICED — where "fully invoiced" means a live FINALIZED
 * INVOICE covers the order (invoice-guards.ts's FROZEN predicate: `kind INVOICE`, `status
 * FINALIZED`, `deletedAt null`). The Invoice row is the source of truth, deliberately NOT
 * `Order.status`: `INVOICED` and `REOPENED` are both invoice-owned values (ship-ledger.ts) that
 * recompute paths move on and off, while `finalizedInvoicesFor` reads the fact itself — and an
 * order at REOPENED still has its finalized paper, so it is not listed either. Deduped (one
 * order linking through several lines lists once), ascending by order number.
 */
async function linkedOpenOrdersFor(tx: Db, quoteId: string): Promise<LinkedOpenOrder[]> {
  const links = await tx.orderLine.findMany({
    where: { quoteLine: { quoteId }, order: { deletedAt: null } },
    select: { order: { select: { id: true, orderNumber: true } } },
  });
  const orders = new Map(links.map((l) => [l.order.id, l.order.orderNumber]));
  if (orders.size === 0) return [];
  const frozen = new Set((await finalizedInvoicesFor(tx, [...orders.keys()])).map((f) => f.orderId));
  return [...orders.entries()]
    .filter(([orderId]) => !frozen.has(orderId))
    .map(([orderId, orderNumber]) => ({ id: orderId, orderNumber }))
    .sort((a, b) => a.orderNumber - b.orderNumber);
}

export type QuoteCloseResult = { quote: QuoteDetail; linkedOpenOrders: LinkedOpenOrder[] };

/**
 * Close (spec §5.1, `quotes.edit` — reversible, takes nothing with it, so no special action):
 * reason trimmed non-empty IN THE SERVICE (§5.17), status/closedAt/closedBy/closeReason
 * stamped under the row claim (a second close 400s off the fresh post-claim read), audited with
 * the reason. The response WARNS-AND-LISTS the linked open orders — never a block (ruling 6):
 * their stored links keep pricing them regardless, so there is nothing a block would protect.
 */
export async function closeQuote(id: string, reason: string): Promise<QuoteCloseResult> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to close a quote");

  return withDbErrors({ entity: "Quote" }, () =>
    prisma.$transaction(async (tx) => {
      const quote = requireLiveQuote(await claimQuote(tx, id));
      if (quote.status === "CLOSED") throw new HttpError(400, "This quote is already closed");

      const linkedOpenOrders = await linkedOpenOrdersFor(tx, id);
      await auditedUpdate("quote", id, () => tx.quote.update({
        where: { id },
        data: {
          status: "CLOSED", closedAt: new Date(), closedById: currentActor().id, closeReason: why,
        },
      }), { tx, reason: why });

      return { quote: await readDetail(tx, id), linkedOpenOrders };
    }));
}

/**
 * Reopen (`quotes.edit`): back to OPEN with the close fields CLEARED — `closedAt`/`closedById`
 * null, `closeReason` "". The schema deliberately has no reopen columns (unlike ClosePeriod's
 * `reopenedAt`/`reopenReason`), and the detail read renders the close fields unconditionally, so
 * a stale reason surviving onto an OPEN quote would print state that is no longer true. Nothing
 * is lost: the reopen's audit entry carries the reason arg AND a before snapshot holding the
 * whole close story; a later re-close stamps fresh values.
 */
export async function reopenQuote(id: string, reason: string): Promise<QuoteDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reopen a quote");

  return withDbErrors({ entity: "Quote" }, () =>
    prisma.$transaction(async (tx) => {
      const quote = requireLiveQuote(await claimQuote(tx, id));
      if (quote.status !== "CLOSED") throw new HttpError(400, "This quote is not closed");

      await auditedUpdate("quote", id, () => tx.quote.update({
        where: { id },
        data: { status: "OPEN", closedAt: null, closedById: null, closeReason: "" },
      }), { tx, reason: why });

      return readDetail(tx, id);
    }));
}

/**
 * The §5.14 blocker list for the delete refusal and the blockers Excel export (the
 * `partOrderBlockers` shape, quote-scoped): every LIVE order carrying a line that references
 * any of this quote's lines — named "#1042 · ACME", deduped per order, ascending. Callers with
 * a claim pass their own `tx` so the guard and the write it guards see the same state; the
 * export route reads on the bare client.
 */
export async function quoteOrderBlockers(quoteId: string, db: Db = prisma): Promise<Blocker[]> {
  const links = await db.orderLine.findMany({
    where: { quoteLine: { quoteId }, order: { deletedAt: null } },
    select: {
      order: { select: { id: true, orderNumber: true, customer: { select: { code: true } } } },
    },
    orderBy: { order: { orderNumber: "asc" } },
  });
  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const { order } of links) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    out.push({
      entityLabel: "Order", name: `#${order.orderNumber} · ${order.customer.code}`,
      id: order.id, href: `/orders/${order.id}`,
    });
  }
  return out;
}

/**
 * Delete (spec §5.1, `quotes.delete`): soft, reason required (§5.17 — it carries lines and
 * price rows away), REFUSED-AND-NAMED while any live order line references any of its lines
 * (§5.14 — the full blocker list; its Excel rides the blockers route). A CLOSED quote deletes
 * fine — closing is not a prerequisite, and the typo case may well have been closed first.
 * The quote's own delete entry snapshots the live tree BEFORE anything is stamped, then the
 * live lines are stamped in the same transaction (children are audited through the parent — the
 * order-children rule; grandchildren stay behind their dead line, the deletePartPrice rule).
 * Serializable: the blocker read is the OrderLine predicate the section comment covers.
 */
export async function deleteQuote(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a quote");

  await withDbErrors({ entity: "Quote" }, () =>
    prisma.$transaction(async (tx) => {
      requireLiveQuote(await claimQuote(tx, id));

      const blockers = await quoteOrderBlockers(id, tx);
      if (blockers.length > 0) {
        throw new HttpError(400,
          `This quote cannot be deleted — order(s) ${blockers.map((b) => b.name).join(", ")} ` +
          "still price from it");
      }

      await auditedSoftDelete("quote", id, why, tx);
      await tx.quoteLine.updateMany({
        where: { quoteId: id, deletedAt: null }, data: { deletedAt: new Date() },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// ---------------------------------------------------------------------------------------------
// The quote PDF (Task 10, spec §6): the collector feeding pdf/quote.ts's pure builder, and the
// print/archive path — the printInvoice/printCert precedent: settings read OUTSIDE the
// transaction, read-under-claim → render → `storeDocument` (kind QUOTE) in ONE Serializable
// transaction, reprints reissuing the STORED bytes via the download route (never a re-render).
// ---------------------------------------------------------------------------------------------

export type QuotePrintSettings = {
  company: { name: string; address: string; phone: string };
  introText: string;
  liabilityText: string;
};

/** The plant-wide print blocks, read BEFORE the print transaction opens (the cert/ticket/invoice
 *  precedent — a settings read on the top-level client inside a Serializable transaction is the
 *  pool-starvation shape fix-wave R4 finding 8 exists to prevent). */
export async function quotePrintSettings(): Promise<QuotePrintSettings> {
  const [name, address, phone, introText, liabilityText] = await Promise.all([
    getSetting("company_name"), getSetting("company_address"), getSetting("company_phone"),
    getSetting("quote_intro_text"), getSetting("quote_liability_text"),
  ]);
  return { company: { name, address, phone }, introText, liabilityText };
}

/** The default (or first) live BILL_TO — the invoice's own `pickDefault` shape, one kind. */
function pickDefaultBillTo(addresses: AddressRow[]): AddressRow | null {
  const of = addresses.filter((a) => a.kind === "BILL_TO");
  return of.find((a) => a.isDefault) ?? of[0] ?? null;
}

/** The Attn block's address lines (spec §6): the CUSTOMER name, then the bill-to street and
 *  city line — the invoice's `renderAddress` resolution, except the customer name always prints
 *  (the spec's own transcription: "contact name, customer name, bill-to address") and an
 *  address-row name prints ABOVE it only when it names something else (the sample's own
 *  department-over-company stacking). Blank components drop so no empty line prints. */
function billToLines(customerName: string, addr: AddressRow | null): string[] {
  const cityLine = addr
    ? [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : "";
  return [
    ...(addr && addr.name !== "" && addr.name !== customerName ? [addr.name] : []),
    customerName,
    ...(addr?.street ? [addr.street] : []),
    ...(cityLine ? [cityLine] : []),
  ];
}

/**
 * One quote line's price rows as the ENGINE's own input shape, then the indicative amounts read
 * back off the computed OPERATION lines (spec §6: "the engine's real math is the display's only
 * source — no second pricing formula"). The synthetic line is quotedQty + quotedQty×each-weight;
 * amounts are omitted (null) when:
 *   - the line is unlimited or has no quoted qty (nothing to extend over), or
 *   - the row prices per LB and the line has no each-weight (its basis is unknown — a $0-weight
 *     extension would print the minimum as if it were the real charge).
 * The engine's break-selection, minimum-floor and setup-on-top semantics apply unchanged.
 */
function indicativeAmounts(line: QuoteLineDetail): (number | null)[] {
  if (line.prices.length === 0) return [];
  const eligible = !line.quotedUnlimited && line.quotedQty !== null;
  if (!eligible) return line.prices.map(() => null);

  const rows: PriceRowInput[] = line.prices.map((p) => ({
    processStepCodeId: p.processStepCodeId, stepCode: p.stepCode, stepName: p.stepName,
    position: p.position,
    setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
    pricePer: p.pricePer, breaks: p.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
    glAccountId: null, glAccountName: "",
  }));
  const result = priceOrder({
    lines: [{
      orderLineId: line.id, position: 1,
      partNumber: line.partNumber, partName: line.partName, partDescription: line.partDescription,
      eachWeight: line.eachWeight ?? 0,
      shippedQty: line.quotedQty!,
      shippedWeight: line.eachWeight === null ? 0 : line.quotedQty! * line.eachWeight,
      prices: rows,
    }],
    surcharges: [], charges: [], freight: null, cert: null, tax: null,
  });
  // One OPERATION line per input price row, in order (the engine's own contract).
  const ops = result.lines.filter((l) => l.kind === "OPERATION");
  return line.prices.map((p, i) =>
    (p.pricePer === "LB" && line.eachWeight === null ? null : ops[i].amount));
}

/**
 * Assembles the whole print payload (spec §6) off the caller's `db` — inside `printQuote` that is
 * the claim-holding `tx` (the `readCertPdfData` rule). A quote is a LIVING document (ruling 8),
 * so everything here reads live: part identity through the detail's live-or-text resolution, the
 * terms name, the default bill-to, the contact's name/phone (blank when the contact was deleted —
 * the stored PDFs keep the printed name), the quotedBy user's displayName + title (ruling 14).
 * `internalNotes` never enters the payload (the cert notes-pair rule — the builder's input type
 * cannot even carry it).
 */
export async function readQuotePdfData(
  db: Db, id: string, settings?: QuotePrintSettings,
): Promise<QuotePdfData> {
  const detail = await readDetail(db, id); // 404s a missing quote
  const s = settings ?? await quotePrintSettings();

  const customer = await db.customer.findFirst({
    where: { id: detail.customerId },
    select: { name: true, terms: { select: { name: true } } },
  });
  if (!customer) throw new HttpError(404, "Customer not found");

  const addresses = await listAddresses(detail.customerId, undefined, db);
  const billTo = pickDefaultBillTo(addresses);

  // The picked contact's phone, only while the contact is live — the detail's own contactName
  // rule (a deleted contact renders blank, spec §4.1).
  let customerPhone = "";
  if (detail.contactId !== null && detail.contactName !== "") {
    const contact = await db.customerContact.findFirst({
      where: { id: detail.contactId, deletedAt: null }, select: { phone: true },
    });
    customerPhone = contact?.phone ?? "";
  }

  // The signature title (ruling 14) — displayName already rides the detail; blank prints nothing.
  const quotedBy = await db.user.findFirst({
    where: { id: detail.quotedById }, select: { title: true },
  });

  const lines: QuotePdfLine[] = detail.lines.map((line) => {
    const amounts = indicativeAmounts(line);
    return {
      quotedQty: line.quotedQty, quotedUnlimited: line.quotedUnlimited,
      partNumber: line.partNumber, partName: line.partName, partDescription: line.partDescription,
      eachWeight: line.eachWeight,
      totalLbs: line.quotedQty !== null && line.eachWeight !== null
        ? line.quotedQty * line.eachWeight : null,
      material: line.material,
      prices: line.prices.map((p, i) => ({
        stepName: p.stepName, notes: p.notes,
        setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
        pricePerLabel: PRICE_PER_LABELS[p.pricePer],
        breaks: p.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
        amount: amounts[i],
      })),
    };
  });

  return {
    company: s.company,
    quoteNumber: detail.quoteNumber,
    effectiveDate: detail.effectiveDate,
    expiryDate: detail.expiryDate,
    termsName: customer.terms?.name ?? "",
    rfqNumber: detail.rfqNumber,
    attn: detail.contactName,
    customerPhone,
    billTo: billToLines(customer.name, billTo),
    introText: s.introText,
    lines,
    endingStatementText: detail.endingStatementText,
    notes: detail.notes,
    liabilityText: s.liabilityText,
    signer: { name: detail.quotedByName, title: quotedBy?.title ?? "" },
  };
}

/**
 * Renders and archives the quote, returning the exact bytes stored (spec §6; the printInvoice/
 * printCert shape). The claim is the load-bearing part: read-under-claim → render → the ONE
 * mutation (`storeDocument`, kind `QUOTE`, `quoteId` owner) commit together, so the archive
 * cannot land against a state a concurrent delete changed out from under it (the Phase 4
 * print-vs-void lesson). A DELETED quote refuses a NEW print with the shared `VOIDED_PRINT` 400
 * (`assertPrintable` — the discarded-invoice precedent) while every STORED print stays listable
 * and reprintable forever (§5.6); a CLOSED or expired quote prints fine — closing forbids edits,
 * not the paper of the agreement it records.
 */
export async function printQuote(
  id: string,
): Promise<{ documentId: string; quoteNumber: number; pdf: Buffer }> {
  const settings = await quotePrintSettings(); // OUTSIDE the transaction (the cert/ticket precedent)

  return withDbErrors({ entity: "Quote" }, () =>
    prisma.$transaction(async (tx) => {
      const quote = await claimQuote(tx, id);
      if (!quote) throw new HttpError(404, "Quote not found");
      assertPrintable(quote);

      const data = await readQuotePdfData(tx, id, settings);
      const pdf = await renderPdf(buildQuoteDefinition(data));

      const doc = await storeDocument(tx, { kind: "QUOTE", quoteId: id }, pdf);
      return { documentId: doc.id, quoteNumber: quote.quoteNumber, pdf };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

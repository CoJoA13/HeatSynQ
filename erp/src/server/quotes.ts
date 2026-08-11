import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { LOT_WITH_BREAKS } from "./part-prices";
import { currentActor } from "./context";
import { getSetting, allocateNumber } from "./settings";
import { addDays, formatDateOnly, parseDateOnly, todayDateOnly } from "../lib/business-days";
import { PRICE_PER, type PricePerValue } from "../lib/part-constants";
import { INT4_MAX } from "../lib/order-constants";
import { type QuoteStatusValue } from "../lib/quote-constants";

// ============================================================================================
// The quote service (Phase 6, spec §5.1/§5.4). A quote is a STANDING PRICE AGREEMENT (ruling
// 3): born numbered and OPEN, effective over a date window, priced in 5A's exact vocabulary
// (QuotePrice/QuotePriceBreak mirror PartPrice/PartPriceBreak — ruling 2, and this module
// mirrors part-prices.ts's validation shapes for the same reason). "Expired" is DERIVED from
// the expiry date against today — never a status flip, never a job.
//
// This file owns create/read/list/worklist/export (Task 3). Update/close/reopen/delete and the
// routes are Task 4; the order-side eligibility leaf (quote-links.ts) is Task 5.
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

type Db = Prisma.TransactionClient;

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
 */
export async function createQuote(input: unknown): Promise<QuoteDetail> {
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
            lines: {
              create: data.lines.map((line, i) => ({
                position: i + 1,
                partId: line.partId ?? null,
                partNumberText: line.partNumberText,
                partNameText: line.partNameText,
                partDescriptionText: line.partDescriptionText,
                materialText: line.materialText,
                eachWeight: line.eachWeight ?? null,
                quotedQty: line.quotedQty ?? null,
                quotedUnlimited: line.quotedUnlimited,
                prices: {
                  create: line.prices.map((price, j) => ({
                    position: j + 1,
                    processStepCodeId: price.processStepCodeId,
                    setupCharge: price.setupCharge ?? null,
                    unitPrice: price.unitPrice ?? null,
                    minimumCharge: price.minimumCharge ?? null,
                    pricePer: price.pricePer ?? "EACH",
                    notes: price.notes,
                    breaks: {
                      create: price.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
                    },
                  })),
                },
              })),
            },
          },
          select: { id: true },
        }),
        { tx },
      );

      return readDetail(tx, quote.id);
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

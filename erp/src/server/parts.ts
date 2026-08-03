import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { parseRecords, isBlankRecord, overflowError } from "./tsv";
import { readableMessage } from "./error-message";
import { PRICE_PER, PRICING_FIELDS, PART_PASTE_COLUMNS, type PricePerValue } from "../lib/part-constants";
import type { PasteResult } from "./paste";
import type { Blocker } from "./reference-blockers";

export type PartRow = {
  id: string; customerId: string; customerCode: string; customerName: string;
  partNumber: string; name: string; description: string;
  materialId: string | null; materialName: string | null;
  eachWeight: number; loadQty: number | null; loadWeight: number | null;
  requestDaysOverride: number | null;
  serializationRequired: boolean;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; active: boolean;
  /** Whether the part's CURRENT (highest-numbered) process revision carries at least one step —
   *  the same "orderable" check `lockCurrentRevision` performs at order-save time
   *  (part-process-steps.ts), read here so order entry's lead-part picker can show it up front
   *  (design spec §11) instead of only learning it after a pick. A part with no revision at all
   *  is `false`, matching `lockCurrentRevision`'s own "claimed.length === 0" branch. */
  hasProcessSteps: boolean;
};

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on Part.
const FIELDS = {
  partNumber: z.string().trim().min(1).max(60),
  name: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  materialId: z.string().nullable().optional(),
  eachWeight: decimalField(10, 4, { required: true, min: "positive" }),
  loadQty: z.number().int().min(1).nullable().optional(),
  loadWeight: decimalField(10, 2, { min: "positive" }),
  requestDaysOverride: z.number().int().min(0).nullable().optional(),
  serializationRequired: z.boolean().optional(),
  setupCharge: decimalField(12, 2, { min: "nonnegative" }),
  unitPrice: decimalField(12, 4, { min: "nonnegative" }),
  minimumCharge: decimalField(12, 2, { min: "nonnegative" }),
  pricePer: z.enum(PRICE_PER).optional(),
  active: z.boolean().optional(),
};
const CREATE = z.object({ customerId: z.string().min(1), ...FIELDS }).strict();
const UPDATE = z.object(FIELDS).partial().strict();   // no customerId — immutable by design

const SELECT = {
  id: true, customerId: true, partNumber: true, name: true, description: true,
  materialId: true, eachWeight: true, loadQty: true, loadWeight: true, requestDaysOverride: true,
  serializationRequired: true, setupCharge: true, unitPrice: true, minimumCharge: true,
  pricePer: true, active: true,
  customer: { select: { code: true, name: true } },
  material: { select: { name: true } },
} as const;

type Raw = Prisma.PartGetPayload<{ select: typeof SELECT }>;
function toRow(r: Raw, hasProcessSteps: boolean): PartRow {
  const { customer, material, eachWeight, loadWeight, setupCharge, unitPrice, minimumCharge, ...rest } = r;
  return {
    ...rest, customerCode: customer.code, customerName: customer.name,
    materialName: material?.name ?? null,
    eachWeight: eachWeight.toNumber(), loadWeight: num(loadWeight),
    setupCharge: num(setupCharge), unitPrice: num(unitPrice), minimumCharge: num(minimumCharge),
    pricePer: r.pricePer as PricePerValue,
    hasProcessSteps,
  };
}

/**
 * For each given part id, whether its current (highest-numbered) `PartProcessRevision` carries
 * at least one step. ONE additional query for the whole batch — not N+1 — ordered so the FIRST
 * row encountered per `partId` is that part's highest revision (mirrors `lockCurrentRevision`'s
 * own `ORDER BY revisionNumber DESC LIMIT 1`, just read for many parts instead of one). A part
 * with a lower, superseded revision that once had steps must still read false if its CURRENT
 * revision has none — the same rule `lockCurrentRevision` enforces at save time.
 */
async function hasProcessStepsByPart(partIds: string[]): Promise<Map<string, boolean>> {
  if (partIds.length === 0) return new Map();
  const revisions = await prisma.partProcessRevision.findMany({
    where: { partId: { in: partIds } },
    orderBy: [{ partId: "asc" }, { revisionNumber: "desc" }],
    select: { partId: true, _count: { select: { steps: true } } },
  });
  const result = new Map<string, boolean>();
  for (const rev of revisions) {
    if (!result.has(rev.partId)) result.set(rev.partId, rev._count.steps > 0);
  }
  return result;
}

export async function listParts(opts?: { includeInactive?: boolean; search?: string }): Promise<PartRow[]> {
  const q = opts?.search?.trim();
  const rows = await prisma.part.findMany({
    where: {
      deletedAt: null,
      ...(opts?.includeInactive ? {} : { active: true }),
      ...(q ? { OR: [
        { partNumber: { contains: q, mode: "insensitive" } },
        { customer: { code: { contains: q, mode: "insensitive" } } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
      ] } : {}),
    },
    select: SELECT,
    orderBy: [{ customer: { code: "asc" } }, { partNumber: "asc" }],
  });
  const stepsByPart = await hasProcessStepsByPart(rows.map((r) => r.id));
  return rows.map((r) => toRow(r, stepsByPart.get(r.id) ?? false));
}

export async function getPart(id: string): Promise<PartRow> {
  const row = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  if (!row) throw new HttpError(404, "Part not found");
  const stepsByPart = await hasProcessStepsByPart([id]);
  return toRow(row, stepsByPart.get(id) ?? false);
}

export async function createPart(input: Record<string, unknown>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // Courtesy 400 for the ordinary case; the partial unique index is the real guard, and its
  // P2002 maps through withDbErrors below for the race case. findFirst, never findUnique.
  const dupe = await prisma.part.findFirst({
    where: { customerId: data.customerId, partNumber: data.partNumber, deletedAt: null },
    select: { id: true },
  });
  if (dupe) throw new HttpError(400, "A part with that part number already exists for that customer");

  const row = await withDbErrors({ entity: "Part", conflictField: "part number" }, () =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: data.customerId, deletedAt: null }, select: { id: true } });
      if (!customer) throw new HttpError(400, "That customer does not exist");
      if (data.materialId) await assertRefExists("material", data.materialId, tx);
      return auditedCreate("part", data, () => tx.part.create({ data }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/** Writes only if still live, one statement — the claimLiveAndUpdate precedent (customers.ts). */
async function claimLive(tx: Prisma.TransactionClient, id: string, data: Prisma.PartUpdateManyMutationInput) {
  const { count } = await tx.part.updateMany({ where: { id, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Part not found");
}

export async function updatePart(id: string, input: Record<string, unknown>): Promise<void> {
  if ("customerId" in input) {
    throw new HttpError(400,
      "A part cannot move to another customer — deactivate it and key a new part instead");
  }
  const data = UPDATE.parse(input);
  const current = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Part not found");

  // Serializable only where a cross-row invariant exists: a materialId assignment (pairs with
  // deleteReference's blocker scan) or a pricePer change (pairs with addPartBreak's LOT check).
  const needsSerializable = data.materialId != null || data.pricePer !== undefined;
  const iso = needsSerializable
    ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined;

  await withDbErrors({ entity: "Part", conflictField: "part number" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.materialId) await assertRefExists("material", data.materialId, tx);
      if (data.pricePer === "LOT") {
        const breaks = await tx.partPriceBreak.count({ where: { partId: id, deletedAt: null } });
        if (breaks > 0) {
          throw new HttpError(400,
            "A LOT-priced part cannot carry price breaks — delete the price breaks first");
        }
      }
      await auditedUpdate("part", id, () => claimLive(tx, id, data), { tx });
    }, iso));
}

/**
 * Every LIVE order carrying a line — lead or rider, `OrderLine` draws no distinction — whose
 * `partId` is this part. The direct analogue of `customerPartBlockers` above, scoped to
 * Order/OrderLine instead of Part/Customer, and named the same way `reference-links.ts`'s own
 * `orderContainer -> containerType` entry already names an Order blocker elsewhere in the app:
 * "#1042 · ACME", never a bare order number, since a number alone means nothing without knowing
 * whose it is. A part referenced twice within the SAME order (two lines, same partId — the
 * schema has no constraint against it) must still list that order once, hence the dedupe by
 * order id rather than a bare row-per-line map.
 */
export async function partOrderBlockers(partId: string): Promise<Blocker[]> {
  const lines = await prisma.orderLine.findMany({
    where: { partId, order: { deletedAt: null } },
    select: { order: { select: { id: true, orderNumber: true, customer: { select: { code: true } } } } },
    orderBy: { order: { orderNumber: "asc" } },
  });
  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const { order } of lines) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    out.push({
      entityLabel: "Order", name: `#${order.orderNumber} · ${order.customer.code}`,
      id: order.id, href: `/orders/${order.id}`,
    });
  }
  return out;
}

export async function deletePart(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a part");
  const current = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Part not found");

  // F2: Serializable, pairing with addPartSpec/addPartInspection/addPartBreak, which each read
  // this part live ON tx (assertPartLive) under Serializable before adding a child. Without both
  // sides sharing Serializable, a concurrent "add a child to this part" and "delete this part"
  // can each pass their own pre-check (part still live there, cascade already snapshotted the
  // child list here) before either commits — a child added mid-delete outlives its now-dead
  // parent, breaking the invariant findBlockers-style scans over "live children of a live part"
  // depend on. Postgres aborts whichever side would produce a result no serial ordering could,
  // surfacing as P2034 and translated by withDbErrors into a 409 telling the caller to retry.
  // The same Serializable sharing now also pairs this guard with createOrder/addLine (orders.ts),
  // both of which resolve their lines' parts live, under Serializable, before writing.
  await withDbErrors({ entity: "Part" }, () => prisma.$transaction(async (tx) => {
    // Task 15: a part still doing work on a live order cannot be deleted out from under it — a
    // voided order (deletedAt set) does not count, matching every other "voided blocks nothing"
    // rule in this app (global constraints). Counting live ORDERS (not lines) is what
    // `partOrderBlockers` above also dedupes to, so the refusal's count and the panel's list
    // never disagree about how many rows are actually blocking.
    const orders = await tx.order.count({ where: { deletedAt: null, lines: { some: { partId: id } } } });
    if (orders > 0) throw new HttpError(400, `That part is used by ${orders} live order(s)`);

    const [specs, inspections, breaks] = await Promise.all([
      tx.partSpecification.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
      tx.partInspection.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
      tx.partPriceBreak.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
    ]);
    for (const s of specs) await auditedSoftDelete("partSpecification", s.id, "parent part deleted", tx);
    for (const i of inspections) await auditedSoftDelete("partInspection", i.id, "parent part deleted", tx);
    for (const b of breaks) await auditedSoftDelete("partPriceBreak", b.id, "parent part deleted", tx);
    await auditedSoftDelete("part", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

function parseBool(cell: string, column: string): boolean {
  const v = cell.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["", "no", "n", "false", "0"].includes(v)) return false;
  throw new HttpError(400, `${column} must be Yes or No`);
}

function parsePricePer(cell: string): string {
  const v = cell.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((PRICE_PER as readonly string[]).includes(v)) return v;
  throw new HttpError(400, `Price per must be one of: ${PRICE_PER.join(", ")}`);
}

/**
 * Creates every valid row and collects failures per row — the pasteCustomers precedent
 * (customers.ts). Two cells resolve against other tables before createPart ever sees them:
 * customerCode -> customerId and materialName -> materialId, both against LIVE rows only
 * (findFirst, never findUnique — customer.code and material.name are both unique-among-live-rows
 * partial indexes, so findUnique would silently accept a soft-deleted match).
 */
export async function pasteParts(text: string, opts: { allowPricing: boolean }): Promise<PasteResult> {
  const columns = [...PART_PASTE_COLUMNS];
  const { records, error } = parseRecords(text);
  const errors: PasteResult["errors"] = [];
  let created = 0;

  for (const record of records) {
    if (isBlankRecord(record.fields)) continue;
    const overflow = overflowError(record.fields, columns);
    if (overflow) { errors.push({ row: record.startLine, message: overflow }); continue; }
    const row: Record<string, string> =
      Object.fromEntries(columns.map((c, i) => [c, record.fields[i] ?? ""]));

    try {
      // Presence, not truthiness — an empty cell can't carry a price, so only a non-empty
      // pricing cell needs the gate. Checked before any lookup so a paster without
      // change_prices never triggers customer/material queries for a row that will be
      // rejected anyway.
      if (!opts.allowPricing && PRICING_FIELDS.some((c) => row[c] !== "")) {
        throw new HttpError(400, "Requires change_prices to paste pricing columns");
      }

      const customer = await prisma.customer.findFirst({
        where: { code: row.customerCode, deletedAt: null }, select: { id: true },
      });
      if (!customer) throw new HttpError(400, `Customer "${row.customerCode}" does not exist`);

      let materialId: string | undefined;
      if (row.materialName !== "") {
        const material = await prisma.material.findFirst({
          where: { name: row.materialName, deletedAt: null }, select: { id: true },
        });
        if (!material) throw new HttpError(400, `Material "${row.materialName}" does not exist`);
        materialId = material.id;
      }

      // z.number() has no string coercion, unlike decimalField below — a raw cell here would
      // either reject a valid "10" as the wrong type, or (worse) let a non-numeric cell become
      // NaN and reach zod as a bare "nan", so the integer check happens by hand.
      let loadQty: number | undefined;
      if (row.loadQty !== "") {
        const n = Number(row.loadQty);
        if (!Number.isInteger(n)) throw new HttpError(400, "Load qty must be a whole number");
        loadQty = n;
      }

      const input: Record<string, unknown> = {
        customerId: customer.id,
        partNumber: row.partNumber,
        eachWeight: row.eachWeight,
        serializationRequired: parseBool(row.serializationRequired, "Serialization"),
      };
      if (row.name !== "") input.name = row.name;
      if (row.description !== "") input.description = row.description;
      if (materialId) input.materialId = materialId;
      if (loadQty !== undefined) input.loadQty = loadQty;
      if (row.loadWeight !== "") input.loadWeight = row.loadWeight;
      if (row.setupCharge !== "") input.setupCharge = row.setupCharge;
      if (row.unitPrice !== "") input.unitPrice = row.unitPrice;
      if (row.minimumCharge !== "") input.minimumCharge = row.minimumCharge;
      if (row.pricePer !== "") input.pricePer = parsePricePer(row.pricePer);

      await createPart(input);
      created++;
    } catch (err) {
      errors.push({ row: record.startLine, message: readableMessage(err) });
    }
  }
  if (error) errors.push({ row: error.line, message: error.message });
  return { created, errors };
}

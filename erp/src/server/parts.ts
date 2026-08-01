import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { PRICE_PER, type PricePerValue } from "../lib/part-constants";

export type PartRow = {
  id: string; customerId: string; customerCode: string; customerName: string;
  partNumber: string; name: string; description: string;
  materialId: string | null; materialName: string | null;
  eachWeight: number; loadQty: number | null; loadWeight: number | null;
  serializationRequired: boolean;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; active: boolean;
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
  materialId: true, eachWeight: true, loadQty: true, loadWeight: true,
  serializationRequired: true, setupCharge: true, unitPrice: true, minimumCharge: true,
  pricePer: true, active: true,
  customer: { select: { code: true, name: true } },
  material: { select: { name: true } },
} as const;

type Raw = Prisma.PartGetPayload<{ select: typeof SELECT }>;
function toRow(r: Raw): PartRow {
  const { customer, material, eachWeight, loadWeight, setupCharge, unitPrice, minimumCharge, ...rest } = r;
  return {
    ...rest, customerCode: customer.code, customerName: customer.name,
    materialName: material?.name ?? null,
    eachWeight: eachWeight.toNumber(), loadWeight: num(loadWeight),
    setupCharge: num(setupCharge), unitPrice: num(unitPrice), minimumCharge: num(minimumCharge),
    pricePer: r.pricePer as PricePerValue,
  };
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
  return rows.map(toRow);
}

export async function getPart(id: string): Promise<PartRow> {
  const row = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  if (!row) throw new HttpError(404, "Part not found");
  return toRow(row);
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

export async function deletePart(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a part");
  const current = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Part not found");

  await withDbErrors({ entity: "Part" }, () => prisma.$transaction(async (tx) => {
    const [specs, inspections, breaks] = await Promise.all([
      tx.partSpecification.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
      tx.partInspection.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
      tx.partPriceBreak.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
    ]);
    for (const s of specs) await auditedSoftDelete("partSpecification", s.id, "parent part deleted", tx);
    for (const i of inspections) await auditedSoftDelete("partInspection", i.id, "parent part deleted", tx);
    for (const b of breaks) await auditedSoftDelete("partPriceBreak", b.id, "parent part deleted", tx);
    await auditedSoftDelete("part", id, why, tx);
  }));
}

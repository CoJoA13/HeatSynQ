import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { PART_FIELD_TYPES } from "../lib/part-constants";
import type { Blocker } from "./reference-blockers";

export type PartFieldDefRow = { id: string; name: string; type: string; sort: number; active: boolean };

const FIELDS = {
  name: z.string().trim().min(1).max(100),
  type: z.enum(PART_FIELD_TYPES),
  sort: z.number().int().min(0),
  active: z.boolean().optional(),
};
const CREATE = z.object(FIELDS).strict();
const EDIT = z.object(FIELDS).partial().strict();

export async function listPartFieldDefs(opts?: { includeInactive?: boolean }): Promise<PartFieldDefRow[]> {
  const rows = await prisma.partFieldDef.findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { sort: "asc" },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, sort: r.sort, active: r.active }));
}

export async function createPartFieldDef(input: Record<string, unknown>): Promise<{ id: string }> {
  const data = CREATE.parse(input);
  // findFirst, not findUnique: `name` is unique only among live rows, so findUnique would compile
  // and silently return the soft-deleted row (tests/partial-unique-sweep.test.ts bans it).
  const existing = await prisma.partFieldDef.findFirst({
    where: { name: data.name, deletedAt: null }, select: { id: true },
  });
  if (existing) throw new HttpError(400, "A part field with that name already exists");

  const row = await withDbErrors({ entity: "Part field", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedCreate("partFieldDef", data, () => tx.partFieldDef.create({ data }), { tx })));
  return { id: row.id };
}

/** Writes only if still live, one statement — the claimLiveAndUpdate precedent (customers.ts).
 *  F3: a patch that never touches `type` had no liveness claim at all (a bare `update({ where:
 *  { id } })`), so a stale PUT arriving after a delete edited the soft-deleted row and appended a
 *  post-delete audit entry. Shared by both the type-change and non-type-change paths below, so
 *  both patch shapes get the same guarantee. */
async function claimLive(tx: Prisma.TransactionClient, id: string, data: Prisma.PartFieldDefUpdateManyMutationInput) {
  const { count } = await tx.partFieldDef.updateMany({ where: { id, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Part field not found");
}

export async function updatePartFieldDef(id: string, input: Record<string, unknown>): Promise<void> {
  const data = EDIT.parse(input);
  if (data.name !== undefined) {
    const existing = await prisma.partFieldDef.findFirst({
      where: { name: data.name, deletedAt: null, id: { not: id } }, select: { id: true },
    });
    if (existing) throw new HttpError(400, "A part field with that name already exists");
  }

  // Serializable only when the patch carries a `type` key — the only case that can possibly be a
  // type change, and thus the only case needing the blocker scan below to run in the same
  // transaction as the write, exactly like deletePartFieldDef's guard (owner ruling, 2026-08-01:
  // a field's type cannot change while a live part still holds a non-empty value for it). A patch
  // that never touches `type` can't strand a value on a mismatched type, so it keeps the cheaper
  // default isolation it already had.
  const needsSerializable = data.type !== undefined;

  await withDbErrors({ entity: "Part field", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.type !== undefined) {
        const current = await tx.partFieldDef.findFirst({ where: { id, deletedAt: null }, select: { type: true } });
        if (!current) throw new HttpError(404, "Part field not found");
        // A same-type `type` key is not a change and is free even with values on the field.
        if (current.type !== data.type) {
          const blockers = await partFieldDefBlockersOn(tx, id);
          if (blockers.length) {
            throw new HttpError(400,
              `That field still holds a value on ${blockers.length} part(s) — its type cannot change`);
          }
        }
      }
      await auditedUpdate("partFieldDef", id, () => claimLive(tx, id, data), { tx });
    }, needsSerializable ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}

/** Every LIVE part holding a non-empty value for this field, deduped per part. Implemented once,
 *  parameterized on the client, so `deletePartFieldDef` can run it on its own `tx` (the blocker
 *  scan and the soft delete it guards must share one Serializable transaction — the findBlockers
 *  precedent in reference.ts/reference-blockers.ts) while the public `partFieldDefBlockers` runs
 *  the identical query on the top-level `prisma` client for callers outside a delete. */
async function partFieldDefBlockersOn(db: Prisma.TransactionClient, id: string): Promise<Blocker[]> {
  const values = await db.partFieldValue.findMany({
    where: { fieldId: id, value: { not: "" }, part: { deletedAt: null } },
    include: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const v of values) {
    if (seen.has(v.part.id)) continue;
    seen.add(v.part.id);
    out.push({
      entityLabel: "Part", name: `${v.part.customer.code} · ${v.part.partNumber}`,
      id: v.part.id, href: `/parts/${v.part.id}`,
    });
  }
  return out;
}

export async function partFieldDefBlockers(id: string): Promise<Blocker[]> {
  return partFieldDefBlockersOn(prisma, id);
}

export async function deletePartFieldDef(id: string): Promise<void> {
  await withDbErrors({ entity: "Part field" }, () =>
    prisma.$transaction(async (tx) => {
      const blockers = await partFieldDefBlockersOn(tx, id);
      if (blockers.length) {
        throw new HttpError(400, `That field still holds a value on ${blockers.length} part(s)`);
      }
      await auditedSoftDelete("partFieldDef", id, undefined, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

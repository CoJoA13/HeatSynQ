import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";

// saved-views.ts — audited normally (auditedCreate/auditedUpdate/auditedSoftDelete throughout).
// CRUD, own-rows-only, one default per user (design spec §8). Every read/write below is keyed on
// the `userId` the caller passes in (Task 10's route supplies the session user's own id), so
// cross-user access is structurally impossible rather than merely checked: a wrong-owner id and
// a missing id take the identical 404, never leaking which one it was.

export type SavedViewRow = {
  id: string;
  name: string;
  config: unknown;
  isDefault: boolean;
  updatedAt: Date;
};

function toRow(v: { id: string; name: string; config: unknown; isDefault: boolean; updatedAt: Date }): SavedViewRow {
  return { id: v.id, name: v.name, config: v.config, isDefault: v.isDefault, updatedAt: v.updatedAt };
}

// A bare JS `null` is ambiguous to Prisma's Json input and throws if passed straight through;
// `Prisma.JsonNull` says explicitly "store the JSON value null". `config` is a required (non-
// nullable) column, so there is no `Prisma.DbNull` case here the way order-drafts.ts has one.
const toJson = (value: unknown) => (value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));

const NAME = z.string().trim().min(1).max(80);
// `config` is opaque Json to the server — the client owns its shape (columns/filters/sort) — so
// there is deliberately no schema on its internals, only a presence check: without it, a missing
// `config` on create would sail past validation as `undefined` (z.unknown() type-checks it) and
// fail later as an unlabeled Prisma "argument missing" error instead of a clean 400/ZodError.
const CONFIG = z.unknown().refine((v) => v !== undefined, { message: "config is required" });

const CREATE = z.object({ name: NAME, config: CONFIG, isDefault: z.boolean().optional() }).strict();
const EDIT = z.object({ name: NAME.optional(), config: CONFIG.optional(), isDefault: z.boolean().optional() }).strict();

type Db = Prisma.TransactionClient;

/**
 * Clears isDefault on every OTHER live view this user holds, ahead of a write that is about to
 * set one view's isDefault to true. Demote-before-promote — the customer-addresses.ts house
 * pattern (demoteAllIn): demoting after the promoting write would leave a window where two of
 * this user's views are both default. Scoped to `userId` alone (no further partitioning the way
 * addresses partition by kind — a user has exactly one namespace of views), and written through
 * `auditedUpdate` rather than a bare `updateMany` so a demotion shows up in that view's own
 * history instead of silently going stale there.
 */
async function demoteOtherDefaults(db: Db, userId: string, exceptId?: string): Promise<void> {
  const rows = await db.savedView.findMany({
    where: { userId, deletedAt: null, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  for (const row of rows) {
    await auditedUpdate("savedView", row.id, () =>
      db.savedView.update({ where: { id: row.id }, data: { isDefault: false } }), { tx: db });
  }
}

export async function listViews(userId: string): Promise<SavedViewRow[]> {
  const rows = await prisma.savedView.findMany({
    where: { userId, deletedAt: null },
    orderBy: { name: "asc" },
  });
  return rows.map(toRow);
}

export async function createView(userId: string, input: unknown): Promise<SavedViewRow> {
  const parsed = CREATE.parse(input);

  // findFirst, NOT findUnique/upsert: `[userId, name]` is unique only among live rows (partial
  // index), but the generated client still types it unique — findUnique/upsert would compile and
  // silently misread or reuse the soft-deleted row (tests/partial-unique-sweep.test.ts).
  const existing = await prisma.savedView.findFirst({
    where: { userId, name: parsed.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A saved view with that name already exists");

  const data = {
    userId, name: parsed.name, config: toJson(parsed.config), isDefault: parsed.isDefault ?? false,
  };
  const row = await withDbErrors({ entity: "Saved view", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      // Default isolation (no registered-FK write here, no revision claim) — Serializable is for
      // the order save's own reasons, not a pattern to cargo-cult onto every transaction.
      if (data.isDefault) await demoteOtherDefaults(tx, userId);
      return auditedCreate("savedView", data, () => tx.savedView.create({ data }), { tx });
    }));
  return toRow(row);
}

export async function updateView(userId: string, id: string, input: unknown): Promise<SavedViewRow> {
  const data = EDIT.parse(input);

  // Fast, non-transactional 404 for the common case (wrong owner or bogus id) — scoped on
  // `userId` together with `id`, which is exactly what makes a wrong-owner id indistinguishable
  // from a missing one: both simply match no row.
  const current = await prisma.savedView.findFirst({ where: { id, userId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Saved view not found");

  const updated = await withDbErrors({ entity: "Saved view", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.isDefault === true) await demoteOtherDefaults(tx, userId, id);
      return auditedUpdate("savedView", id, async () => {
        // `updateMany` with `deletedAt: null` (and `userId`) in the WHERE, not a plain `update`
        // keyed on `id` alone: the findFirst pre-check above is a separate statement, so a
        // concurrent delete could otherwise land between the two and leave this editing a
        // soft-deleted row — the customer-addresses.ts updateAddress precedent for the same race.
        const { count } = await tx.savedView.updateMany({
          where: { id, userId, deletedAt: null },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.config !== undefined ? { config: toJson(data.config) } : {}),
            ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
          },
        });
        if (count === 0) throw new HttpError(404, "Saved view not found");
        return tx.savedView.findUniqueOrThrow({ where: { id } });
      }, { tx });
    }));
  return toRow(updated);
}

export async function deleteView(userId: string, id: string): Promise<void> {
  // No reason required — a per-user saved view name is low-stakes (HANDOFF §5.17's
  // classification: a delete needs a reason only when it cascades or frees a *shared* unique
  // identifier for reuse; this frees only a name inside one user's own private namespace).
  const current = await prisma.savedView.findFirst({ where: { id, userId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Saved view not found");
  await withDbErrors({ entity: "Saved view" }, () => prisma.$transaction(async (tx) => {
    await auditedSoftDelete("savedView", id, undefined, tx);
  }));
}

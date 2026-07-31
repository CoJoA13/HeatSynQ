import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { ADDRESS_KINDS, type AddressKind } from "../lib/customer-constants";

export type AddressRow = {
  id: string; kind: AddressKind; name: string; street: string;
  city: string; state: string; zip: string; isDefault: boolean; active: boolean;
};

const FIELDS = {
  kind: z.enum(ADDRESS_KINDS),
  name: z.string().max(200).optional(),
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  zip: z.string().max(20).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
};
const ADD = z.object(FIELDS).strict();
const EDIT = z.object(FIELDS).partial().strict();

// Kind order drives display: ship-to first because it is what order entry reaches for.
const KIND_ORDER: Record<AddressKind, number> = { SHIP_TO: 0, BILL_TO: 1, RECEIVED_FROM: 2 };

export async function listAddresses(
  customerId: string, opts?: { includeInactive?: boolean },
): Promise<AddressRow[]> {
  const rows = await prisma.customerAddress.findMany({
    where: { customerId, deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });
  return rows
    .map((r) => ({
      id: r.id, kind: r.kind as AddressKind, name: r.name, street: r.street,
      city: r.city, state: r.state, zip: r.zip, isDefault: r.isDefault, active: r.active,
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

// Anything that behaves like a Prisma client for the models we touch — either the top-level
// client or a `tx` handed to us by `prisma.$transaction`. Lets demoteAllIn/normalizeDefaultsIn
// run either standalone or fused into a caller's transaction with the exact same code.
type Db = Prisma.TransactionClient;

/**
 * Writes a single row's isDefault flag through the audit helpers rather than a bare `update` —
 * demoteAllIn/normalizeDefaultsIn used to write with direct updateMany/update calls that never
 * went through audited*, so a demoted address's history kept claiming isDefault: true forever
 * after the demotion: no audited write ever recorded the flip, so the row's most recent audit
 * entry (from whenever it was actually promoted) was the last word on it. Every normalization
 * write now goes through here instead.
 */
async function setDefault(db: Db, id: string, isDefault: boolean): Promise<void> {
  await auditedUpdate("customerAddress", id, () =>
    db.customerAddress.update({ where: { id }, data: { isDefault } }), { tx: db });
}

/**
 * Clears the default flag across a kind, given an explicit choice that is about to be written.
 * Called BEFORE the write that sets the new default, never after: demoting afterwards leaves a
 * window where two addresses of one kind are both default, and whichever read lands in that
 * window sees the wrong one. Demoting first leaves a window with none, which normalizeDefaultsIn
 * (below), run immediately after the write in the same transaction, closes.
 */
async function demoteAllIn(db: Db, customerId: string, kind: AddressKind) {
  const rows = await db.customerAddress.findMany({
    where: { customerId, kind, deletedAt: null, isDefault: true },
    select: { id: true },
  });
  for (const row of rows) await setDefault(db, row.id, false);
}

/**
 * Restores the invariant for one kind: if that kind has any active address, exactly one of them
 * is the default, and no inactive or soft-deleted row carries a stale default flag. Called after
 * every mutation rather than trying to enumerate every transition — the enumerated approach
 * (demote-before-promote alone) missed kind changes, explicit un-defaulting, and deactivation,
 * each of which can leave a kind with zero or two defaults without ever going through
 * demoteAllIn's guarded path.
 */
async function normalizeDefaultsIn(db: Db, customerId: string, kind: AddressKind): Promise<void> {
  // Rows that are soft-deleted or inactive must never carry the default flag.
  const stale = await db.customerAddress.findMany({
    where: {
      customerId, kind, isDefault: true,
      OR: [{ deletedAt: { not: null } }, { active: false }],
    },
    select: { id: true, deletedAt: true },
  });
  for (const row of stale) {
    // A soft-deleted row's own delete entry already captured its isDefault at the moment of
    // deletion (auditedSoftDelete's `before` snapshot); flipping the flag afterward is internal
    // bookkeeping on a row nothing displays again, not a fact worth its own audit entry. An
    // inactive-but-not-deleted row is still listed (includeInactive) and still worth auditing.
    if (row.deletedAt) await db.customerAddress.update({ where: { id: row.id }, data: { isDefault: false } });
    else await setDefault(db, row.id, false);
  }

  const activeRows = await db.customerAddress.findMany({
    where: { customerId, kind, deletedAt: null, active: true },
    orderBy: { name: "asc" },
    select: { id: true, isDefault: true },
  });
  if (activeRows.length === 0) return; // nothing to default

  const defaults = activeRows.filter((r) => r.isDefault);
  if (defaults.length === 1) return; // already correct

  // Zero defaults: fall back to the first active row by name. Two or more: keep the first of the
  // existing defaults by name (deterministic, since activeRows is already name-sorted) rather
  // than picking arbitrarily.
  const winnerId = (defaults[0] ?? activeRows[0]).id;
  for (const row of activeRows) {
    if (row.id !== winnerId && row.isDefault) await setDefault(db, row.id, false);
  }
  if (!defaults.some((d) => d.id === winnerId)) await setDefault(db, winnerId, true);
}

export async function addAddress(customerId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const owner = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } });
  if (!owner) throw new HttpError(404, "Customer not found");

  // The first ACTIVE address of a kind is the default whether or not the caller said so — a kind
  // with addresses but no default would leave order entry with nothing to pick. Only active,
  // non-deleted rows count toward "first": a stale inactive row must not suppress auto-defaulting
  // of the next address actually usable.
  const existing = await prisma.customerAddress.count({
    where: { customerId, kind: data.kind, deletedAt: null, active: true },
  });
  const isDefault = data.isDefault ?? existing === 0;

  // Demote (if applicable), create-with-audit, and normalize all run in one transaction, and the
  // audit write itself is pinned to the same `tx` (via auditedCreate's `opts.tx`) so the whole
  // sequence is one atomic unit — including the audit row, which rolls back with everything else
  // if anything downstream fails.
  const id = await prisma.$transaction(async (tx) => {
    if (isDefault) await demoteAllIn(tx, customerId, data.kind);
    const row = await auditedCreate("customerAddress", { ...data, customerId, isDefault }, () =>
      withDbErrors({ entity: "Address" }, () =>
        tx.customerAddress.create({ data: { ...data, customerId, isDefault } })), { tx });
    await normalizeDefaultsIn(tx, customerId, data.kind);
    return row.id;
  });
  return { id };
}

export async function updateAddress(addressId: string, input: Record<string, unknown>): Promise<void> {
  const data = EDIT.parse(input);
  const current = await prisma.customerAddress.findFirst({ where: { id: addressId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Address not found");
  const newKind = (data.kind ?? current.kind) as AddressKind;
  const oldKind = current.kind as AddressKind;

  await prisma.$transaction(async (tx) => {
    // Demote before promoting, for the reason on demoteAllIn — an explicit isDefault: true wins
    // deterministically rather than being arbitrarily re-picked by normalizeDefaultsIn below.
    if (data.isDefault === true) await demoteAllIn(tx, current.customerId, newKind);
    await withDbErrors({ entity: "Address" }, () =>
      auditedUpdate("customerAddress", addressId, async () => {
        const row = await tx.customerAddress.update({ where: { id: addressId }, data });
        // Normalize the address's kind post-update, and — if kind changed — the kind it left
        // behind: the old kind can be short a default (its default just moved away) exactly
        // like a delete would leave it, and the new kind can suddenly have two if the moved row
        // still carried isDefault: true from its old kind. This runs INSIDE doIt(), before
        // auditedUpdate takes its own "after" snapshot, so that snapshot reflects the fully
        // normalized row rather than a mid-transaction state that this very normalization goes
        // on to overwrite a moment later in the same transaction — otherwise the primary edit's
        // own audit entry would disagree with what actually got committed.
        await normalizeDefaultsIn(tx, current.customerId, newKind);
        if (data.kind && data.kind !== oldKind) {
          await normalizeDefaultsIn(tx, current.customerId, oldKind);
        }
        return row;
      }, { tx }));
  });
}

export async function deleteAddress(addressId: string): Promise<void> {
  const current = await prisma.customerAddress.findFirst({ where: { id: addressId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Address not found");
  // The soft delete, its audit write, and the re-normalization all run in one transaction: a
  // transaction can read its own soft-delete (normalizeDefaultsIn re-queries active rows to pick
  // a new default, and needs to see this delete already applied), and if normalization failed
  // after the delete committed on its own, the API would error while the kind was left with
  // active addresses and no default.
  await withDbErrors({ entity: "Address" }, () => prisma.$transaction(async (tx) => {
    await auditedSoftDelete("customerAddress", addressId, undefined, tx);
    await normalizeDefaultsIn(tx, current.customerId, current.kind as AddressKind);
  }));
}

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
import { CUSTOMER_PASTE_COLUMNS } from "../lib/customer-constants";
import type { PasteResult } from "./paste";
import type { Blocker } from "./reference-blockers";

export type CustomerRow = {
  id: string; code: string; name: string;
  parentId: string | null; parentCode: string | null;
  termsId: string | null;
  creditLimit: number | null; creditHold: boolean; cod: boolean; taxable: boolean;
  defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string;
  surchargeOptOut: boolean; financeChargeRate: number | null; requestDaysOverride: number | null;
  active: boolean;
};

// Prisma returns Decimal objects, which serialize to JSON as an opaque shape rather than a
// number. Convert at the service boundary so routes, the UI, and Excel all see plain numbers.
const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

// Kept in sync with prisma/schema.prisma's `@db.Decimal(12, 2)` / `@db.Decimal(6, 4)` — see the
// comment on decimalField (src/server/decimal-field.ts) and the matching comment on the schema
// fields themselves.
const creditLimitField = decimalField(12, 2);
const financeChargeRateField = decimalField(6, 4);

const CREATE = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  parentId: z.string().nullable().optional(),
  termsId: z.string().nullable().optional(),
  creditLimit: creditLimitField,
  creditHold: z.boolean().optional(),
  cod: z.boolean().optional(),
  taxable: z.boolean().optional(),
  defaultPo: z.string().max(200).optional(),
  orderNotes: z.string().max(4000).optional(),
  shippingNotes: z.string().max(4000).optional(),
  invoiceNotes: z.string().max(4000).optional(),
  surchargeOptOut: z.boolean().optional(),
  financeChargeRate: financeChargeRateField,
  // Capped to match addBusinessDays' own guard (src/lib/business-days.ts, fix-wave finding 5) —
  // this value feeds straight into its day-at-a-time loop as the customer's own override.
  requestDaysOverride: z.number().int().min(0).max(3650).nullable().optional(),
  active: z.boolean().optional(),
}).strict();

const SELECT = {
  id: true, code: true, name: true, parentId: true, termsId: true,
  creditLimit: true, creditHold: true, cod: true, taxable: true,
  defaultPo: true, orderNotes: true, shippingNotes: true, invoiceNotes: true,
  surchargeOptOut: true, financeChargeRate: true, requestDaysOverride: true, active: true,
  parent: { select: { code: true } },
} as const;

type Raw = Prisma.CustomerGetPayload<{ select: typeof SELECT }>;
function toRow(r: Raw): CustomerRow {
  const { parent, creditLimit, financeChargeRate, ...rest } = r;
  return { ...rest, parentCode: parent?.code ?? null,
    creditLimit: num(creditLimit), financeChargeRate: num(financeChargeRate) };
}

export async function listCustomers(opts?: { includeInactive?: boolean; search?: string }): Promise<CustomerRow[]> {
  const q = opts?.search?.trim();
  const rows = await prisma.customer.findMany({
    where: {
      deletedAt: null,
      ...(opts?.includeInactive ? {} : { active: true }),
      ...(q ? { OR: [
        { code: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ] } : {}),
    },
    select: SELECT,
    orderBy: { code: "asc" },
  });
  return rows.map(toRow);
}

export async function getCustomer(id: string): Promise<CustomerRow> {
  const row = await prisma.customer.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  if (!row) throw new HttpError(404, "Customer not found");
  return toRow(row);
}

// Either the top-level client or a `tx` from prisma.$transaction — lets the hierarchy guards run
// standalone or fused into a caller's transaction with the same code (same shape as
// customer-addresses.ts's Db).
type Db = Prisma.TransactionClient;

/**
 * Rejects a parentId that doesn't reference a live customer. Soft deletion leaves the row
 * physically present, so the FK constraint alone accepts it — the result is an active child
 * whose parent appears in no customer list. Shared by fresh creates (which skip the cycle walk
 * below but still must not point at a deleted row) and assertNoCycle.
 */
async function assertParentExists(parentId: string, db: Db = prisma): Promise<void> {
  const parent = await db.customer.findFirst({ where: { id: parentId, deletedAt: null }, select: { id: true } });
  if (!parent) throw new HttpError(400, "That parent does not exist");
}

/**
 * Rejects a parent chain that would make `id` its own ancestor, and rejects a soft-deleted
 * parent. Only meaningful for a row that already exists — a genuinely fresh row cannot yet be
 * anyone's ancestor, so createCustomer calls assertParentExists directly instead; only
 * updateCustomer calls this.
 */
async function assertNoCycle(
  id: string, parentId: string | null | undefined, db: Db = prisma,
): Promise<void> {
  if (!parentId) return;
  if (parentId === id) throw new HttpError(400, "A customer cannot be its own ancestor");
  await assertParentExists(parentId, db);
  let cursor: string | null = parentId;
  const seen = new Set<string>([id]);
  while (cursor) {
    if (seen.has(cursor)) throw new HttpError(400, "That parent would create a circular relationship");
    seen.add(cursor);
    const next: { parentId: string | null } | null =
      await db.customer.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = next?.parentId ?? null;
  }
}

export async function createCustomer(input: Record<string, unknown>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // Unique only among live rows (see prisma/schema.prisma), so a deleted code is free to be
  // re-used and simply becomes a new row. findFirst, NOT findUnique: the column is still typed
  // unique on the client, so findUnique compiles and silently returns the soft-deleted row.
  const existing = await prisma.customer.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A customer with that code already exists");

  // A genuinely fresh row does not exist yet, so it cannot be in anyone's parent chain — only
  // existence/non-deletion of the requested parent needs checking. Both target checks run
  // inside the write's own Serializable transaction (assertRefExists's doc comment explains
  // why an outside-the-transaction read cannot close the writer-side TOCTOU).
  const row = await withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.parentId) await assertParentExists(data.parentId, tx);
      if (data.termsId) await assertRefExists("terms", data.termsId, tx);
      return auditedCreate("customer", data, () => tx.customer.create({ data }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/**
 * Writes the patch only if the row is still live, in one statement. The callers' `findFirst`
 * pre-check gives the ordinary "already deleted" case a well-labelled 404, but it is a separate
 * statement from the write — a DELETE committing in between would otherwise leave the update
 * modifying a soft-deleted row and appending an "update" audit entry after that row's "delete"
 * entry, while reporting success. Throwing from inside auditedUpdate's callback means no audit
 * entry is written for an update that never claimed the row.
 */
async function claimLiveAndUpdate(
  db: Db, id: string, data: Prisma.CustomerUpdateManyMutationInput,
): Promise<void> {
  const { count } = await db.customer.updateMany({ where: { id, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Customer not found");
}

export async function updateCustomer(id: string, input: Record<string, unknown>): Promise<void> {
  const data = CREATE.partial().strict().parse(input);
  // customer-addresses.ts and customer-contacts.ts both guard their update path on
  // deletedAt: null and 404; this mirrors that. Without it, a soft-deleted row (invisible to
  // every list) accepts writes and reports success — the owner edits a customer they can no
  // longer find, and the edit vanishes into a row nothing displays again.
  const current = await prisma.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Customer not found");

  // A parent change or a non-null termsId assignment validates and writes inside ONE
  // Serializable transaction. Reading the target and then writing as two separate statements is
  // not enough: two concurrent requests setting A.parent = B and B.parent = A can each observe
  // the other row still parentless, both pass assertNoCycle, and both commit — producing exactly
  // the cycle the guard exists to prevent, and one that no single later request can be blamed
  // for. The same TOCTOU applies to termsId against a concurrent reference-delete
  // (assertRefExists's doc comment). Serializable makes Postgres abort whichever transaction
  // would produce a result no serial ordering could, surfacing as P2034 and translated by
  // withDbErrors into a 409 telling the caller to retry.
  //
  // Scoped to these two changes on purpose. Serializable costs more and can abort under ordinary
  // concurrency, and every other column on this row is a last-write-wins scalar with no
  // cross-row invariant to protect — only the hierarchy and the terms FK have one.
  // `null` clears termsId, which is always legal and needs no check.
  if (data.parentId !== undefined || data.termsId) {
    await withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
      prisma.$transaction(async (tx) => {
        await assertNoCycle(id, data.parentId, tx);
        if (data.termsId) await assertRefExists("terms", data.termsId, tx);
        await auditedUpdate("customer", id, () => claimLiveAndUpdate(tx, id, data), { tx });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    return;
  }

  // In a transaction so the write and its audit row commit together — see updateContact for why
  // that ordering matters when an edit races a delete.
  await withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("customer", id, () => claimLiveAndUpdate(tx, id, data), { tx })));
}

/**
 * Every LIVE part belonging to this customer, regardless of `active` — deliberately unfiltered,
 * because inactive parts are hidden from the parts list by default but still count against
 * deleteCustomer's guard below, and because the parts list has no true customer filter to begin
 * with. Both are exactly the gap that made §11's original "a count, not a blocker list" call
 * wrong (owner ruling 2026-08-01, PR #13 round 3 review — see the dated note on that bullet).
 * Ordered by partNumber, named the same way partFieldDefBlockers names a Part blocker: a Part is
 * (customer, partNumber), never a bare name (2C-1 spec §9) — and since every row here belongs to
 * THIS one customer, its own code is what every name shares.
 */
export async function customerPartBlockers(customerId: string): Promise<Blocker[]> {
  const parts = await prisma.part.findMany({
    where: { customerId, deletedAt: null },
    select: { id: true, partNumber: true, customer: { select: { code: true } } },
    orderBy: { partNumber: "asc" },
  });
  return parts.map((p) => ({
    entityLabel: "Part", name: `${p.customer.code} · ${p.partNumber}`, id: p.id, href: `/parts/${p.id}`,
  }));
}

/**
 * Every LIVE order whose OWN `customerId` is this customer — deliberately independent of
 * `customerPartBlockers` above: an order can outlive every part it references (a part deleted by
 * some path other than `deletePart`'s own new order-guard — e.g. data older than that guard — or
 * simply because no part of this customer is live any more while an order still is), so a
 * customer with zero live parts can still carry a live order that blocks it (Task 15). Named and
 * linked exactly the way `partOrderBlockers` (parts.ts) names an Order blocker — "#1042 · ACME",
 * `/orders/[id]` — for the same reason `customerPartBlockers` names a Part the way
 * `partFieldDefBlockers` does: one shared convention for how an entity kind names itself in every
 * blocker list it ever appears in.
 */
export async function customerOrderBlockers(customerId: string): Promise<Blocker[]> {
  const orders = await prisma.order.findMany({
    where: { customerId, deletedAt: null },
    select: { id: true, orderNumber: true, customer: { select: { code: true } } },
    orderBy: { orderNumber: "asc" },
  });
  return orders.map((o) => ({
    entityLabel: "Order", name: `#${o.orderNumber} · ${o.customer.code}`, id: o.id, href: `/orders/${o.id}`,
  }));
}

/**
 * `reason` is required, not optional — spec §9: "destructive-ish actions require a reason". This
 * one qualifies on three counts: it soft-deletes every address and contact along with the row,
 * it frees the `code` for reuse by a future customer that will be unrelated to this one, and it
 * is invisible afterwards to every list. Without a reason the audit entry cannot distinguish a
 * typo cleanup from an intentional removal, which is the question anyone reading the history
 * later is actually asking. Enforced in the service rather than only at the route so no future
 * caller can bypass it.
 */
export async function deleteCustomer(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a customer");

  // Same gap as updateCustomer above: without this, deleting an already soft-deleted customer
  // silently re-stamps deletedAt and mints a duplicate "delete" audit entry instead of reporting
  // that there is nothing left to delete.
  const current = await prisma.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Customer not found");

  // F1: the children and parts guard counts run ON tx, inside this same Serializable
  // transaction — not on the bare `prisma` client before it starts. This pairs with createPart's
  // Serializable in-tx customer-liveness read (parts.ts): without both halves sharing
  // Serializable, a concurrent "create a part for this customer" and "delete this customer" can
  // each pass their own pre-check (0 live parts here, customer still live there) before either
  // commits, leaving a live part hanging off a customer this same instant deleted — exactly the
  // orphan the parts guard below exists to prevent, and one no later request can undo (the part's
  // customer is gone). Serializable makes Postgres abort whichever side would produce a result no
  // serial ordering could, surfacing as P2034 and translated by withDbErrors into a 409 telling
  // the caller to retry. Messages and evaluation order (children before parts) are unchanged.
  await withDbErrors({ entity: "Customer" }, () => prisma.$transaction(async (tx) => {
    // Mirrors deleteRole's "still assigned" guard: orphaning children behind a deleted parent
    // would leave rows whose parentCode resolves to something no screen can show.
    const children = await tx.customer.count({ where: { parentId: id, deletedAt: null } });
    if (children > 0) throw new HttpError(400, "That customer still has child customers");

    // The guard itself stays a count, read in-tx exactly as F1 fixed it — only the message
    // changed (H4, PR #13 round 3 review, amends §11): §11's original call assumed the parts
    // list already named every blocker with links, but there is no true customer filter on that
    // list, and inactive parts block deletion while hidden from it by default. The count still
    // carries the refusal here; `customerPartBlockers` above is the separate, on-demand query
    // the /blockers route serves so the UI can show what those parts actually are.
    const parts = await tx.part.count({ where: { customerId: id, deletedAt: null } });
    if (parts > 0) throw new HttpError(400, `That customer still has ${parts} part(s)`);

    // Task 15: a direct scan on Order.customerId, independent of the parts guard above — a live
    // order survives even after every part it references has gone (see customerOrderBlockers'
    // own doc comment), so this must be its own check rather than something the parts count
    // already covers. Voided orders (deletedAt set) do not count, matching deletePart's identical
    // guard (parts.ts) and every other "voided blocks nothing" rule in this app.
    const orders = await tx.order.count({ where: { customerId: id, deletedAt: null } });
    if (orders > 0) throw new HttpError(400, `That customer still has ${orders} live order(s)`);

    // Addresses and contacts have no meaning without their parent, so they are soft-deleted
    // alongside it, in the same transaction and through the same audited* helpers as every other
    // mutation — consistent with every other soft-delete cascade in this file, and with what
    // listAddresses/listContacts already assume (deletedAt: null). A re-used code now produces a
    // brand new customer row (see createCustomer above), so this is no longer what stops a reused
    // code from resurrecting the previous occupant's dock and contact onto whoever types that
    // code next — a new row's id was never attached to the old rows in the first place — but the
    // cascade is still the correct outcome: a deleted customer's addresses and contacts should
    // not remain live and undeleted (this was Fix 2 in the final review, back when a reused code
    // did reuse the row).
    const [addresses, contacts] = await Promise.all([
      tx.customerAddress.findMany({ where: { customerId: id, deletedAt: null }, select: { id: true } }),
      tx.customerContact.findMany({ where: { customerId: id, deletedAt: null }, select: { id: true } }),
    ]);
    for (const a of addresses) await auditedSoftDelete("customerAddress", a.id, "parent customer deleted", tx);
    for (const c of contacts) await auditedSoftDelete("customerContact", c.id, "parent customer deleted", tx);
    await auditedSoftDelete("customer", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Creates every valid row and collects failures per row rather than aborting the batch — a
 * single typo on line 40 must not discard the 39 rows above it. Row numbers are the 1-based
 * line in the pasted text, counting blank lines (the user's spreadsheet still counts them) and
 * reporting a record that spans several physical lines at the line it starts on.
 */
export async function pasteCustomers(text: string): Promise<PasteResult> {
  const columns = [...CUSTOMER_PASTE_COLUMNS];
  const { records, error } = parseRecords(text);
  const errors: PasteResult["errors"] = [];
  let created = 0;

  for (const record of records) {
    if (isBlankRecord(record.fields)) continue;
    const overflow = overflowError(record.fields, columns);
    if (overflow) { errors.push({ row: record.startLine, message: overflow }); continue; }
    const row = Object.fromEntries(columns.map((c, i) => [c, record.fields[i] ?? ""]));
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(
      Object.entries(row).filter(([k, v]) => k === "code" || k === "name" || v !== ""));
    try {
      await createCustomer(input);
      created++;
    } catch (err) {
      errors.push({ row: record.startLine, message: readableMessage(err) });
    }
  }
  if (error) errors.push({ row: error.line, message: error.message });
  return { created, errors };
}

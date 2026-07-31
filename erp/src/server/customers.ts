import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { parseRecords, isBlankRecord, overflowError } from "./tsv";
import { readableMessage } from "./error-message";
import { CUSTOMER_PASTE_COLUMNS } from "../lib/customer-constants";
import type { PasteResult } from "./paste";

export type CustomerRow = {
  id: string; code: string; name: string;
  parentId: string | null; parentCode: string | null;
  termsId: string | null;
  creditLimit: number | null; creditHold: boolean; cod: boolean; taxable: boolean;
  defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string;
  surchargeOptOut: boolean; financeChargeRate: number | null; active: boolean;
};

// Prisma returns Decimal objects, which serialize to JSON as an opaque shape rather than a
// number. Convert at the service boundary so routes, the UI, and Excel all see plain numbers.
const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

// Accepts a plain number or a decimal string ("25000.00"), but never an arbitrary string: an
// invalid one (e.g. "not-a-number") used to sail through zod as a string and blow up inside
// Prisma with a PrismaClientValidationError, which has no HTTP status and escapes handle() as a
// bare 500 instead of the field-anchored 400 Spec §12 promises. Bounded to fit comfortably
// within both money columns' precision (Decimal(12,2) and Decimal(6,4)) with room to spare, so a
// value that passes here cannot overflow the database column either.
const DECIMAL_STRING = /^-?\d{1,10}(\.\d{1,4})?$/;
const MONEY_MAX = 999_999_999.9999;
const money = z.union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === null || value === undefined) return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > MONEY_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a valid decimal amount" });
        return z.NEVER;
      }
      return value;
    }
    const trimmed = value.trim();
    if (!DECIMAL_STRING.test(trimmed) || Math.abs(Number(trimmed)) > MONEY_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a valid decimal amount" });
      return z.NEVER;
    }
    return Number(trimmed);
  });

// A revived row must be indistinguishable from a fresh create — the owner typing a code that
// happens to match a deleted one is creating a customer, not resurrecting its commercial terms.
// The row id is reused only because the unique constraint forces it. Every field the caller
// does not supply on revival resets to its schema default, exactly as a genuine create would;
// the caller's input is then applied over the top.
const REVIVAL_DEFAULTS = {
  parentId: null, termsId: null, creditLimit: null, creditHold: false, cod: false,
  taxable: true, defaultPo: "", orderNotes: "", shippingNotes: "", invoiceNotes: "",
  surchargeOptOut: false, financeChargeRate: null,
} as const;

const CREATE = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  parentId: z.string().nullable().optional(),
  termsId: z.string().nullable().optional(),
  creditLimit: money,
  creditHold: z.boolean().optional(),
  cod: z.boolean().optional(),
  taxable: z.boolean().optional(),
  defaultPo: z.string().max(200).optional(),
  orderNotes: z.string().max(4000).optional(),
  shippingNotes: z.string().max(4000).optional(),
  invoiceNotes: z.string().max(4000).optional(),
  surchargeOptOut: z.boolean().optional(),
  financeChargeRate: money,
  active: z.boolean().optional(),
}).strict();

const SELECT = {
  id: true, code: true, name: true, parentId: true, termsId: true,
  creditLimit: true, creditHold: true, cod: true, taxable: true,
  defaultPo: true, orderNotes: true, shippingNotes: true, invoiceNotes: true,
  surchargeOptOut: true, financeChargeRate: true, active: true,
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

/**
 * Rejects a parentId that doesn't reference a live customer. Soft deletion leaves the row
 * physically present, so the FK constraint alone accepts it — the result is an active child
 * whose parent appears in no customer list. Shared by fresh creates (which skip the cycle walk
 * below but still must not point at a deleted row) and assertNoCycle.
 */
async function assertParentExists(parentId: string): Promise<void> {
  const parent = await prisma.customer.findFirst({ where: { id: parentId, deletedAt: null }, select: { id: true } });
  if (!parent) throw new HttpError(400, "That parent does not exist");
}

/**
 * Rejects a parent chain that would make `id` its own ancestor, and rejects a soft-deleted
 * parent. Only meaningful for a row that already exists (update, or the revival path of
 * create) — a genuinely fresh row cannot yet be anyone's ancestor, so createCustomer calls
 * assertParentExists directly instead for that case.
 */
async function assertNoCycle(id: string, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (parentId === id) throw new HttpError(400, "A customer cannot be its own ancestor");
  await assertParentExists(parentId);
  let cursor: string | null = parentId;
  const seen = new Set<string>([id]);
  while (cursor) {
    if (seen.has(cursor)) throw new HttpError(400, "That parent would create a circular relationship");
    seen.add(cursor);
    const next: { parentId: string | null } | null =
      await prisma.customer.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = next?.parentId ?? null;
  }
}

export async function createCustomer(input: Record<string, unknown>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // `code` is unique and deletion is soft, so a deleted code would otherwise be permanently
  // unusable — the owner deletes a typo, retypes it, and gets "already exists" for a row nothing
  // can display. Mirrors createReference (src/server/reference.ts) and createRole.
  const existing = await prisma.customer.findUnique({ where: { code: data.code } });
  if (existing && !existing.deletedAt) throw new HttpError(400, "A customer with that code already exists");

  // A genuinely fresh row does not exist yet, so it cannot be in anyone's parent chain — only
  // existence/non-deletion of the requested parent needs checking. A revival's row already
  // exists under `existing.id` (the code's original id, reused), exactly like update, so it
  // needs the full cycle guard: passing the deleted row's own id as parentId would otherwise
  // make it its own ancestor the moment it comes back.
  if (existing) await assertNoCycle(existing.id, data.parentId);
  else if (data.parentId) await assertParentExists(data.parentId);

  const row = existing
    ? await auditedUpdate("customer", existing.id, () =>
        withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
          // A revived row must come back live unless the caller explicitly asked otherwise;
          // returning it still inactive would make a "successful" create silently invisible.
          prisma.customer.update({
            where: { id: existing.id },
            data: { ...REVIVAL_DEFAULTS, ...data, deletedAt: null, active: data.active ?? true },
          })))
    : await auditedCreate("customer", data, () =>
        withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
          prisma.customer.create({ data })));
  return { id: row.id };
}

export async function updateCustomer(id: string, input: Record<string, unknown>): Promise<void> {
  const data = CREATE.partial().strict().parse(input);
  if (data.parentId !== undefined) await assertNoCycle(id, data.parentId);
  await withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
    auditedUpdate("customer", id, () => prisma.customer.update({ where: { id }, data })));
}

export async function deleteCustomer(id: string): Promise<void> {
  // Mirrors deleteRole's "still assigned" guard: orphaning children behind a deleted parent
  // would leave rows whose parentCode resolves to something no screen can show.
  const children = await prisma.customer.count({ where: { parentId: id, deletedAt: null } });
  if (children > 0) throw new HttpError(400, "That customer still has child customers");

  // Addresses and contacts have no meaning without their parent, and `code` is reusable on
  // revival (see REVIVAL_DEFAULTS above) — a re-created customer must start with none, exactly
  // like a fresh create, or a reused code would resurrect the previous occupant's dock and
  // contact onto whoever types that code next (this was Fix 2 in the final review: paste
  // supplies only the four CUSTOMER_PASTE_COLUMNS and cannot touch addresses, so a re-pasted
  // deleted code silently shipped to the previous customer's dock). Soft-deleting the children
  // here, in the same transaction as the customer row and through the same audited* helpers as
  // every other mutation, is what makes that guarantee hold: listAddresses/listContacts already
  // filter on deletedAt: null, so once these rows carry a deletedAt they simply won't show up
  // under the revived row.
  await withDbErrors({ entity: "Customer" }, () => prisma.$transaction(async (tx) => {
    const [addresses, contacts] = await Promise.all([
      tx.customerAddress.findMany({ where: { customerId: id, deletedAt: null }, select: { id: true } }),
      tx.customerContact.findMany({ where: { customerId: id, deletedAt: null }, select: { id: true } }),
    ]);
    for (const a of addresses) await auditedSoftDelete("customerAddress", a.id, "parent customer deleted", tx);
    for (const c of contacts) await auditedSoftDelete("customerContact", c.id, "parent customer deleted", tx);
    await auditedSoftDelete("customer", id, undefined, tx);
  }));
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

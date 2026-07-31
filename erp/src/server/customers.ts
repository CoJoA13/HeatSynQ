import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";

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

const money = z.union([z.number(), z.string()]).nullable().optional();

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
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(200),
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

/** Rejects a parent chain that would make `id` its own ancestor. */
async function assertNoCycle(id: string, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (parentId === id) throw new HttpError(400, "A customer cannot be its own ancestor");
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
  // No cycle check on create: a row that does not exist yet cannot be in anyone's parent chain.
  // A bogus parentId falls through to Prisma's FK constraint, which db-errors maps to a clean 400.

  // `code` is unique and deletion is soft, so a deleted code would otherwise be permanently
  // unusable — the owner deletes a typo, retypes it, and gets "already exists" for a row nothing
  // can display. Mirrors createReference (src/server/reference.ts) and createRole.
  const existing = await prisma.customer.findUnique({ where: { code: data.code } });
  if (existing && !existing.deletedAt) throw new HttpError(400, "A customer with that code already exists");

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
  await withDbErrors({ entity: "Customer" }, () => auditedSoftDelete("customer", id));
}

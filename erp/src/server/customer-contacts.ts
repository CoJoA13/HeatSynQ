import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";

export type ContactRow = {
  id: string; name: string; email: string; phone: string;
  getsShippers: boolean; getsInvoices: boolean; getsStatements: boolean; getsCerts: boolean;
  active: boolean;
};

// Blank is allowed — plenty of shop contacts are phone-only — but anything present must be a
// real address, since Phases 4-5 email documents to these and a typo fails silently at send time.
const email = z.union([z.literal(""), z.string().email().max(200)]).optional();

const FIELDS = {
  name: z.string().trim().min(1).max(200),
  email,
  phone: z.string().max(50).optional(),
  getsShippers: z.boolean().optional(),
  getsInvoices: z.boolean().optional(),
  getsStatements: z.boolean().optional(),
  getsCerts: z.boolean().optional(),
  active: z.boolean().optional(),
};
const ADD = z.object(FIELDS).strict();
const EDIT = z.object(FIELDS).partial().strict();

export async function listContacts(
  customerId: string, opts?: { includeInactive?: boolean },
): Promise<ContactRow[]> {
  const rows = await prisma.customerContact.findMany({
    where: { customerId, deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone,
    getsShippers: r.getsShippers, getsInvoices: r.getsInvoices,
    getsStatements: r.getsStatements, getsCerts: r.getsCerts, active: r.active,
  }));
}

export async function addContact(customerId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const owner = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } });
  if (!owner) throw new HttpError(404, "Customer not found");
  const row = await auditedCreate("customerContact", { ...data, customerId }, () =>
    withDbErrors({ entity: "Contact" }, () =>
      prisma.customerContact.create({ data: { ...data, customerId } })));
  return { id: row.id };
}

export async function updateContact(contactId: string, input: Record<string, unknown>): Promise<void> {
  const data = EDIT.parse(input);
  const current = await prisma.customerContact.findFirst({ where: { id: contactId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Contact not found");
  // The findFirst above gives the ordinary "already gone" case a well-labelled 404, but it is a
  // separate statement from the write: a DELETE committing in between would otherwise leave this
  // update modifying a soft-deleted row and appending an "update" entry after that row's
  // "delete" entry, while reporting success. `updateMany` with `deletedAt: null` in the WHERE
  // makes claiming the row and writing it one atomic statement, and throwing from inside
  // auditedUpdate's callback means the audit entry is never written when the row was lost.
  //
  // The mutation and its audit row also share one transaction (the gap handoff §6 records as
  // half-closed). That is what keeps the *history* honest as well as the data: with two
  // autocommit statements, a delete committing between this update's write and its audit insert
  // still produced a history reading "updated after it was deleted", even though the update had
  // legitimately claimed a live row. Inside a transaction the row lock the update takes holds
  // until the audit row is written, so a concurrent delete waits and the entries land in the
  // order the mutations actually happened.
  await withDbErrors({ entity: "Contact" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("customerContact", contactId, async () => {
        const { count } = await tx.customerContact.updateMany({
          where: { id: contactId, deletedAt: null }, data,
        });
        if (count === 0) throw new HttpError(404, "Contact not found");
      }, { tx })));
}

export async function deleteContact(contactId: string): Promise<void> {
  const current = await prisma.customerContact.findFirst({ where: { id: contactId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Contact not found");
  // In a transaction for the same reason updateContact is: the soft-delete write and its audit
  // row must commit together, or a concurrent edit can slot its own audit entry between them.
  await withDbErrors({ entity: "Contact" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("customerContact", contactId, undefined, tx)));
}

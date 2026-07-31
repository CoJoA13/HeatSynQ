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
  name: z.string().min(1).max(200),
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
  await withDbErrors({ entity: "Contact" }, () =>
    auditedUpdate("customerContact", contactId, () =>
      prisma.customerContact.update({ where: { id: contactId }, data })));
}

export async function deleteContact(contactId: string): Promise<void> {
  const current = await prisma.customerContact.findFirst({ where: { id: contactId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Contact not found");
  await withDbErrors({ entity: "Contact" }, () => auditedSoftDelete("customerContact", contactId));
}

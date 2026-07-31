import { z } from "zod";
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

/**
 * Clears the default flag across a kind. Always called BEFORE the write that sets the new
 * default, never after: demoting afterwards leaves a window where two addresses of one kind are
 * both default, and whichever read lands in that window sees the wrong one. Demoting first leaves
 * a window with none, which no code path treats as meaningful.
 */
async function demoteAll(customerId: string, kind: AddressKind) {
  await prisma.customerAddress.updateMany({
    where: { customerId, kind, deletedAt: null, isDefault: true },
    data: { isDefault: false },
  });
}

export async function addAddress(customerId: string, input: Record<string, unknown>): Promise<{ id: string }> {
  const data = ADD.parse(input);
  const owner = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } });
  if (!owner) throw new HttpError(404, "Customer not found");

  // The first address of a kind is the default whether or not the caller said so — a kind with
  // addresses but no default would leave order entry with nothing to pick.
  const existing = await prisma.customerAddress.count({
    where: { customerId, kind: data.kind, deletedAt: null },
  });
  const isDefault = data.isDefault ?? existing === 0;

  if (isDefault) await demoteAll(customerId, data.kind);
  const row = await auditedCreate("customerAddress", { ...data, customerId, isDefault }, () =>
    withDbErrors({ entity: "Address" }, () =>
      prisma.customerAddress.create({ data: { ...data, customerId, isDefault } })));
  return { id: row.id };
}

export async function updateAddress(addressId: string, input: Record<string, unknown>): Promise<void> {
  const data = EDIT.parse(input);
  const current = await prisma.customerAddress.findFirst({ where: { id: addressId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Address not found");
  // Demote before promoting, for the reason on demoteAll — never leave two defaults visible.
  if (data.isDefault === true) {
    await demoteAll(current.customerId, (data.kind ?? current.kind) as AddressKind);
  }
  await withDbErrors({ entity: "Address" }, () =>
    auditedUpdate("customerAddress", addressId, () =>
      prisma.customerAddress.update({ where: { id: addressId }, data })));
}

export async function deleteAddress(addressId: string): Promise<void> {
  const current = await prisma.customerAddress.findFirst({ where: { id: addressId, deletedAt: null } });
  if (!current) throw new HttpError(404, "Address not found");
  await withDbErrors({ entity: "Address" }, () => auditedSoftDelete("customerAddress", addressId));

  // Deleting the default would leave that kind with addresses but none marked — promote the
  // next one so order entry always has something to reach for.
  if (current.isDefault) {
    const next = await prisma.customerAddress.findFirst({
      where: { customerId: current.customerId, kind: current.kind, deletedAt: null, active: true },
      orderBy: { name: "asc" },
    });
    if (next) {
      await auditedUpdate("customerAddress", next.id, () =>
        prisma.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } }));
    }
  }
}

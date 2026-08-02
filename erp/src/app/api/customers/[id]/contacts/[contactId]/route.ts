import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateContact, deleteContact } from "@/server/customer-contacts";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  const { id, contactId } = await params;
  await updateContact(id, contactId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  const { id, contactId } = await params;
  await deleteContact(id, contactId);
  return NextResponse.json({ ok: true });
});

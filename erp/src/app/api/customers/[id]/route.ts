import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getCustomer, updateCustomer, deleteCustomer } from "@/server/customers";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await getCustomer((await params).id));
});

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await updateCustomer((await params).id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "delete");
  await deleteCustomer((await params).id);
  return NextResponse.json({ ok: true });
});

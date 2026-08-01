import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateAddress, deleteAddress } from "@/server/customer-addresses";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await updateAddress((await params).addressId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await deleteAddress((await params).addressId);
  return NextResponse.json({ ok: true });
});

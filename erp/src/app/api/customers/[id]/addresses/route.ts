import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listAddresses, addAddress } from "@/server/customer-addresses";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listAddresses((await params).id, { includeInactive }));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  return NextResponse.json(await addAddress((await params).id, await req.json()));
});

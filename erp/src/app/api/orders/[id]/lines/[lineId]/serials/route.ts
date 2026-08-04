import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { replaceSerials } from "@/server/orders";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  const { id, lineId } = await params;
  return NextResponse.json(await replaceSerials(id, lineId, await req.json()));
});

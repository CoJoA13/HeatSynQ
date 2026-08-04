import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { replaceCharges } from "@/server/orders";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  return NextResponse.json(await replaceCharges((await params).id, await req.json()));
});

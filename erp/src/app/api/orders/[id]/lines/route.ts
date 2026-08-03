import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { addLine } from "@/server/orders";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  return NextResponse.json(await addLine((await params).id, await req.json()));
});

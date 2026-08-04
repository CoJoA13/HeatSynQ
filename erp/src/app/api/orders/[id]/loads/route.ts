import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { replaceLoads } from "@/server/order-loads";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  return NextResponse.json(await replaceLoads((await params).id, await req.json()));
});

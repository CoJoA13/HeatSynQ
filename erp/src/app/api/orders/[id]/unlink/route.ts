import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { unlinkOrder } from "@/server/orders";

export const POST = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  return NextResponse.json(await unlinkOrder((await params).id));
});

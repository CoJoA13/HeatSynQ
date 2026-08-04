import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { resplitLoads } from "@/server/order-loads";

export const POST = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  return NextResponse.json(await resplitLoads((await params).id));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { replaceContainers } from "@/server/orders";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  return NextResponse.json(await replaceContainers((await params).id, await req.json()));
});

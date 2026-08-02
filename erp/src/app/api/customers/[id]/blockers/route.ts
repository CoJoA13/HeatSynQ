import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { customerPartBlockers } from "@/server/customers";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await customerPartBlockers((await params).id));
});

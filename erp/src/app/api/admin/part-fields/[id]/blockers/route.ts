import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { partFieldDefBlockers } from "@/server/part-field-defs";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await partFieldDefBlockers((await params).id));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { partOrderBlockers } from "@/server/parts";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await partOrderBlockers((await params).id));
});

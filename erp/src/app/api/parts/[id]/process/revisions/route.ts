import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getRevisions } from "@/server/part-process-steps";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "processes", "view");
  return NextResponse.json(await getRevisions((await params).id));
});

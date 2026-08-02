import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getRevision } from "@/server/part-process-steps";

const REVISION_NUMBER = z.coerce.number().int().min(1);

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "processes", "view");
  const { id, n } = await params;
  const revisionNumber = REVISION_NUMBER.parse(n);
  return NextResponse.json(await getRevision(id, revisionNumber));
});

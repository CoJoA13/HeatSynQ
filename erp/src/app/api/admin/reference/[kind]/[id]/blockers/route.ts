import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { assertKind } from "@/server/reference";
import { findBlockers } from "@/server/reference-blockers";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { kind, id } = await params;
  assertKind(kind);
  return NextResponse.json(await findBlockers(kind, id));
});

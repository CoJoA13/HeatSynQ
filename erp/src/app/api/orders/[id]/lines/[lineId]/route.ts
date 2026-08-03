import { NextResponse } from "next/server";
import { handle, requireUser, HttpError, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateLine, removeLine } from "@/server/orders";

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // An empty body changes nothing — report that as an error rather than a no-op 200
  // (parts/[id]/route.ts precedent).
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "PATCH body must include at least one change");
  }
  const { id, lineId } = await params;
  return NextResponse.json(await updateLine(id, lineId, body));
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  const { id, lineId } = await params;
  return NextResponse.json(await removeLine(id, lineId));
});

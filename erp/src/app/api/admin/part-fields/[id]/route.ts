import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updatePartFieldDef, deletePartFieldDef } from "@/server/part-field-defs";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const body = await req.json();
  // An empty body changes nothing — report that as an error rather than a no-op 200
  // (step-codes/[id]/route.ts precedent).
  if (Object.keys(body ?? {}).length === 0) {
    throw new HttpError(400, "PUT body must include at least one change");
  }
  await updatePartFieldDef((await params).id, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  await deletePartFieldDef((await params).id);
  return NextResponse.json({ ok: true });
});

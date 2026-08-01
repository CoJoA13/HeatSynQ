import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updatePartFieldDef, deletePartFieldDef } from "@/server/part-field-defs";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  await updatePartFieldDef((await params).id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  await deletePartFieldDef((await params).id);
  return NextResponse.json({ ok: true });
});

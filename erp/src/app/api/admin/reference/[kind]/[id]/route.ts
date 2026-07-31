import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateReference, deleteReference } from "@/server/reference";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { kind, id } = await params;
  await updateReference(kind, id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  const { kind, id } = await params;
  await deleteReference(kind, id);
  return NextResponse.json({ ok: true });
});

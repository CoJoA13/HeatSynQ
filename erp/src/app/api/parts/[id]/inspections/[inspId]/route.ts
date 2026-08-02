import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updatePartInspection, deletePartInspection } from "@/server/part-inspections";

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { id, inspId } = await params;
  await updatePartInspection(id, inspId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { id, inspId } = await params;
  await deletePartInspection(id, inspId);
  return NextResponse.json({ ok: true });
});

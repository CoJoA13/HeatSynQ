import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { removePartSpec } from "@/server/part-specifications";

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { id, linkId } = await params;
  await removePartSpec(id, linkId);
  return NextResponse.json({ ok: true });
});

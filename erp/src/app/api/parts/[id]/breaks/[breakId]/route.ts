import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { updatePartBreak, deletePartBreak } from "@/server/part-price-breaks";

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, breakId } = await params;
  await updatePartBreak(id, breakId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, breakId } = await params;
  await deletePartBreak(id, breakId);
  return NextResponse.json({ ok: true });
});

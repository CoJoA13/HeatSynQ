import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { updatePartPrice, deletePartPrice } from "@/server/part-prices";

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, priceId } = await params;
  await updatePartPrice(id, priceId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, priceId } = await params;
  await deletePartPrice(id, priceId);
  return NextResponse.json({ ok: true });
});

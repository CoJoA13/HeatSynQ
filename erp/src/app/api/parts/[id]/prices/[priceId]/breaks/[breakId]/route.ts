import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { updatePriceBreak, deletePriceBreak } from "@/server/part-prices";

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, priceId, breakId } = await params;
  await updatePriceBreak(id, priceId, breakId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, priceId, breakId } = await params;
  await deletePriceBreak(id, priceId, breakId);
  return NextResponse.json({ ok: true });
});

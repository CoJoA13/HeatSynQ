import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { listPartPrices, addPartPrice } from "@/server/part-prices";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await listPartPrices((await params).id));
});

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  // Pricing is gated by change_prices unconditionally, not by parts.edit alone.
  mustDo(user, "change_prices");
  return NextResponse.json(await addPartPrice((await params).id, await req.json()));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { addPriceBreak } from "@/server/part-prices";

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  mustDo(user, "change_prices");
  const { id, priceId } = await params;
  return NextResponse.json(await addPriceBreak(id, priceId, await req.json()));
});

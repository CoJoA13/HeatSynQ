import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { reorderPartPrices } from "@/server/part-prices";

const REORDER = z.object({ orderedIds: z.array(z.string().min(1)).min(1) }).strict();

export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  // Pricing is gated by change_prices unconditionally, not by parts.edit alone — every one of
  // the four existing price routes gates on both (src/app/api/parts/[id]/prices/route.ts and
  // .../prices/[priceId]/route.ts). This route writes pricing too, so it matches those, not the
  // inspections order route's single parts.edit gate.
  mustDo(user, "change_prices");
  const { orderedIds } = REORDER.parse(await req.json());
  await reorderPartPrices((await params).id, orderedIds);
  return NextResponse.json({ ok: true });
});

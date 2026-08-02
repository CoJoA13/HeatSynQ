import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, canDo } from "@/server/permissions";
import { pasteParts } from "@/server/parts";

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "parts", "create");
  const { text } = z.object({ text: z.string().min(1).max(200_000) }).parse(await req.json());
  return NextResponse.json(await pasteParts(text, { allowPricing: canDo(user, "change_prices") }));
});

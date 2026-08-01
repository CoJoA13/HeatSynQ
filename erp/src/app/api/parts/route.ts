import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { listParts, createPart } from "@/server/parts";
import { PRICING_FIELDS } from "@/lib/part-constants";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "parts", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listParts({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  }));
});

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "parts", "create");
  const body = (await req.json()) as Record<string, unknown>;
  // Presence, not truthiness: setting a price to null is still a price change.
  if (PRICING_FIELDS.some((f) => f in body)) mustDo(user, "change_prices");
  return NextResponse.json(await createPart(body));
});

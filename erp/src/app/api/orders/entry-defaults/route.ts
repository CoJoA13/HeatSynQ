import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { defaultRequestDate } from "@/server/orders";
import { orUndefined } from "../query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "orders", "view");
  const url = new URL(req.url);
  // "" (present-but-blank, e.g. `?customerId=&partId=`) is absent, same as a missing param
  // altogether — `defaultRequestDate` reports a missing customerId as its own field-anchored 400
  // either way, and an absent partId is the documented "no part chosen yet" case, not an error.
  const customerId = orUndefined(url.searchParams.get("customerId")) ?? "";
  const partId = orUndefined(url.searchParams.get("partId"));
  const requestDate = await defaultRequestDate(customerId, partId);
  return NextResponse.json({ requestDate });
});

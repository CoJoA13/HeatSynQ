import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { defaultRequestDate } from "@/server/orders";
import { orUndefined } from "../query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "orders", "view");
  const url = new URL(req.url);
  // "" (present-but-blank, e.g. `?customerId=&partId=&receivedDate=`) is absent, same as a
  // missing param altogether — `defaultRequestDate` reports a missing customerId as its own
  // field-anchored 400 either way, an absent partId is the documented "no part chosen yet" case,
  // and an absent receivedDate is "not backdated yet" — neither is an error.
  const customerId = orUndefined(url.searchParams.get("customerId")) ?? "";
  const partId = orUndefined(url.searchParams.get("partId"));
  // Fix-wave finding 1: lets the entry page's untouched preview compute from the SAME base date
  // (received date, possibly overridden) that createOrder itself uses at save time, instead of
  // always today.
  const receivedDate = orUndefined(url.searchParams.get("receivedDate"));
  const requestDate = await defaultRequestDate(customerId, partId, receivedDate);
  return NextResponse.json({ requestDate });
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createQuote, listQuotes, quoteWorklist } from "@/server/quotes";
import { parseQuoteFilter } from "./query";

// `worklist=1` returns the two §5.4 sections with counts; anything else is the filtered list.
// One route, one permission — the worklist is a projection of the same rows the list shows.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "quotes", "view");
  const url = new URL(req.url);
  if (url.searchParams.get("worklist") === "1") {
    return NextResponse.json(await quoteWorklist());
  }
  return NextResponse.json(await listQuotes(parseQuoteFilter(url)));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "quotes", "create");
  return NextResponse.json(await createQuote(await req.json()));
});

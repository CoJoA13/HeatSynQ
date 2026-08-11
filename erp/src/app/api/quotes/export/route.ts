import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { exportQuotes } from "@/server/quotes";
import { parseQuoteFilter } from "../query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "quotes", "view");
  const buf = await exportQuotes(parseQuoteFilter(new URL(req.url)));
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Quotes.xlsx"',
    },
  });
});

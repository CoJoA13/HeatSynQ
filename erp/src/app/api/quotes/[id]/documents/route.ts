import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocumentsForQuote } from "@/server/documents";

/**
 * Every `QUOTE` document filed against this quote — metadata only, never the bytes (Phase 6 spec
 * §6's print history on the quote page). No cross-kind union to filter, the way
 * `GET /api/orders/[id]/documents` needs one: the only kind `listDocumentsForQuote` can ever
 * return sits behind the SAME `quotes` area this route itself gates on (`AREA_FOR_KIND.QUOTE`),
 * so nothing here can leak a kind the caller couldn't already see by holding `quotes.view` in
 * the first place. Mirrors `GET /api/invoices/[id]/documents` / `GET /api/certs/[id]/documents`
 * exactly.
 *
 * The PATH is a Task 8 contract: `QuoteDetail.tsx`'s Documents section was wired to exactly
 * `GET /api/quotes/[id]/documents` one task ahead of this route (the invoices Task 18→19
 * precedent), rendering the 404 as its empty state until this file landed.
 */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "quotes", "view");
  return NextResponse.json(await listDocumentsForQuote((await params).id));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import {
  customerPartBlockers, customerOrderBlockers, customerQuoteBlockers, customerPaymentBlockers,
} from "@/server/customers";

// Task 15: the panel this route feeds must show BOTH of deleteCustomer's live-row guards, not
// just whichever one happened to throw first (the parts guard fires before the orders guard —
// customers.ts) — a refusal is not discoverable if half of what's blocking it is left out.
// Task 7 (Phase 6) adds the third category: live quotes join the union the same way, and #84 the
// fourth: live payments, whose absence from deleteCustomer's guards stranded the cash outright.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  const { id } = await params;
  const [parts, orders, quotes, payments] = await Promise.all([
    customerPartBlockers(id), customerOrderBlockers(id), customerQuoteBlockers(id),
    customerPaymentBlockers(id)]);
  return NextResponse.json([...parts, ...orders, ...quotes, ...payments]);
});

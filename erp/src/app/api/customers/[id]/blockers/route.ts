import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { can, mustCan } from "@/server/permissions";
import {
  customerPartBlockers, customerOrderBlockers, customerQuoteBlockers, customerPaymentBlockers,
} from "@/server/customers";

// Task 15: the panel this route feeds must show BOTH of deleteCustomer's live-row guards, not
// just whichever one happened to throw first (the parts guard fires before the orders guard —
// customers.ts) — a refusal is not discoverable if half of what's blocking it is left out.
// Task 7 (Phase 6) adds the third category: live quotes join the union the same way, and #84 the
// fourth: live payments, whose absence from deleteCustomer's guards stranded the cash outright.
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "customers", "view");
  const { id } = await params;
  // This route is gated on `customers.view`, so the payment blockers' AMOUNTS are withheld unless
  // the caller also holds `receivables.view` — the figures themselves are A/R data and every
  // dedicated receivables read requires that grant (Codex, PR #129). The blocker rows are still
  // returned either way: §5.14's promise is owed to whoever holds `customers.delete`, whatever
  // their A/R grants, and an empty list under a "1 live payment(s)" refusal is the exact dead end
  // this panel exists to prevent.
  const includeAmounts = can(user, "receivables", "view");
  const [parts, orders, quotes, payments] = await Promise.all([
    customerPartBlockers(id), customerOrderBlockers(id), customerQuoteBlockers(id),
    customerPaymentBlockers(id, { includeAmounts })]);
  return NextResponse.json([...parts, ...orders, ...quotes, ...payments]);
});

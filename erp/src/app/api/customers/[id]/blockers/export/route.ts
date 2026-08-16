import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { can, mustCan } from "@/server/permissions";
import {
  customerPartBlockers, customerOrderBlockers, customerQuoteBlockers, customerPaymentBlockers,
} from "@/server/customers";
import { toXlsx } from "@/server/excel";

// Same union as the sibling blockers route (Task 15 parts+orders, Task 7 quotes, #84 payments): the
// workbook must carry every category of blocker, whichever guard actually threw.
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
  const blockers = [...parts, ...orders, ...quotes, ...payments];
  const buf = await toXlsx("Blockers",
    [{ key: "entityLabel", header: "Type" }, { key: "name", header: "Name" }, { key: "href", header: "Link" }],
    blockers as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Blockers.xlsx"',
    },
  });
});

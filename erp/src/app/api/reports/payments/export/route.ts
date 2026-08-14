import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportPayments, PAYMENTS_BASIS } from "@/server/reports/payments";
import { toXlsx } from "@/server/excel";
import { parsePaymentsFilter } from "../query";

// GET /api/reports/payments/export — the `reports/sales/export` template: `mustCan`, the SAME filter
// parse the list route uses (`parsePaymentsFilter`, so the table and its Excel file can never
// disagree about a query string), `reportPayments`, then `toXlsx`. Columns are inlined here (the
// house default — no shared column map) and switch on the resolved groupBy so the sheet mirrors
// exactly what the screen renders. The basis ("Posted payments only") is stamped into the sheet via
// toXlsx's caption, so an operator opening the file can never mistake un-posted cash for missing
// money.

const GROUP_HEADER: Record<"customer" | "month" | "type", string> = {
  customer: "Customer", month: "Received Month", type: "Payment Type",
};

const DETAIL_COLUMNS = [
  { key: "reference", header: "Reference" },
  { key: "receivedDate", header: "Received" },
  { key: "customerCode", header: "Customer Code" },
  { key: "customerName", header: "Customer Name" },
  { key: "paymentTypeName", header: "Payment Type" },
  { key: "amount", header: "Amount" },
];

export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  const result = await reportPayments(parsePaymentsFilter(new URL(req.url)));

  const columns = result.groupBy === "none"
    ? DETAIL_COLUMNS
    : [
        { key: "label", header: GROUP_HEADER[result.groupBy] },
        { key: "paymentCount", header: "Payments" },
        { key: "amount", header: "Amount" },
      ];

  const buf = await toXlsx("Payments", columns, result.rows as unknown as Record<string, unknown>[], PAYMENTS_BASIS);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Payments.xlsx"',
    },
  });
});

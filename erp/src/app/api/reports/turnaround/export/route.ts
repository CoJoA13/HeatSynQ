import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportTurnaround } from "@/server/reports/turnaround";
import { toXlsx } from "@/server/excel";
import { parseTurnaroundFilter } from "../query";

// GET /api/reports/turnaround/export — the `reports/shipped/export` template: `mustCan`, the SAME
// filter parse the list route uses (`parseTurnaroundFilter`, so the table and its Excel file can
// never disagree about a query string), `reportTurnaround`, then `toXlsx`. Columns are inlined here
// (the house default — no shared column map) and switch on the resolved groupBy so the sheet mirrors
// exactly what the screen renders for that slice.

const GROUP_HEADER: Record<"customer" | "part" | "month", string> = {
  customer: "Customer", part: "Part", month: "Completion Month",
};

const DETAIL_COLUMNS = [
  { key: "orderNumber", header: "Order" },
  { key: "customerCode", header: "Customer Code" },
  { key: "customerName", header: "Customer Name" },
  { key: "receivedDate", header: "Received Date" },
  { key: "completionDate", header: "Completion Date" },
  { key: "turnaroundDays", header: "Turnaround Days" },
];

export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  const result = await reportTurnaround(parseTurnaroundFilter(new URL(req.url)));

  const columns = result.groupBy === "none"
    ? DETAIL_COLUMNS
    : [
        { key: "label", header: GROUP_HEADER[result.groupBy] },
        { key: "orderCount", header: "Orders" },
        { key: "avgDays", header: "Avg Days" },
        { key: "minDays", header: "Min Days" },
        { key: "maxDays", header: "Max Days" },
      ];

  const buf = await toXlsx("Turnaround", columns, result.rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Turnaround.xlsx"',
    },
  });
});

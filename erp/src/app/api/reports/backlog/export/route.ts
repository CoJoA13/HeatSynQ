import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportBacklog } from "@/server/reports/backlog";
import { toXlsx } from "@/server/excel";
import { parseBacklogFilter } from "../query";

// GET /api/reports/backlog/export — the `receivables/aging/export` template: `mustCan`, the SAME
// filter parse the list route uses (`parseBacklogFilter`, so the table and its Excel file can never
// disagree about a query string), `reportBacklog`, then `toXlsx`. Columns are inlined here (the
// house default — no shared column map on the first report) and switch on the resolved groupBy so
// the sheet mirrors exactly what the screen renders for that slice.

const GROUP_HEADER: Record<"customer" | "part" | "month", string> = {
  customer: "Customer", part: "Part", month: "Received Month",
};

const DETAIL_COLUMNS = [
  { key: "orderNumber", header: "Order" },
  { key: "customerCode", header: "Customer Code" },
  { key: "customerName", header: "Customer Name" },
  { key: "partNumber", header: "Part Number" },
  { key: "partName", header: "Part Name" },
  { key: "qty", header: "Qty Ordered" },
  { key: "weight", header: "Weight Ordered" },
  { key: "receivedDate", header: "Received Date" },
  { key: "daysOpen", header: "Days Open" },
];

export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  const result = await reportBacklog(parseBacklogFilter(new URL(req.url)));

  const columns = result.groupBy === "none"
    ? DETAIL_COLUMNS
    : [
        { key: "label", header: GROUP_HEADER[result.groupBy] },
        { key: "orderCount", header: "Orders" },
        { key: "lineCount", header: "Lines" },
        { key: "qty", header: "Qty Ordered" },
        { key: "weight", header: "Weight Ordered" },
      ];

  const buf = await toXlsx("Backlog", columns, result.rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Backlog.xlsx"',
    },
  });
});

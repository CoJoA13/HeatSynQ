import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportShipped } from "@/server/reports/shipped";
import { toXlsx } from "@/server/excel";
import { parseShippedFilter } from "../query";

// GET /api/reports/shipped/export — the `reports/backlog/export` template: `mustCan`, the SAME
// filter parse the list route uses (`parseShippedFilter`, so the table and its Excel file can never
// disagree about a query string), `reportShipped`, then `toXlsx`. Columns are inlined here (the
// house default — no shared column map) and switch on the resolved groupBy so the sheet mirrors
// exactly what the screen renders for that slice.

const GROUP_HEADER: Record<"customer" | "part" | "month" | "day", string> = {
  customer: "Customer", part: "Part", month: "Ship Month", day: "Ship Date",
};

const DETAIL_COLUMNS = [
  { key: "shipperNumber", header: "Shipper" },
  { key: "shipDate", header: "Ship Date" },
  { key: "customerCode", header: "Customer Code" },
  { key: "customerName", header: "Customer Name" },
  { key: "partNumber", header: "Part Number" },
  { key: "partName", header: "Part Name" },
  { key: "qty", header: "Qty Shipped" },
  { key: "weight", header: "Weight Shipped" },
];

export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  const result = await reportShipped(parseShippedFilter(new URL(req.url)));

  const columns = result.groupBy === "none"
    ? DETAIL_COLUMNS
    : [
        { key: "label", header: GROUP_HEADER[result.groupBy] },
        { key: "shipmentCount", header: "Shipments" },
        { key: "qty", header: "Qty Shipped" },
        { key: "weight", header: "Weight Shipped" },
      ];

  const buf = await toXlsx("Shipped", columns, result.rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Shipped.xlsx"',
    },
  });
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportSales } from "@/server/reports/sales";
import { toXlsx } from "@/server/excel";
import { parseSalesFilter } from "../query";

// GET /api/reports/sales/export — the `reports/backlog/export` template: `mustCan`, the SAME filter
// parse the list route uses (`parseSalesFilter`, so the table and its Excel file can never disagree
// about a query string), `reportSales`, then `toXlsx`. Columns are inlined here (the house default —
// no shared column map) and switch on the resolved groupBy so the sheet mirrors exactly what the
// screen renders for that slice.

const GROUP_HEADER: Record<"customer" | "part" | "month", string> = {
  customer: "Customer", part: "Part", month: "Finalized Month",
};

const DETAIL_COLUMNS = [
  { key: "documentNumber", header: "Document" },
  { key: "kind", header: "Type" },
  { key: "customerCode", header: "Customer Code" },
  { key: "customerName", header: "Customer Name" },
  { key: "finalizedDate", header: "Finalized" },
  { key: "revenue", header: "Revenue (ex-tax)" },
];

export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  const result = await reportSales(parseSalesFilter(new URL(req.url)));

  const columns = result.groupBy === "none"
    ? DETAIL_COLUMNS
    : [
        { key: "label", header: GROUP_HEADER[result.groupBy] },
        { key: "invoiceCount", header: "Invoices" },
        { key: "revenue", header: "Revenue (ex-tax)" },
      ];

  const buf = await toXlsx("Sales", columns, result.rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Sales.xlsx"',
    },
  });
});

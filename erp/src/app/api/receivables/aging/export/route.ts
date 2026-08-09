import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { agingReport } from "@/server/aging";
import { toXlsx } from "@/server/excel";
import { parseAgingFilter } from "../query";

// GET /api/receivables/aging/export — the `parts/export`/`invoices/export` precedent: `mustCan`,
// the SAME filter parse the aging list route uses (`parseAgingFilter` — so the list and its export
// can never disagree about what a query string means), `agingReport`, then `toXlsx`.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const rows = await agingReport(parseAgingFilter(new URL(req.url)));
  const columns = [
    { key: "customerCode", header: "Customer Code" },
    { key: "customerName", header: "Customer Name" },
    { key: "current", header: "Current" },
    { key: "d1_30", header: "1-30" },
    { key: "d31_60", header: "31-60" },
    { key: "d61_90", header: "61-90" },
    { key: "d90_plus", header: "90+" },
    { key: "unapplied", header: "Unapplied" },
    { key: "net", header: "Net" },
  ];
  const buf = await toXlsx("Aging", columns, rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Aging.xlsx"',
    },
  });
});

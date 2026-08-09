import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { agingReport } from "@/server/aging";
import { toXlsx } from "@/server/excel";
import { AGING_BUCKET_LABELS, isAgingRowAllZero } from "@/lib/ar-constants";
import { parseAgingFilter } from "../query";

// GET /api/receivables/aging/export — the `parts/export`/`invoices/export` precedent: `mustCan`,
// the SAME filter parse the aging list route uses (`parseAgingFilter` — so the list and its export
// can never disagree about what a query string means), `agingReport`, then `toXlsx`. Bucket
// headers reuse `AGING_BUCKET_LABELS` (the en-dash "1–30"/"31–60"/"61–90" labels) so the Excel
// output matches what the aging screen renders on screen, rather than a second, hand-typed copy.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  // Match the SCREEN's body: drop all-zero rows with the same predicate (AgingReport.tsx) AND the
  // synthesized family-total row. `agingReport`'s family roll-up returns per-child rows PLUS a
  // family-total row that already sums parent + children — exporting it as a flat data row alongside
  // the child rows double-counts the moment a user sums the column. The screen renders it as a
  // distinct footer, never a body row; the export is leaf rows only, whose column sums to the family
  // total (`agingReport` itself is untouched — the exclusion is display-side, here and on screen).
  const rows = (await agingReport(parseAgingFilter(new URL(req.url))))
    .filter((r) => !r.isFamilyTotal && !isAgingRowAllZero(r));
  const columns = [
    { key: "customerCode", header: "Customer Code" },
    { key: "customerName", header: "Customer Name" },
    { key: "current", header: AGING_BUCKET_LABELS.CURRENT },
    { key: "d1_30", header: AGING_BUCKET_LABELS.D1_30 },
    { key: "d31_60", header: AGING_BUCKET_LABELS.D31_60 },
    { key: "d61_90", header: AGING_BUCKET_LABELS.D61_90 },
    { key: "d90_plus", header: AGING_BUCKET_LABELS.D90_PLUS },
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

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readinessForExport } from "@/server/gl-export";
import { toXlsx } from "@/server/excel";
import { parseReadinessPeriod } from "../period";

// GET /api/receivables/close/readiness/export?year=&month= — the readiness gap list as an .xlsx
// (the `aging/export` precedent). A read, gated on `receivables.view`. Same period parse as the JSON
// readiness route, so the on-screen panel and its Excel export can never disagree.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const periodEnd = parseReadinessPeriod(new URL(req.url));
  const gaps = await readinessForExport(periodEnd);
  const columns = [
    { key: "label", header: "Gap" },
    { key: "href", header: "Fix at" },
  ];
  const buf = await toXlsx("Readiness", columns, gaps as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Readiness.xlsx"',
    },
  });
});

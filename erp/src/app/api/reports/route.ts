import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, can } from "@/server/permissions";
import { REPORTS } from "@/lib/report-registry";

// GET /api/reports — the report index (Phase 8A Task 0, spec §4). The `reports` area goes live here.
// A read, so the only gate is `reports.view` (no create/edit/delete). Returns the report entries the
// actor may open: each is additionally filtered by ITS OWN area's view grant, so Task 6's homed
// cross-area entries (invoice register / A/R aging) gate on invoicing.view / receivables.view even
// though reaching the index at all needs reports.view. The client index page (src/app/reports)
// renders this list; the list itself is the client-safe registry in src/lib/report-registry.ts.
export const GET = handle(async () => {
  const user = requireUser();
  mustCan(user, "reports", "view");
  return NextResponse.json(REPORTS.filter((r) => can(user, r.area, "view")));
});

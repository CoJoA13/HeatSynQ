import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { findBlockers } from "@/server/reference-blockers";

// Mirrors src/app/api/admin/step-codes/[id]/blockers/route.ts, with one addition: `includeLabel`
// (fix wave 1, Fix 3 review). This route's one client, admin/surcharges/page.tsx, pairs a
// blocker's `label` with its `entityLabel` to find the customerSurcharge -> surcharge override
// rows sturdily — `entityLabel === "Customer"` alone is correct only by coincidence today (see
// that page's own comment on the filter). Every OTHER `findBlockers` caller leaves this off.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { id } = await params;
  return NextResponse.json(await findBlockers("surcharge", id, undefined, { includeLabel: true }));
});

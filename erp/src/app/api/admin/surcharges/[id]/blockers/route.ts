import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { findBlockers } from "@/server/reference-blockers";

// Mirrors src/app/api/admin/step-codes/[id]/blockers/route.ts, with one addition: `includeModel`
// (fix wave 1, Fix 3 review; renamed from `includeLabel` in fix wave 2 — see
// reference-blockers.ts's Blocker-type comment for why). This route's one client,
// admin/surcharges/page.tsx, filters a blocker's `model` — the registry entry's own Prisma model
// identity — to find the customerSurcharge -> surcharge override rows: `model ===
// "customerSurcharge"` is true only for that one link, unlike `entityLabel`/`label`, either alone
// or paired (see that page's own comment on the filter). Every OTHER `findBlockers` caller leaves
// this off.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { id } = await params;
  return NextResponse.json(await findBlockers("surcharge", id, undefined, { includeModel: true }));
});

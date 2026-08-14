import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { resolveAssignmentsForCustomer } from "@/server/template-assignments";

// The customer-page picker's DISPLAY resolution (spec §5.2, §5.15): per docType, whether this
// customer's paper resolves to its OWN assignment, a nearest ancestor's (INHERITED), or the type's
// DEFAULT — never blank. Gated on `customers.view` like the plain assignment-list GET beside it
// (the page already requires customers.view to load); the template NAMES the picker's dropdown
// needs are the separate `requireUser`-only /api/templates/names read, so a customers.edit user
// without templates.view still sees this state and those names (the §5.15 no-silent-empty rule).
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await resolveAssignmentsForCustomer((await params).id));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listSurcharges, createSurcharge } from "@/server/surcharges";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "admin", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listSurcharges({ includeInactive }));
});

// Gated on admin.edit, not admin.create — surcharges carry no separate create/delete grant
// (task-7 brief): the whole CRUD surface for this admin screen turns on view/edit alone, the
// same shape as /api/admin/billing.
export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  return NextResponse.json(await createSurcharge(await req.json()));
});

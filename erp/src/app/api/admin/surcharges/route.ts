import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listSurcharges, createSurcharge } from "@/server/surcharges";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "admin", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listSurcharges({ includeInactive }));
});

// admin.create, matching every other admin CRUD list (step-codes, part-fields,
// reference/[kind]) — an owner ruling (review Fix 2, fix wave 1) that supersedes the brief's
// original single admin.edit gate for POST/PUT/DELETE. PUT stays admin.edit; see [id]/route.ts
// for the DELETE -> admin.delete split.
export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "create");
  return NextResponse.json(await createSurcharge(await req.json()));
});

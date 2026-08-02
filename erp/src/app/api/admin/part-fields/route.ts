import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listPartFieldDefs, createPartFieldDef } from "@/server/part-field-defs";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "admin", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listPartFieldDefs({ includeInactive }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "create");
  return NextResponse.json(await createPartFieldDef(await req.json()));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listReference, createReference } from "@/server/reference";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { kind } = await params;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listReference(kind, { includeInactive }));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "create");
  const { kind } = await params;
  return NextResponse.json(await createReference(kind, await req.json()));
});

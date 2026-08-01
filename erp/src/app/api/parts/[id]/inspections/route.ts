import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listPartInspections, addPartInspection } from "@/server/part-inspections";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await listPartInspections((await params).id));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  return NextResponse.json(await addPartInspection((await params).id, await req.json()));
});

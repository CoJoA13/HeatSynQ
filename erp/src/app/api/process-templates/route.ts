import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listTemplates, createTemplate } from "@/server/process-templates";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "processes", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listTemplates({
    includeInactive: url.searchParams.get("includeInactive") === "1",
  }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "processes", "create");
  return NextResponse.json(await createTemplate(await req.json()));
});

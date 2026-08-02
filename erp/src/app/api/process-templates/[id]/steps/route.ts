import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { addTemplateStep } from "@/server/process-templates";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  return NextResponse.json(await addTemplateStep((await params).id, await req.json()));
});

import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { loadTemplate } from "@/server/part-process-steps";

const LOAD_TEMPLATE = z.object({ templateId: z.string().min(1) }).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  const { templateId } = LOAD_TEMPLATE.parse(await req.json());
  return NextResponse.json(await loadTemplate((await params).id, templateId));
});

import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reorderTemplateSteps } from "@/server/process-templates";

const REORDER = z.object({ orderedStepIds: z.array(z.string().min(1)).min(1) }).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  const { orderedStepIds } = REORDER.parse(await req.json());
  await reorderTemplateSteps((await params).id, orderedStepIds);
  return NextResponse.json({ ok: true });
});

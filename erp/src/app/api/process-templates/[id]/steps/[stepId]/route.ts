import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateTemplateStep, removeTemplateStep } from "@/server/process-templates";

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  const { id, stepId } = await params;
  await updateTemplateStep(id, stepId, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  const { id, stepId } = await params;
  await removeTemplateStep(id, stepId);
  return NextResponse.json({ ok: true });
});

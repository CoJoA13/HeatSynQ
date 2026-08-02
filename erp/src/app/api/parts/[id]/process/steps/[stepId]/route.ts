import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateStep, removeStep } from "@/server/part-process-steps";

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  const { id, stepId } = await params;
  return NextResponse.json(await updateStep(id, stepId, await req.json()));
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  const { id, stepId } = await params;
  return NextResponse.json(await removeStep(id, stepId));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateStepCode, deleteStepCode, setStepFields } from "@/server/process-step-codes";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { id } = await params;
  const body = await req.json();
  // `fields` is replaced wholesale and travels separately from the scalar columns.
  if (Array.isArray(body.fields)) {
    await setStepFields(id, body.fields);
    delete body.fields;
  }
  if (Object.keys(body).length) await updateStepCode(id, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  await deleteStepCode((await params).id);
  return NextResponse.json({ ok: true });
});

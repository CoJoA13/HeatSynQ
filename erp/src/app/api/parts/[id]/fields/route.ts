import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listPartFieldValues, setPartFieldValues } from "@/server/part-field-values";

const VALUES_BODY = z.object({
  values: z.array(z.object({ fieldId: z.string(), value: z.string() })),
}).strict();

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await listPartFieldValues((await params).id));
});

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { values } = VALUES_BODY.parse(await req.json());
  await setPartFieldValues((await params).id, values);
  return NextResponse.json({ ok: true });
});

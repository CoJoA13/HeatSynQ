import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { setSurchargeStepCodes } from "@/server/surcharges";

// Replace-grid PUT: `stepCodeIds` is the WHOLE intended list, not a delta — matches
// `setSurchargeStepCodes`'s own contract (surcharges.ts). No manual shape check on the array
// beyond `assertRecord`: the service's own zod parse turns a missing/malformed value into the
// same field-anchored 400 a route-side check would produce.
export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { id } = await params;
  const body = await req.json();
  assertRecord(body);
  await setSurchargeStepCodes(id, body.stepCodeIds as string[]);
  return NextResponse.json({ ok: true });
});

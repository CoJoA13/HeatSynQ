import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { deleteStepCode, updateStepCodeWithFields } from "@/server/process-step-codes";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { id } = await params;
  const body = await req.json();
  const { fields, ...scalars } = body ?? {};
  // A present-but-malformed `fields` is rejected rather than ignored. It is destructured out of
  // `scalars` whatever its type, and `hasFields` below only asks whether it is an array — so
  // `{ name: "X", fields: null }` used to apply the name, drop the field payload, and answer 200,
  // which is precisely the half-apply the atomic contract below forbids, with nothing to tell the
  // caller its field changes never happened (Codex, PR #22). JSON carries no `undefined` values,
  // so `!== undefined` is exactly "the key was present" — omitting `fields` stays a legal
  // scalars-only PUT.
  if (fields !== undefined && !Array.isArray(fields)) {
    throw new HttpError(400, "fields must be an array");
  }
  const hasFields = Array.isArray(fields);
  // An empty body changes nothing — report that as an error rather than a no-op 200.
  if (!hasFields && Object.keys(scalars).length === 0) {
    throw new HttpError(400, "PUT body must include at least one change");
  }
  // Scalar columns and `fields` are applied together, atomically, as one audit row — see
  // updateStepCodeWithFields for why a single PUT must not be able to half-apply.
  await updateStepCodeWithFields(id, { ...scalars, ...(hasFields ? { fields } : {}) });
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  await deleteStepCode((await params).id);
  return NextResponse.json({ ok: true });
});

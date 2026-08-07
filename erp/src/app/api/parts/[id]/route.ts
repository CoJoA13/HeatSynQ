import { NextResponse } from "next/server";
import { handle, requireUser, HttpError, assertRecord, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getPart, updatePart, deletePart } from "@/server/parts";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await getPart((await params).id));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // An empty body changes nothing — report that as an error rather than a no-op 200
  // (step-codes/[id]/route.ts precedent).
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "PUT body must include at least one change");
  }
  await updatePart((await params).id, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "delete");
  // A DELETE carrying a body — the reason spec §9 requires for a destructive action. A request
  // with no body at all, or a body that isn't a JSON object (e.g. `null`), is deliberately not a
  // parse error: the service reports the missing reason as a field-anchored 400 rather than this
  // route failing on malformed JSON. Mirrors deleteCustomer's route
  // (src/app/api/customers/[id]/route.ts).
  const body: unknown = await req.json().catch(() => null);
  await deletePart((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});

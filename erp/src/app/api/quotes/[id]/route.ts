import { NextResponse } from "next/server";
import { handle, requireUser, HttpError, assertRecord, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getQuote, updateQuote, deleteQuote } from "@/server/quotes";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "quotes", "view");
  return NextResponse.json(await getQuote((await params).id));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "quotes", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // An empty body changes nothing — report that as an error rather than a no-op 200
  // (the orders/[id] precedent).
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "PATCH body must include at least one change");
  }
  return NextResponse.json(await updateQuote((await params).id, body));
});

export const DELETE = handle(async (req, { params }) => {
  // Plain CRUD delete permission (spec §7) — unlike voidOrder there is no special action here.
  mustCan(requireUser(), "quotes", "delete");
  // A DELETE carrying the §5.17 reason. A missing/non-JSON body is deliberately not a parse
  // error: the service reports the missing reason as its field-anchored 400 (the voidOrder
  // route's shape).
  const body: unknown = await req.json().catch(() => null);
  await deleteQuote((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});

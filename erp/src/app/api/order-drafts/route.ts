import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord, HttpError } from "@/server/http";
import { getDraft, putDraft, clearDraft } from "@/server/order-drafts";

// Session-only, deliberately: every read/write below is scoped to `user.id` — the caller's OWN
// row, taken from the session, never a client-supplied id — which is the whole authorization
// (order-drafts.ts's own header comment: "readable/writable only by its own user"). There is no
// mustCan/mustDo call on this route by design; permissions-sweep.test.ts's "every API route
// calls requireUser" check is satisfied by binding the call to `user` below rather than
// discarding it.

export const GET = handle(async () => {
  const user = requireUser();
  return NextResponse.json(await getDraft(user.id));
});

export const PUT = handle(async (req) => {
  const user = requireUser();
  const body: unknown = await req.json();
  assertRecord(body);
  // `{ payload: <opaque json> }` — an envelope, not the payload itself. The `payload` key must
  // be PRESENT, even when its value is `null`: a client that does `JSON.stringify({ payload:
  // undefined })` gets a body with the key silently dropped, and treating that the same as an
  // explicit "store null" would wipe an existing draft under a 200 — exactly the crash-or-
  // closed-tab loss spec §12 promises never happens. An explicit `{ payload: null }` still means
  // "store null" (a deliberate clear has its own endpoint: DELETE).
  if (!("payload" in body)) throw new HttpError(400, "payload is required");
  await putDraft(user.id, body.payload);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async () => {
  const user = requireUser();
  await clearDraft(user.id);
  return NextResponse.json({ ok: true });
});

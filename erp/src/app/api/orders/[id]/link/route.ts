import { NextResponse } from "next/server";
import { handle, requireUser, HttpError, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { linkOrder } from "@/server/orders";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // `linkOrder` takes `otherId` as a plain string argument (it has no zod schema of its own to
  // report this), so the route is where a missing/malformed one becomes a field-anchored 400
  // instead of an HttpError-less TypeError escaping handle()'s mapping as an unhandled 500.
  const { otherId } = body;
  if (typeof otherId !== "string" || otherId.length === 0) {
    throw new HttpError(400, "otherId is required");
  }
  return NextResponse.json(await linkOrder((await params).id, otherId));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, canDo } from "@/server/permissions";
import { createShipper, listShippers } from "@/server/shippers";
import { parseShipperFilter } from "./query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "shipping", "view");
  return NextResponse.json(await listShippers(parseShipperFilter(new URL(req.url))));
});

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "shipping", "create");
  // `canOverrideCreditHold` is passed EVERY TIME, true or false — the service (spec §5.4) is what
  // decides whether the customer is even on hold, and only then whether this flag matters. A
  // session lacking `override_credit_hold` still gets refused on a held customer even when its
  // request body supplies a reason (task-11-brief.md's own gate callout).
  const result = await createShipper(await req.json(), { canOverrideCreditHold: canDo(user, "override_credit_hold") });
  return NextResponse.json(result);
});

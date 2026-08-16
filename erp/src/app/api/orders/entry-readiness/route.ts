import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { orderEntryReadiness } from "@/server/order-entry-readiness";

// The order-entry screen fetches this to decide whether to show the form or the blocking notice
// (Phase 8B §5.6). It reports the SAME predicate the createOrder gate enforces (order-entry-
// readiness.ts), so the UI and the server-side gate can never disagree. A pure read.
export const GET = handle(async () => {
  mustCan(requireUser(), "orders", "create");
  return NextResponse.json(await orderEntryReadiness());
});

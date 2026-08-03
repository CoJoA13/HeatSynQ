import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { customerPartBlockers, customerOrderBlockers } from "@/server/customers";

// Task 15: the panel this route feeds must show BOTH of deleteCustomer's live-row guards, not
// just whichever one happened to throw first (the parts guard fires before the orders guard —
// customers.ts) — a refusal is not discoverable if half of what's blocking it is left out.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  const { id } = await params;
  const [parts, orders] = await Promise.all([customerPartBlockers(id), customerOrderBlockers(id)]);
  return NextResponse.json([...parts, ...orders]);
});

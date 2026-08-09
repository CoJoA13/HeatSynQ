import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { customerReceivablesSummary } from "@/server/customer-receivables";

// GET /api/customers/[id]/receivables — the customer page's A/R section (design spec §11, Task
// 15): net balance + aging buckets + open items. Gated `receivables.view`, not `customers.view` —
// this is A/R data, not customer master data, the `aging`/`applications` GET routes' own gate.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "receivables", "view");
  return NextResponse.json(await customerReceivablesSummary((await params).id));
});

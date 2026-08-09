import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { addPayment } from "@/server/receipts";

// POST /api/receivables/batches/[id]/payments — records one check/card/ACH against the batch;
// refuses once the batch is POSTED (Task 6).
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "create");
  return NextResponse.json(await addPayment((await params).id, await req.json()));
});

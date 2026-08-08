import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createBatch } from "@/server/receipts";

// POST /api/receivables/batches — opens a new deposit session (Task 6, P5B §4.1).
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "create");
  return NextResponse.json(await createBatch(await req.json()));
});

import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reopenBatch } from "@/server/receipts";

// POST /api/receivables/batches/[id]/reopen — POSTED -> OPEN with a mandatory reason (issue #68,
// owner ruling 2026-08-16). Shaped on the close's own reopen route
// (`/api/receivables/close/[id]/reopen`), minus its `close_ar_period` special: reopening a batch is
// the inverse of `postBatch`, which this route's sibling PATCH gates on `receivables.edit`, so the
// two stay symmetric. The service requires the non-empty reason and records it in the audit entry.
const BODY = z.object({ reason: z.string() }).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "edit");
  const { id } = await params;
  const { reason } = BODY.parse(await req.json());
  return NextResponse.json(await reopenBatch(id, reason));
});

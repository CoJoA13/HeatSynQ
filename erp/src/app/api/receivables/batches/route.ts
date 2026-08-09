import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createBatch, listBatches } from "@/server/receipts";
import { RECEIPT_BATCH_STATUSES, type ReceiptBatchStatusValue } from "@/lib/ar-constants";

const STATUS_VALUES = new Set<string>(RECEIPT_BATCH_STATUSES);

// GET /api/receivables/batches?status= — the worklist (Task 13; not part of Task 6's original
// surface — see the `listBatches` comment in receipts.ts). An absent/blank `status` lists every
// live batch; an unrecognized one is a field-anchored 400 rather than a Prisma validation error
// on a value its `status` column has never heard of (the `invoices/query.ts` `parseStatus`
// precedent — duplicated here rather than factored out, the `shippers/query.ts` "not worth the
// cross-tree coupling for a few lines" precedent, since this filter has only the one field).
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status && !STATUS_VALUES.has(status)) throw new HttpError(400, `Unknown receipt batch status "${status}"`);
  return NextResponse.json(await listBatches(status ? { status: status as ReceiptBatchStatusValue } : {}));
});

// POST /api/receivables/batches — opens a new deposit session (Task 6, P5B §4.1).
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "create");
  return NextResponse.json(await createBatch(await req.json()));
});

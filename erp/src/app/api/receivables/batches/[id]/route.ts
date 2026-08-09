import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getBatch, postBatch, voidBatch } from "@/server/receipts";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "receivables", "view");
  return NextResponse.json(await getBatch((await params).id));
});

// PATCH posts the batch (OPEN -> POSTED, Task 6) — the only mutation a batch's own header
// supports; there is no other draft-edit for a ReceiptBatch.
export const PATCH = handle(async (_req, { params }) => {
  mustCan(requireUser(), "receivables", "edit");
  return NextResponse.json(await postBatch((await params).id));
});

// Void a batch — refuses while it still has live payments, reason required and trimmed IN THE
// SERVICE (the `discardInvoice`/`reasonFromBody` shape).
export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "delete");
  const body: unknown = await req.json().catch(() => null);
  await voidBatch((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});

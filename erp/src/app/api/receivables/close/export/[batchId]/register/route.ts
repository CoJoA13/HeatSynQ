import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getExportBatchRegister } from "@/server/gl-export";

// GET /api/receivables/close/export/[batchId]/register — stream the stored posting-register PDF
// (Task 7, spec §4.3/§4.4). A read, gated on `receivables.view`, same shape as the CSV file route
// (`.../file/route.ts`) — the bytes and content type are the batch's own frozen
// `register`/`registerContentType` (application/pdf), never re-rendered from live data. `inline`,
// not `attachment` (the file route's disposition): the register is meant to open in the browser's
// own PDF viewer alongside the export, not force a download — but it still carries its own
// `filename` (fix round 1, Task 7 review), matching every other inline-PDF route (certs, invoices,
// statements, traveler all pass `inline; filename="..."`).
export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "view");
  const { batchId } = await params;
  const { bytes, fileName, contentType } = await getExportBatchRegister(batchId);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `inline; filename="${fileName}"`,
    },
  });
});

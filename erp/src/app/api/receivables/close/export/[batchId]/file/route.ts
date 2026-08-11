import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getExportBatchFile } from "@/server/gl-export";

// GET /api/receivables/close/export/[batchId]/file — stream the stored GL-export CSV as an
// attachment (spec §4.3). A read, gated on `receivables.view`. The bytes and content type are the
// batch's own frozen `file`/`fileContentType` (text/csv) — never re-rendered from live data.
export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "view");
  const { batchId } = await params;
  const { bytes, fileName, contentType } = await getExportBatchFile(batchId);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${fileName}"`,
    },
  });
});

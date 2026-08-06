import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocumentsForCert } from "@/server/documents";

/**
 * Every `CERT` document filed against this certification — metadata only, never the bytes
 * (design spec §11's cert page: "Print; documents; History"). No cross-kind union to filter, the
 * way `GET /api/orders/[id]/documents` needs one for a `TRAVELER`/`BOL` it might not be able to
 * show a caller: the only kind `listDocumentsForCert` can ever return sits behind the SAME
 * `certs` area this route itself gates on, so nothing here can leak a kind the caller couldn't
 * already see by holding `certs.view` in the first place.
 *
 * This route did not exist before Task 16 — `documents.ts`'s own `listDocumentsForCert` (Task 3)
 * had no HTTP caller yet. Added here mirroring `GET /api/shippers/[id]/documents` (lane A's
 * Task 14, the same gap for `listDocumentsForShipper`), because the cert page's stored-documents
 * list has nothing else to call.
 */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "certs", "view");
  return NextResponse.json(await listDocumentsForCert((await params).id));
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { HttpError } from "@/server/errors";
import { printTraveler, travelerFilename } from "@/server/traveler";

/**
 * Renders, archives and streams one traveler. `?load=N` prints that load only; omitted, it
 * prints every load's sheet-set into one PDF (design spec §10).
 *
 * Gated on `orders.view`, deliberately (spec §9): printing changes nothing about the ORDER — it
 * archives its own output as an audited `StoredDocument` create, recording who printed and when.
 * It is an explicit POST rather than a read side-effect, so §12's "reads never mutate" holds.
 */
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  const { id } = await params;

  const raw = new URL(req.url).searchParams.get("load");
  let loadNumber: number | undefined;
  if (raw !== null) {
    // Anchored, not parseInt: "3abc" must be a 400, not silently load 3.
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "load must be a whole load number");
    loadNumber = Number(raw);
  }

  const printed = await printTraveler(id, loadNumber);
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${travelerFilename(printed.orderNumber, printed.loadNumber)}"`,
      // The stored row this response came from, so a caller that wants to link to the archived
      // copy does not have to re-list the order's documents to find it.
      "x-document-id": printed.documentId,
    },
  });
});

import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { HttpError } from "@/server/errors";
import { printShippingTickets } from "@/server/shippers";
import { documentFilename } from "@/server/documents";

/**
 * Renders, archives and streams the shipment's paper — `?doc=ticket` prints one shipping ticket
 * sheet per order of the shipment; `&order=<orderId>` prints just that order's (spec §10.1, the
 * traveler's per-load mechanic reused per §3.20).
 *
 * Gated on `shipping.view`, deliberately (spec §9): printing changes nothing about the SHIPMENT —
 * it archives its own output as an audited `StoredDocument` create, recording who printed and
 * when. It is an explicit POST rather than a read side-effect, so §12's "reads never mutate"
 * holds.
 *
 * Two of this route's contracted parameters land with Task 19 and are refused honestly until
 * then, never stubbed silently:
 *  - `doc=bol` — the BOL layout (and its lazy `bolNumber` allocation) does not exist yet; quietly
 *    printing a ticket instead would archive the wrong paper under a permanent identity.
 *  - `cert=1` — "also print the certification" (spec §3.14). The certification layout is Task
 *    19's; honouring the ticket half while silently dropping the cert half would tell the person
 *    at the printer their quality paperwork went out when it did not. The whole request is
 *    refused, nothing is archived, and the message says what to do.
 */
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "shipping", "view");
  const { id } = await params;

  const search = new URL(req.url).searchParams;
  const doc = search.get("doc");
  if (doc !== "ticket" && doc !== "bol") throw new HttpError(400, 'doc must be "ticket" or "bol"');
  if (doc === "bol") {
    throw new HttpError(400, "Bill of lading printing is not available yet — it lands with the BOL layout (Task 19)");
  }
  if (search.get("cert") !== null) {
    throw new HttpError(400,
      "Printing the certification alongside is not available yet — it lands with the certification layout " +
      "(Task 19). Print the ticket without it for now.");
  }
  const order = search.get("order") ?? undefined;

  const printed = await printShippingTickets(id, order);
  const filename = documentFilename(
    { id: "", createdAt: new Date(0), kind: "SHIPPER", orderId: order ?? null, shipperId: id, certId: null, loadNumber: null },
    printed.orderNumber ?? undefined, printed.shipperNumber,
  );
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      // The stored row this response came from, so a caller that wants to link the archived copy
      // does not have to re-list the shipment's documents to find it (the traveler route's rule).
      "x-document-id": printed.documentId,
    },
  });
});

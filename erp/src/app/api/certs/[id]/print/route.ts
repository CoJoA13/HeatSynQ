import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { printCert } from "@/server/certs";
import { documentFilename } from "@/server/documents";

/**
 * Renders, archives and streams the certification (spec §9's `POST /api/certs/[id]/print`,
 * §10.3). The signature that prints is THIS caller's own (§3.11) — `printCert` receives
 * `requireUser().id`, never a selected signer.
 *
 * Gated on `certs.view`, deliberately (spec §9): printing changes nothing about the cert beyond
 * the first-print `printedAt` fact and the audited archive of its own output — the same reasoning
 * the traveler and shipping-ticket prints carry, as an explicit POST so §12's "reads never
 * mutate" holds.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "certs", "view");
  const { id } = await params;

  const printed = await printCert(id, user.id);
  const filename = documentFilename(
    { id: "", createdAt: new Date(0), kind: "CERT", orderId: null, shipperId: null, certId: id, loadNumber: null },
    printed.orderNumber,
  );
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      // The stored row this response came from (the traveler route's rule).
      "x-document-id": printed.documentId,
    },
  });
});

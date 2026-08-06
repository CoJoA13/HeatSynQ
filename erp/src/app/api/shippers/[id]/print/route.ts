import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { HttpError } from "@/server/errors";
import { printShippingTickets, printBol, printableShipmentCertIds } from "@/server/shippers";
import { printCert } from "@/server/certs";
import { documentFilename } from "@/server/documents";

const pdfResponse = (pdf: Buffer, filename: string, headers: Record<string, string>) =>
  new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      ...headers,
    },
  });

/**
 * Renders, archives and streams the shipment's paper (spec §9, §5.15):
 *  - `?doc=ticket` — one shipping ticket sheet per order of the shipment; `&order=<orderId>`
 *    prints just that order's (Task 18, spec §10.1).
 *  - `?doc=bol` — the bill of lading, allocating `bolNumber` lazily on the first print (Task 19,
 *    spec §10.2/§3.19).
 *  - `&cert=1` — "also print the certification" (§3.14): each covered order's cert prints
 *    alongside the ticket(s), **each produced and stored as its own document**; the response body
 *    stays the ticket PDF and the archived certs are named in `x-cert-document-ids`. Requires
 *    `certs.view` on top of `shipping.view` — the archived paper is certs-area paper
 *    (AREA_FOR_KIND, documents.ts), and this route must not print what its caller could not open.
 *    The parse is the honest one spec §9 names (the Task 18 review's minor): `cert=1` requests
 *    it, absence or an explicit `cert=0` does not, anything else refuses naming the field.
 *
 * Gated on `shipping.view`, deliberately (spec §9): printing changes nothing about the SHIPMENT —
 * it archives its own output as an audited `StoredDocument` create, recording who printed and
 * when. It is an explicit POST rather than a read side-effect, so §12's "reads never mutate"
 * holds.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "shipping", "view");
  const { id } = await params;

  const search = new URL(req.url).searchParams;
  const doc = search.get("doc");
  if (doc !== "ticket" && doc !== "bol") throw new HttpError(400, 'doc must be "ticket" or "bol"');
  const certParam = search.get("cert");
  if (certParam !== null && certParam !== "0" && certParam !== "1") {
    throw new HttpError(400, 'cert must be "1" (also print the certifications) or "0"/omitted');
  }
  const withCerts = certParam === "1";

  if (doc === "bol") {
    // The cert checkbox rides with the tickets (§3.14's "printing a shipment offers its
    // certifications" is the ticket action; the UI offers it nowhere else) — refused rather than
    // silently ignored, the Task 18 rule.
    if (withCerts) {
      throw new HttpError(400, "Certifications print with the shipping tickets — print the BOL without cert=1");
    }
    const printed = await printBol(id);
    const filename = documentFilename(
      { id: "", createdAt: new Date(0), kind: "BOL", orderId: null, shipperId: id, certId: null, loadNumber: null },
      undefined, printed.shipperNumber,
    );
    return pdfResponse(printed.pdf, filename, { "x-document-id": printed.documentId });
  }

  const order = search.get("order") ?? undefined;

  // Resolved BEFORE the ticket prints (a voided shipment still refuses with nothing archived).
  // A cert-REQUIRING order with no cert WARNS instead of refusing (§9 amendment 2026-08-05):
  // the tickets print exactly as a cert-less print would and the warning rides the response.
  let certs: { id: string; orderNumber: number }[] = [];
  let warnings: string[] = [];
  if (withCerts) {
    mustCan(user, "certs", "view");
    ({ certs, warnings } = await printableShipmentCertIds(id, order));
  }

  const printed = await printShippingTickets(id, order);
  // Each cert is its own render, its own archive, its own document (§3.14) — printed by THIS
  // user, whose signature is what lands on the paper (§3.11). By this point the ticket is
  // committed and archived permanently, so a cert failure (a concurrently voided cert, an
  // unrenderable signature) must NOT fail the request — the UI would call a half-succeeded
  // print failed and a retry would archive a duplicate ticket. It rides the same §5.7 warning
  // channel the no-cert case does, and the remaining certs still print.
  const certDocumentIds: string[] = [];
  for (const cert of certs) {
    try {
      certDocumentIds.push((await printCert(cert.id, user.id)).documentId);
    } catch (err) {
      warnings.push(
        `Order #${cert.orderNumber}: its certification could not be printed ` +
        `(${err instanceof HttpError ? err.message : "the certification failed to render"}) — ` +
        "the tickets archived; print it from the certification screen");
    }
  }

  const filename = documentFilename(
    { id: "", createdAt: new Date(0), kind: "SHIPPER", orderId: order ?? null, shipperId: id, certId: null, loadNumber: null },
    printed.orderNumber ?? undefined, printed.shipperNumber,
  );
  return pdfResponse(printed.pdf, filename, {
    // The stored row this response came from, so a caller that wants to link the archived copy
    // does not have to re-list the shipment's documents to find it (the traveler route's rule).
    "x-document-id": printed.documentId,
    ...(certDocumentIds.length > 0 ? { "x-cert-document-ids": certDocumentIds.join(",") } : {}),
    // The response body is PDF bytes, so §5.7-style warnings cannot ride a JSON payload the way
    // every mutation's do — they travel as a URI-encoded JSON header instead (header values must
    // be ISO-8859-1-safe and the warning text carries em-dashes; encodeURIComponent makes the
    // transport lossless). The shipment page decodes and surfaces them beside the print bar.
    ...(warnings.length > 0 ? { "x-print-warnings": encodeURIComponent(JSON.stringify(warnings)) } : {}),
  });
});

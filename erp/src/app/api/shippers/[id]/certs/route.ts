import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createCert } from "@/server/certs";

/**
 * SHIPMENT-scope creation on demand (#165) — the missing third of the cert-creation surface, and
 * the reason it is a NEW route rather than a loosened old one.
 *
 * `POST /api/certs` is `.strict()` and deliberately omits `shipperId`: its docblock records that
 * `shipperId` is resolved server-side only and is NEVER read off a request body, so that route
 * "structurally cannot produce a SHIPMENT-scope cert". Relaxing it to reach SHIPMENT scope would
 * reverse a documented decision in the very file whose comment is the record of it. So this route
 * keeps the rule and satisfies it the way `POST /api/orders/[id]/certs` already does for LOAD:
 * the id that decides the scope instance comes from the PATH, `scope` is fixed here, and the
 * `.strict()` body carries only the one thing the path cannot supply — which order on this
 * shipment the certificate is for (a shipment can carry several).
 *
 * `certs.create` alone, exactly like its LOAD-scope sibling: this mints a certification, it does
 * not change the shipment. Everything else — the shipment being live, the shipment actually
 * carrying that order, and one-live-cert-per-scope-instance — is `createCert`'s own, decided
 * under the order claim (spec §4.1) and never re-decided here or in the UI.
 */
const CREATE_BODY = z.object({
  orderId: z.string().min(1),
}).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "certs", "create");
  const data = CREATE_BODY.parse(await req.json());
  const { id } = await params;
  return NextResponse.json(await createCert({ orderId: data.orderId, scope: "SHIPMENT", shipperId: id }));
});

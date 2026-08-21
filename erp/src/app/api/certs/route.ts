import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createCert, listCerts } from "@/server/certs";
import { CERT_SCOPES } from "@/lib/cert-constants";
import { parseCertFilter } from "./query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "certs", "view");
  return NextResponse.json(await listCerts(parseCertFilter(new URL(req.url))));
});

/**
 * Task 11 Step 0 (carried from Task 8's review): `shipperId` is resolved server-side only —
 * ORDER-scope at order save, SHIPMENT-scope at shipment creation (spec §6.2) — and is NEVER
 * accepted from a client here, regardless of what a request body carries. `.strict()` makes that
 * a 400 naming the extra key rather than a silent drop: a client that tries to hand this route a
 * `shipperId` finds out immediately, not by way of the cert it created mysteriously having none.
 * A SHIPMENT-scope request therefore always fails `createCert`'s own `assertScopeShape`
 * ("Shipper is required...") — this route structurally cannot produce a SHIPMENT-scope cert.
 *
 * #165 did NOT relax any of the above: SHIPMENT scope got its own route,
 * `POST /api/shippers/[id]/certs`, which resolves the shipper from its PATH the way
 * `POST /api/orders/[id]/certs` resolves the order for LOAD. Three scopes, three endpoints, and
 * `shipperId` still never read off a body. `tests/cert-routes.test.ts`'s "rejects a
 * client-supplied shipperId outright" is the pin that keeps it that way. This route's own first
 * UI caller arrived with #165 too — the order hub's Certifications scope picker.
 */
const CREATE_BODY = z.object({
  orderId: z.string().min(1),
  scope: z.enum(CERT_SCOPES),
  loadNumber: z.number().int().positive().nullable().optional(),
}).strict();

export const POST = handle(async (req) => {
  mustCan(requireUser(), "certs", "create");
  const data = CREATE_BODY.parse(await req.json());
  return NextResponse.json(await createCert({ orderId: data.orderId, scope: data.scope, loadNumber: data.loadNumber ?? null }));
});

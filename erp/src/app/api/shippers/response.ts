// Not a route — see orders/query.ts's own header comment for why a plain module can sit next to
// route.ts files under this same tree without Next mistaking it for a fourth handler.
//
// Task 11 Step 0b (carried from Task 9's review): `updateShipper`, `addOrderToShipper`,
// `removeOrderFromShipper`, `replaceShipperLines`, `replaceShipperContainers` and
// `replaceShipperSerials` (shippers.ts) each return a bare `ShipperDetail`, with the spec §5.7
// over-ship warning exposed only through the separate pure `overshipWarnings` export — nothing
// obliges a caller to invoke it, so `return NextResponse.json(await replaceShipperLines(...))`
// would silently drop the warning a screen is supposed to show. Every mutating shipment route
// wraps its response through this ONE function instead of five (six, with `updateShipper`)
// hand-copied call sites that could drift apart, so the wire shape matches `createShipper`'s own
// `{ shipper, warnings }` contract exactly.
import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { shipmentWarnings, type ShipperDetail } from "@/server/shippers";

export async function shipperResponse(detail: ShipperDetail): Promise<NextResponse> {
  // The FULL §5.7 surface — missing-cert, serialization, over-ship — on every edit response
  // (#54): the detail page swaps its whole warning banner for this array, so an edit that
  // computed less than creation does silently un-warned the operator.
  return NextResponse.json({ shipper: detail, warnings: await shipmentWarnings(prisma, detail) });
}

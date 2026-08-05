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
import { overshipWarnings, type ShipperDetail } from "@/server/shippers";

export function shipperResponse(detail: ShipperDetail): NextResponse {
  return NextResponse.json({ shipper: detail, warnings: overshipWarnings(detail) });
}

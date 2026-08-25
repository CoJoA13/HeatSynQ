// #33 — the order services, decomposed at the create/edit seam into:
//   - order-internals.ts — the SHARED DTO types, line schemas, part/quote-link resolution and the
//     `readDetail` detail read (the §5.14 SSI-pairing contract's canonical statement lives there, on
//     `resolveQuoteLinks`);
//   - order-create.ts — `createOrder`/`saveNewOrder`/`defaultRequestDate` (the #115 retry nesting +
//     idempotent replay);
//   - order-edit.ts — the edit mutators, `void`/`link`/`unlink`, and the existing-order reads
//     (`getOrder`/`getLockedRevision`);
//   - order-board.ts — the pure board reads (`listOrders`/`exportOrders`, moved in #33's 2026-08-19
//     bounded slice).
//
// This file is now a re-exporting BARREL: every historical `@/server/orders` import path — the 13
// order routes, `order-loads.ts`, `traveler.ts` and the order test suites — keeps working unchanged,
// and each moved region is byte-for-byte the pre-split orders.ts (verified by reconstruction diff).
// Add a new order service to the module it belongs to and re-export it here; do NOT re-export the
// modules' internal helpers (they were never part of this public surface).

// Board reads — pure, no claim / no Serializable / no allocation (order-board.ts).
export { listOrders, exportOrders, trafficSettings } from "./order-board";
export type { BoardRow, OrderFilter } from "./order-board";

// A pure P2002-meta reader — db-errors.ts now (the shippers.ts -> orders.ts return edge #33 retired,
// so the documented orders <-> shippers runtime cycle is one-directional). Kept on this path for the
// historical `@/server/orders` importers.
export { isDuplicateClientRequestId } from "./db-errors";

// Shared DTOs, the two exported pure line helpers, the detail read and the loads-mismatch warning —
// order-internals.ts.
export type {
  OrderWarnings, OrderLineDetail, OrderContainerDetail, OrderSerialDetail, OrderLoadDetail,
  OrderChargeDetail, OrderDetail,
} from "./order-internals";
export { lineTotals, runSplitLoads, readDetail, loadsMismatchWarnings } from "./order-internals";

// The CREATE service — order-create.ts.
export { createOrder, defaultRequestDate } from "./order-create";

// The EDIT + lifecycle services — order-edit.ts.
export {
  getOrder, updateOrder, addLine, updateLine, removeLine,
  replaceContainers, replaceSerials, replaceCharges,
  voidOrder, linkOrder, unlinkOrder, getLockedRevision,
} from "./order-edit";

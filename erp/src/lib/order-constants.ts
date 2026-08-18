// Pure constants — safe to import from client components (no server imports). Mirrors the
// customer-constants.ts / part-constants.ts precedent: `OrderStatus` is hand-copied here rather
// than imported from the generated Prisma client, since a client component must not reach into
// src/server/** or the generated client path (CLAUDE.md "Constraints that will bite you").
export const ORDER_STATUSES = ["OPEN", "PARTIAL_SHIPPED", "SHIPPED", "INVOICED", "REOPENED"] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatusValue, string> = {
  OPEN: "Open",
  PARTIAL_SHIPPED: "Partially shipped",
  SHIPPED: "Shipped",
  INVOICED: "Invoiced",
  REOPENED: "Reopened",
};

// Postgres's INTEGER (int4) column range — every `count`/`qty` column any zod schema in this
// codebase bounds against it (order lines/containers, loads, shipment lines/containers/
// packageCount, …). Lives here rather than in `orders.ts` (Task 8 review, 2026-08-04): `orders.ts`
// and `shippers.ts` are on a path to a genuine two-way module edge (Task 10 adds `orders.ts` ->
// `shippers.ts` for the §5.5 edit invariants, order-locks.ts's own header comment anticipates it;
// `shippers.ts` already imports back from `orders.ts` for `isDuplicateClientRequestId`, a hoisted
// function and therefore safe in either evaluation order). A `const` consumed at module-evaluation
// time inside a top-level zod schema is NOT safe across that cycle — whichever side evaluates
// second can hit the other in the temporal dead zone and throw at import. A zero-import leaf
// (the `errors.ts`/`order-locks.ts` precedent) can never be on the wrong side of that.
export const INT4_MAX = 2_147_483_647;

/** `Load.weight`'s own column ceiling — DECIMAL(12,2) (schema.prisma): ten integer digits, two
 *  fractional. Stated ONCE, here beside `INT4_MAX` (#42 review round 1, minor 1): the generated-
 *  load guard (`load-split.ts`) reads this constant, and the manual editor's `decimalField(12, 2)`
 *  (order-loads.ts) encodes the same fact structurally — both sides are test-pinned, so a schema
 *  widening that forgets one of them goes red rather than silently drifting. */
export const LOAD_WEIGHT_MAX = 9_999_999_999.99;

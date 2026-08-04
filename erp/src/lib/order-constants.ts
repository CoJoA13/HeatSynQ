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

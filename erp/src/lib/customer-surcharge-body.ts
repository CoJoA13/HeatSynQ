// Client-safe pure code — no src/server imports (a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle, CLAUDE.md). The surcharge-body.ts
// precedent (Task 7 — extracted after review Fix 5, fix wave 1) applied to the customer-side
// override: a total return type so a partial patch that omits a field is a COMPILE error, not a
// silent regression, because `setCustomerSurcharge` normalizes on write — an omitted field
// clears it (task-8 brief's opening blockquote, carried in from Task 6's review).
import type { SurchargeKindValue } from "./invoice-constants";

// Mirrors src/server/surcharges.ts's CustomerSurchargeOptionRow — not imported from
// src/server/** (see above).
export type CustomerSurchargeOptionRow = {
  surchargeId: string; surchargeName: string; kind: SurchargeKindValue;
  optOut: boolean; rate: number | null; amount: number | null;
  hasOverride: boolean;
};

// The fields `setCustomerSurcharge` validates as ONE row (surcharges.ts's `CUSTOMER_SURCHARGE`
// schema). `buildCustomerSurchargeBody` below always assembles every one of these before a PUT,
// never a bare patch — `setCustomerSurcharge` persists exactly the keys it receives on its update
// branch, so an omitted key clears that column (`toCustomerSurchargeRow`'s normalize-on-write).
// `rate`/`amount` accept a decimal STRING as well as a number, same reason as surcharge-body.ts.
export type CustomerSurchargeSaveFields = {
  optOut: boolean;
  rate: number | string | null;
  amount: number | string | null;
};

/** Composes the COMPLETE row `setCustomerSurcharge` expects, from the freshest known row plus
 *  only the field(s) actually being changed. Each field falls back to the row's current value
 *  only when `patch` genuinely omits it (`!== undefined`), matching `buildSurchargeBody`'s own
 *  rule. `rate`/`amount` are then pinned to the pair the surcharge's own `kind` allows and nulled
 *  on the other — `CUSTOMER_SURCHARGE` itself carries no superRefine enforcing this (the override
 *  is deliberately independent of kind, Task 6), but the customer page only ever renders ONE of
 *  the two fields per row (whichever the surcharge's kind calls for), so nulling the other here
 *  stops a stale value surviving under a field the UI never shows again. */
export function buildCustomerSurchargeBody(
  row: CustomerSurchargeOptionRow, patch: Partial<CustomerSurchargeSaveFields>,
): CustomerSurchargeSaveFields {
  const optOut = patch.optOut !== undefined ? patch.optOut : row.optOut;
  const rate = patch.rate !== undefined ? patch.rate : row.rate;
  const amount = patch.amount !== undefined ? patch.amount : row.amount;
  return {
    optOut,
    rate: row.kind === "PERCENT" ? rate : null,
    amount: row.kind === "FLAT" ? amount : null,
  };
}

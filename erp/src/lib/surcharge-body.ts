// Client-safe pure code — no src/server imports (a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle, CLAUDE.md). Extracted out of
// src/app/admin/surcharges/page.tsx (review Fix 5, fix wave 1) so the whole-row guarantee and the
// kind -> rate/amount nulling — the single thing Task 7 was dispatched to get right — can be
// asserted by a unit test instead of resting on TypeScript alone inside an unexported,
// client-component-local function that nothing could import.
import type { SurchargeKindValue, SurchargeScopeValue } from "./invoice-constants";

// Mirrors src/server/surcharges.ts's SurchargeRow — not imported from src/server/** (see above).
export type SurchargeRow = {
  id: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  glAccountId: string | null; glAccountName: string | null; needsGlAccount: boolean;
  scope: SurchargeScopeValue; position: number; active: boolean;
  stepCodeIds: string[];
};

// The fields `updateSurcharge`/`createSurcharge` validate as ONE row (surcharges.ts's `SAVE`
// schema). `buildSurchargeBody` below always assembles every one of these before a PUT/POST,
// never a bare patch — `updateSurcharge` persists exactly the keys it receives, so an omitted key
// clears that column (`toSurchargeRow`'s normalize-on-write treats "absent" as "explicitly
// empty"). `rate`/`amount`/`minimumAmount` accept a decimal STRING as well as a number — the
// server's `decimalField` takes either — so a blur handler can hand this the exact text the user
// typed without an intermediate `Number(...)` that would only reintroduce the "trailing decimal
// point disappears mid-type" problem the page's `textDrafts` exists to avoid.
export type SurchargeSaveFields = {
  name: string; kind: SurchargeKindValue;
  rate: number | string | null;
  amount: number | string | null;
  minimumAmount: number | string | null;
  glAccountId: string | null;
  scope: SurchargeScopeValue;
  position: number;
  active: boolean;
};

/** Composes the COMPLETE row `updateSurcharge`/`createSurcharge` expect, from the freshest known
 *  row plus only the field(s) actually being changed. Each field falls back to the row's current
 *  value only when `patch` genuinely omits it (`!== undefined`, not a truthiness check) — a
 *  patch that deliberately sets a field to `null` (clearing `glAccountId`, say) must not fall
 *  back to the row's old value. `rate`/`amount` are then pinned to the pair the current `kind`
 *  allows and nulled on the other — the same invariant `SAVE`'s superRefine enforces server-side
 *  (a percent surcharge can never carry an amount and vice versa) — so a save that only touched,
 *  say, `minimumAmount` can never accidentally resurrect a stale rate left over from before a
 *  kind flip. */
export function buildSurchargeBody(row: SurchargeRow, patch: Partial<SurchargeSaveFields>): SurchargeSaveFields {
  const name = patch.name !== undefined ? patch.name : row.name;
  const kind = patch.kind !== undefined ? patch.kind : row.kind;
  const rate = patch.rate !== undefined ? patch.rate : row.rate;
  const amount = patch.amount !== undefined ? patch.amount : row.amount;
  const minimumAmount = patch.minimumAmount !== undefined ? patch.minimumAmount : row.minimumAmount;
  const glAccountId = patch.glAccountId !== undefined ? patch.glAccountId : row.glAccountId;
  const scope = patch.scope !== undefined ? patch.scope : row.scope;
  const position = patch.position !== undefined ? patch.position : row.position;
  const active = patch.active !== undefined ? patch.active : row.active;
  return {
    name, kind,
    rate: kind === "PERCENT" ? rate : null,
    amount: kind === "FLAT" ? amount : null,
    minimumAmount, glAccountId, scope, position, active,
  };
}

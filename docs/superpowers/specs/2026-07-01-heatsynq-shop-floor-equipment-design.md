# HeatSynQ — Shop Floor (Equipment Monitor) Design Spec

**Date:** 2026-07-01
**Status:** Approved (design); ready for implementation planning
**Repo:** https://github.com/CoJoA13/HeatSynQ.git
**Plan:** 5 (Shop Floor — equipment-centric Production view)
**Builds on:** Plans 1–4 (Foundation, Data-driven screens, Quote→Order→Invoice, Shop-Floor Execution & Tracking), all merged to `main`.
**Grounded reference:** [`../reference/2026-06-30-heatsynq-grounded-reference.md`](../reference/2026-06-30-heatsynq-grounded-reference.md) (design tokens, full data model, glossary, screen inventory). The ⬜ later-slice entity `Equipment` lives in §2 there.
**Prior specs (conventions + traveler/Area model this view reads):** [Plan-4 Shop-Floor Execution & Tracking](./2026-07-01-heatsynq-shop-floor-tracking-execution-design.md); [Foundation](./2026-06-30-heatsynq-foundation-quote-order-invoice-design.md).

---

## 1. Overview

Plan 4 made the traveler **live**: each `WorkOrder.steps[]` is now an `OrderStep` carrying live state (`pending | in_process | done`), the acting operator, track-in/out timestamps, an `areaId` (kanban lane), and an `inspectResult`. The Tracking board (`/tracking`) projects every open order onto ordered shop **areas**.

This plan adds the **equipment-centric** view of the same production data. Shop Floor (`/shop-floor`) replaces its placeholder with a **live furnace/oven grid**: each piece of equipment shows the load it is currently running, derived purely from which `OrderStep` is `in_process` at that equipment. It is the "by-machine" complement to Tracking's "by-stage" board — same underlying WorkOrders, different projection.

Shop Floor is a **read-only monitor**. It introduces **no new repository, no new mutation, and no new persisted entity.** All live status is a pure function over `WorkOrder[]`, exactly as the task framing anticipated ("Shop Floor equipment live-status likely derives from current OrderStep loads — a pure function over WorkOrders").

### Product framing (unchanged)
- Visual Shop is reference only (domain, terminology). HeatSynQ is its own product/data-model/UX.
- Frontend-first on a typed mock data layer behind async repository interfaces; backend-ready seams preserved.

---

## 2. Decisions locked (from brainstorming, 2026-07-01)

| Decision | Choice |
|---|---|
| **Plan-5 scope** | **Shop Floor only.** Schedule (weekly equipment-load board + `ScheduleBlock` + reactivating the dormant `scheduled` status) is **Plan 6**. This mirrors how Plan 4 split Tracking off from Shop Floor/Schedule. |
| **Equipment model** | **Static ordered config, NOT a repo** — like `Area`/nav/status-metas in Plan 4. A roster of furnaces/ovens (`id, name, kind`). Live status is **derived**, never stored. A real `Equipment` repo + persisted down/maintenance state + real telemetry stays deferred. |
| **Live status source** | **Pure projection over WorkOrders.** For each equipment: it holds a load when a `WorkOrder` has a step with `state === "in_process"` that maps to it. Running / Idle / On hold computed; LATE reused from `isLate`. |
| **Tile telemetry fidelity** | **Derived-only, honest.** Show status, WO#, customer, op, progress %, operator, `Setpoint` (parsed from real step `params`, e.g. `1700°F` — labeled a setpoint, not a live sensor reading), and `Est. finish` (`trackedInAt` + duration parsed from params, e.g. `8.0 hr`). **No fabricated live temperature, no invented alarm state.** |
| **Interactions** | **Monitor + drill-in.** Read-only; a tile holding a load links to that WO's Order Detail (where the operator acts). No scan actions on Shop Floor — scans stay single-sourced on Order Detail + Tracking board. |
| **Layout** | **Tile grid + status strip.** Responsive grid of ALL equipment (idle tiles shown, dimmed "No load · available"); a top KPI strip (running / idle / on-hold / late counts). Grid stays flat (`kind` is display metadata only). |
| **`scheduled` status** | **Stays dormant.** Shop Floor reads `in_process` loads only; it does not produce or consume `scheduled`. Reactivation belongs to Plan 6 (Schedule). |
| **Equipment status set** | `running | idle | on_hold` only. **No `alarm`** — there is no honest data source for a setpoint-deviation alarm; a past-due running load surfaces as a **LATE** flag instead. |
| **Contention** | If two `in_process` steps map to one unit, the tile shows the **current load = earliest `trackedInAt`** (running longest) and a `+N queued` indicator. Rare in seed; deterministic tie-break required. |
| **Permissions** | None gated — Shop Floor is a read view any authenticated operator sees. |

---

## 3. Scope

### In scope (build now)
- **`EQUIPMENT` roster config** + `EQUIPMENT_KINDS` + `EQUIPMENT_STATES` and their metas (`lib/domain/enums.ts`).
- **Pure logic** (`lib/logic/shop-floor.ts`): `equipmentForStep`, `equipmentLoads`, `parseSetpoint`, `parseDurationMinutes`, `shopFloorSummary`.
- **Shop Floor screen** (`/shop-floor`): status strip + equipment tile grid, drill-in to Order Detail. Replaces the placeholder.
- **Seed normalization**: step `equip` strings normalized to roster units so tiles populate; guarantee running / idle / on-hold / LATE are all demonstrable.
- **Tests**: unit (logic + parsers), component (RTL grid/tiles), one E2E happy path.

### Out of scope (later plans)
- **Schedule** weekly equipment-load board + **`ScheduleBlock`** entity + reactivating `scheduled` — **Plan 6**.
- Real **`Equipment`** repository entity; persisted per-furnace **down/maintenance** state independent of load; pyrometry/AMS-2750 TUS/SAT surveys (redesign "Maintenance" concept).
- Real furnace **telemetry** (live temperature streams, SCADA/SSI integration, real alarms).
- Scan/track **actions on Shop Floor** (Track In/Out remain on Order Detail + Tracking board).
- Partial shipments; typed `TrackingEvent`; real backend/DB + atomic transactions; real auth.

---

## 4. Architecture & stack

Unchanged from prior specs: Next.js 16 (App Router) + TypeScript; Tailwind v4 + shadcn/ui; TanStack Query v5 against repository interfaces; Zod domain models; Vitest + RTL; Playwright E2E. Locked conventions still in force:

- UI depends only on async repository interfaces via Query hooks.
- Money = integer cents; dates = ISO midnight-UTC (`formatDate`, `timeZone: "UTC"`). Clock times shown on tiles (Est. finish) are formatted UTC-deterministically, no `Date.now()` in logic.
- IBM Plex Mono for ids/numbers/pills (`MonoId`); exact design tokens.
- `any` confined to the two approved mock-plumbing signatures; **no new `any`/eslint-disable** in this plan.
- Every entity carries `id, createdAt, updatedAt, version`; every `update` is version-checked. *(This plan adds no writes, so no new update paths.)*
- Pure domain logic in `lib/logic/*`; domain types/config + Zod in `lib/domain/*`; hooks in `lib/query/*`; pattern + shell components in `components/*`.
- Presentational components pure; `page.tsx` thin glue; Next 16 dynamic routes via `use(params)`; permissions via authenticated `operator.role`/`useCan`, never `viewAs`.

**No-new-entity / no-atomicity note:** Shop Floor is a **pure read projection**. It adds no repository, no mutation, and no cross-aggregate write. There is therefore no new atomicity or optimistic-concurrency surface. The deferred backend-transaction ledger (§11) is untouched by this plan. Per `AGENTS.md`, read `node_modules/next/dist/docs/` before writing any Next-specific code (this is a breaking-changes Next).

---

## 5. Domain additions (`lib/domain/enums.ts`)

All additions are **static config**, colocated with the existing `AREAS` / status metas — no schema, no repo.

### 5.1 Equipment roster
```ts
export const EQUIPMENT_KINDS = ["batch_iq","temper","vacuum","pit","wash","inspect"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export const equipmentKindMeta: Record<EquipmentKind, { label: string }> = {
  batch_iq: { label: "Batch IQ furnace" },
  temper:   { label: "Temper oven" },
  vacuum:   { label: "Vacuum furnace" },
  pit:      { label: "Pit furnace" },
  wash:     { label: "Wash station" },
  inspect:  { label: "Inspection / Lab" },
};

export type EquipmentDef = { id: string; name: string; kind: EquipmentKind };
export const EQUIPMENT: readonly EquipmentDef[] = [
  { id: "eq-iq-1",    name: "Batch IQ #1",    kind: "batch_iq" },
  { id: "eq-iq-2",    name: "Batch IQ #2",    kind: "batch_iq" },
  { id: "eq-iq-3",    name: "Batch IQ #3",    kind: "batch_iq" },
  { id: "eq-temper-1",name: "Temper Oven #1", kind: "temper" },
  { id: "eq-temper-2",name: "Temper Oven #2", kind: "temper" },
  { id: "eq-vac-1",   name: "Vacuum Furnace #1", kind: "vacuum" },
  { id: "eq-pit-1",   name: "Pit Furnace #1",  kind: "pit" },
  { id: "eq-wash-1",  name: "Wash Station",    kind: "wash" },
  { id: "eq-inspect-1", name: "Inspect / Lab", kind: "inspect" },
] as const;
export type EquipmentId = (typeof EQUIPMENT)[number]["id"]; // widened to string in practice; a helper resolves ids.
```
*(Implementation note: `EquipmentId` may be modeled as `string` with an `equipmentById` lookup map, since a `readonly EquipmentDef[]` does not produce a literal union without `as const` on each `id`. The plan will pick whichever is cleanest under `tsc --noEmit`; the roster contents above are the contract.)*

### 5.2 Equipment status
```ts
export const EQUIPMENT_STATES = ["running","idle","on_hold"] as const;
export type EquipmentState = (typeof EQUIPMENT_STATES)[number];
export const equipmentStateMeta: Record<EquipmentState, { label: string; tone: StatusTone }> = {
  running: { label: "Running", tone: "success" },
  idle:    { label: "Idle",    tone: "neutral" },
  on_hold: { label: "On hold", tone: "warn" },
};
```

No changes to any existing entity, enum, or repository. `Equipment`-as-entity, `ScheduleBlock`, `TrackingEvent` remain ⬜.

---

## 6. Pure logic (`lib/logic/shop-floor.ts`) — TDD

All functions pure and deterministic (caller supplies `asOf`). Tests written first.

### 6.1 `equipmentForStep(step: OrderStep | ProcessStep): EquipmentId`
Resolve a step's free-text `equip` string to a roster id.
1. **Exact name match** (case-insensitive, trimmed) against `EQUIPMENT[].name` → that unit.
2. **Keyword heuristic** → the first unit of the matched kind: `/vacuum/i → vacuum`, `/pit|nitrid/i → pit`, `/wash/i → wash`, `/inspect|lab/i → inspect`, `/temper/i → temper`, `/iq|batch|carbur|harden/i → batch_iq`.
3. **Fallback** → `eq-iq-1` (so no step is unmapped). Fallback is covered by a test.

Mirrors the Plan-4 `areaForOp` precedent (exact intent → heuristic → safe default).

### 6.2 Parsers
- `parseSetpoint(params: string[]): string | null` — return the first param matching a temperature pattern (`/\d+\s*°?\s*F/i`), normalized (e.g. `"1700°F"`); else `null`.
- `parseDurationMinutes(params: string[]): number | null` — parse the first param matching a duration (`/(\d+(\.\d+)?)\s*(hr|hour|h|min|m)\b/i`) → minutes (`hr→×60`); else `null`.
Both null-safe; both tested including the no-match case.

### 6.3 `equipmentLoads(orders: WorkOrder[], asOf: string): Record<EquipmentId, EquipmentLoad>`
For every roster unit, compute its state + optional load.

```ts
type EquipmentLoad = {
  equipmentId: EquipmentId;
  state: EquipmentState;              // running | idle | on_hold
  load: {
    workOrderId: string;
    workOrderNumber: string;
    customerId: string;
    op: string;                       // active step op
    progressPct: number;              // WorkOrder.progressPct
    operatorInitials: string | null;
    setpoint: string | null;          // parseSetpoint(step.params)
    estFinishIso: string | null;      // trackedInAt + parseDurationMinutes(step.params); null if unparseable
    late: boolean;                    // isLate(order, asOf) && status !== "shipped"
    trackedInAt: string | null;
  } | null;
  queued: number;                     // additional in_process steps mapping here (contention), else 0
};
```
Rules per unit:
- Gather candidate steps: across all `orders`, every step with `state === "in_process"` whose `equipmentForStep(step) === unit.id`.
- **Idle** if no candidates → `state: "idle"`, `load: null`, `queued: 0`.
- Otherwise **current load = candidate with earliest `trackedInAt`** (nulls last; final tie-break by WO number for determinism). `queued = candidates.length - 1`.
- **On hold** if the current load's WorkOrder `status === "on_hold"`; else **Running**.
- Fill `load` fields from the current load's WorkOrder + step (`late = isLate(order, asOf) && order.status !== "shipped"`).

Pure; no `Date.now`. Customer name resolution happens in the component (it has `customers`); logic returns `customerId`.

### 6.4 `shopFloorSummary(loads: EquipmentLoad[]): { running; idle; onHold; late }`
Counts by `state` plus a `late` count (loads with `load?.late`). Feeds the KPI strip.

---

## 7. Data flow & hooks (`lib/query`)

**No new hooks required.** The Shop Floor page composes existing queries — the same pattern the Tracking page uses:
- `useWorkOrders()` → `WorkOrder[]`
- `useCustomers()` → `Customer[]` (for tile customer labels + name lookup)

The page passes `orders`, `customers`, and a deterministic `asOf` into a pure `<ShopFloorGrid>` that calls the §6 logic. Loading/error/empty handled from the query results (see §9). If a thin `useShopFloor()` convenience wrapper reads cleaner during implementation it may be added, but it introduces no new repo call.

---

## 8. Screen (`components/shop-floor/`, replace placeholder)

`app/(app)/shop-floor/page.tsx` — thin glue: runs the two queries, supplies `asOf`, renders `<ShopFloorGrid>`.

`components/shop-floor/shop-floor-grid.tsx` (+ `equipment-tile.tsx`):
- **`PageHeader`** — title "Shop Floor", subtitle e.g. "Live furnace & oven status".
- **Status strip** — `KpiTile` ×4: Running / Idle / On hold / Late (from `shopFloorSummary`).
- **Tile grid** — responsive grid over the full `EQUIPMENT` roster (stable order = roster order), so idle units stay visible.
  - **Idle tile:** unit name + kind label; dimmed; body "No load · available"; non-interactive.
  - **Loaded tile (running / on hold):** unit name + kind; `StatusPill` (`equipmentStateMeta`); `MonoId` WO#; customer name; active op; progress bar (`progressPct`); operator initials; `Setpoint 1700°F` (when parsed); `Est. finish h:mm AM/PM` (when `estFinishIso`); **LATE** pill when `load.late`; `+N queued` when `queued > 0`.
  - A loaded tile is a **link to `/orders/{workOrderId}`** (drill-in). Idle tiles do not link.
- **States:** query `isLoading` → skeleton tiles (`SkeletonRows`/skeleton grid); `isError` → `ErrorPanel` + retry (both `workOrders` and `customers` guarded — an error in either shows the panel, matching Plan-4's Tracking certs-guard fix); truly-empty roster is impossible (roster is static), so "empty" = all-idle renders normally (no dead screen).

Reused patterns: `PageHeader`, `KpiTile`, `StatusPill`, `MonoId`, `SkeletonRows`, `ErrorPanel`, progress bar. Non-drag, jsdom-safe. Nav already lists Shop Floor under Production — only the page swaps from placeholder to real.

---

## 9. States, validation, errors
Unchanged patterns: Query `isLoading` skeletons from simulated latency; recoverable `ErrorPanel` with retry (mock fault injection) guarded on **both** underlying queries; the grid degrades to an all-idle floor when there are no `in_process` loads (still a valid, informative screen). No forms, no mutations, no optimistic updates in this plan.

---

## 10. Testing strategy (TDD where it counts)

**Gate (must stay green):** `npm test` · `tsc --noEmit` · `eslint --max-warnings 0` · `next build` · `test:e2e`. No new `any`/eslint-disable.

- **Unit (Vitest, tests first):**
  - `equipmentForStep` — exact match, each keyword heuristic branch, fallback.
  - `parseSetpoint` / `parseDurationMinutes` — match + no-match/null, hr vs min.
  - `equipmentLoads` — idle unit; single running load (fields incl. setpoint/estFinish); on-hold load (WO on_hold); LATE flag; **contention** (earliest `trackedInAt` wins, `queued` count, deterministic tie-break); null `trackedInAt` handling.
  - `shopFloorSummary` — counts incl. late.
- **Component (RTL):** `ShopFloorGrid` — running tile content, idle tile dimmed/non-linking, on-hold tile, LATE pill, `+N queued`, drill-in `href={/orders/…}`, status strip counts, loading skeleton, error panel (workOrders error and customers error), all-idle render.
- **E2E (Playwright):** **add** `tests/e2e/shop-floor.spec.ts` — navigate to Shop Floor via in-app nav; assert the status strip shows a non-zero Running count; a running furnace tile shows a seed `in_process` WO#; click it → lands on that WO's Order Detail. (In-app nav only; mock store resets on full reload.)

---

## 11. Seed data (`lib/data/seed`)

- **Normalize `equip`** on process-master / order steps so each resolves to a roster unit by **exact name** (thermal ops → a specific `Batch IQ #n` / `Vacuum Furnace #1` / `Pit Furnace #1`; temper ops → `Temper Oven #n`; wash → `Wash Station`; inspect → `Inspect / Lab`). Distribute across units so multiple furnaces show activity.
- **Guarantee the demo covers every state:**
  - ≥1 **Running** furnace (seed already has `in_process` WOs — e.g. WO-48211 carburize on a Batch IQ).
  - ≥1 **Idle** unit (leave at least one roster furnace with no active load).
  - The existing **`on_hold`** WO (WO-48142) has its active step's furnace read **On hold**.
  - ≥1 **LATE** running load — if no `in_process` seed WO is past `asOf`, nudge one WO's `due` earlier so `isLate` fires. Keep the Q→O→I E2E order and all existing invoices/certs consistent (do not disturb the Plan-3/Plan-4 happy paths).
- Fix any seed/repo tests affected by the `equip` normalization.

---

## 12. Build sequence (high level — detailed plan via writing-plans)
1. `EQUIPMENT` roster + `EQUIPMENT_KINDS` + `EQUIPMENT_STATES` + metas (`lib/domain/enums.ts`); export via `lib/domain/index.ts`.
2. Pure logic (tests first): `parseSetpoint`, `parseDurationMinutes`, `equipmentForStep`, `equipmentLoads`, `shopFloorSummary`.
3. Seed normalization + guaranteed running/idle/on-hold/LATE; fix seed/repo tests.
4. `ShopFloorGrid` + `EquipmentTile` components (RTL tests): tile variants, status strip, drill-in, loading/error/all-idle.
5. `app/(app)/shop-floor/page.tsx` — replace placeholder; wire queries + `asOf`.
6. E2E `tests/e2e/shop-floor.spec.ts` (happy path).
7. Whole-branch adversarial review; address findings; PR (verify check required by branch protection).

---

## 13. Deferred-item ledger (post-Plan-5)

**Resolved by Plan 5:** the equipment-centric Shop Floor monitor (derived live status over WorkOrders); the `/shop-floor` placeholder retired.

**Still deferred:**
- **Schedule** weekly equipment-load board + **`ScheduleBlock`** entity + **reactivating the dormant `scheduled` OrderStatus** — **Plan 6** (assigns WOs to equipment/day; Schedule → `scheduled` → first track-in → `in_process`).
- Real **`Equipment`** repository entity; persisted per-furnace **down/maintenance** state (and the redesign's pyrometry / AMS-2750 TUS-SAT "Maintenance" concept, `CAR` corrective actions).
- Real furnace **telemetry** (live temperature, countdown, SCADA/SSI, genuine setpoint-deviation **Alarm** state) — Shop Floor currently shows derived setpoint + est-finish only.
- **Partial shipments**; typed **`TrackingEvent`** log / shop-wide scan feed.
- **Backend atomicity** of win / ship / inspect-pass-release (mock repo has no transaction primitive) — unchanged; Shop Floor adds no writes.
- **"Superseded" QuoteStatus** (Plan-3 carry-forward) — still a product decision.
- Pre-existing minors carried from Plan-3/4 memory (`parseNetDays` discount-terms, broad `useUpdateQuote` patch type, `numbers.next` guard, `useCustomer("")` null query, Documents entity) — unchanged, low-risk.

---

## 14. Assumptions & open items
- App name **HeatSynQ**; demo shop **Heritage Heat Treat** (unchanged).
- Equipment roster (§5.1) is a reasonable heat-treat shop set derived from the seeded process masters; exact unit count/naming may be tuned during seed normalization without changing the design contract.
- Shop Floor is read-only; any authenticated operator may view it; no new role added.
- `scheduled` status stays dormant until Plan 6.
- All Plan-5 locked decisions in §2 stand unless changed.

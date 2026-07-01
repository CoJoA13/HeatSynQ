# HeatSynQ — Schedule (Weekly Equipment-Load Board) Design Spec

**Date:** 2026-07-01
**Status:** Approved (design); ready for implementation planning
**Repo:** https://github.com/CoJoA13/HeatSynQ.git
**Plan:** 6 (Schedule — the weekly equipment-load board)
**Builds on:** Plans 1–5 (Foundation, Data-driven screens, Quote→Order→Invoice, Shop-Floor Execution & Tracking, Shop Floor equipment monitor), all merged to `main`.
**Grounded reference:** [`../reference/2026-06-30-heatsynq-grounded-reference.md`](../reference/2026-06-30-heatsynq-grounded-reference.md) (design tokens, full data model, glossary, screen inventory). The ⬜ later-slice entity `ScheduleBlock` lives in §2 there (`{equipment, day (mon–fri), label, sub, kind}`); this plan realizes it as a **WO-linked** repo entity (see §5).
**Prior specs (conventions + traveler/Area/Equipment model this board reads):** [Plan-5 Shop Floor (Equipment)](./2026-07-01-heatsynq-shop-floor-equipment-design.md); [Plan-4 Shop-Floor Execution & Tracking](./2026-07-01-heatsynq-shop-floor-tracking-execution-design.md); [Foundation](./2026-06-30-heatsynq-foundation-quote-order-invoice-design.md).

---

## 1. Overview

Plan 4 made the traveler **live** and gave every open order a by-stage projection (`/tracking`). Plan 5 added the **by-machine** projection of live work (`/shop-floor`) — a pure, read-only monitor of which `OrderStep` is `in_process` at each furnace/oven.

This plan adds the **planning** view that sits *before* execution in the pipeline (`Quote → Order → **Schedule** → Track → Cert → Ship → Invoice`). Schedule (`/schedule`) replaces its placeholder with a **weekly equipment-load board**: a grid of the `EQUIPMENT` roster (rows) × the current Monday–Friday week (columns). A planner **assigns** a received work order to a furnace and a day, which persists a **`ScheduleBlock`** and transitions the order into the `scheduled` status. It is the first screen in this product that **writes** shop-floor planning state.

### What makes this plan different from Plans 4–5
- Plan 5's `Equipment` is **static config with pure reads**. Schedule **persists assignments** — so `ScheduleBlock` is a **real repository entity** (`id/createdAt/updatedAt/version` + optimistic-concurrency `update`), with new Query hooks and mutations.
- It **reactivates the dormant `scheduled` `OrderStatus`.** The status, its meta, and its transitions already exist in the codebase (`received → scheduled → in_process`), and `rollUpOrderStatus` already fires `scheduled → in_process` on first track-in. What is missing is a **producer** of the `scheduled` state — this plan is that producer.
- Shop Floor and Schedule are **complementary, independent** projections of the same equipment roster: Schedule shows **planned** loads (forward-looking); Shop Floor shows **live `in_process`** loads. No expected-vs-actual cross-wiring in this slice (§2).

### Product framing (unchanged)
- Visual Shop is reference only (domain, terminology). HeatSynQ is its own product/data-model/UX.
- Frontend-first on a typed mock data layer behind async repository interfaces; backend-ready seams preserved.

---

## 2. Decisions locked (from brainstorming, 2026-07-01)

| Decision | Choice |
|---|---|
| **Plan-6 scope** | **Schedule board only.** Shop Floor stays independent — no expected-vs-actual cross-wiring this slice. Both screens read the same `EQUIPMENT` roster; Schedule is the writer. |
| **`ScheduleBlock` coupling** | **WO-linked assignment.** `workOrderId` is **required**; a block means "this WorkOrder is planned onto this equipment on this day." This is the only model that reactivates `scheduled` cleanly. The reference's free-standing `{label, sub, kind}` block is **not** built. |
| **Entity minimalism** | **Derive display at read.** The block stores only `workOrderId`, `equipmentId`, `day`, `state`. WO#, customer, op, kind, progress, LATE are all derived from the WorkOrder + roster + customers already loaded — single source of truth is the WO. No stored `label/sub/kind`, no human-facing number. |
| **`day` model** | **ISO midnight-UTC date.** The board renders the **current Monday–Friday week** anchored to the mock clock (`NOW = 2026-06-30T12:00:00.000Z` → week **Jun 29 – Jul 3, 2026**). Ties a block's day to the WO `due` date and keeps `isLate` honest. **No week navigation** this slice (single current week). |
| **Unassign mechanics** | **Soft-cancel** (no delete primitive exists, per locked convention). Unassign is a version-checked `update` that flips the block `planned → cancelled` **and** reverts the WO `scheduled → received`. The board query shows only `planned` blocks. |
| **New transition edge** | Add **`scheduled → received`** to `ORDER_TRANSITIONS` (the unassign revert). All other edges already exist. |
| **Status lifecycle** | Assign: WO `received → scheduled` + create `planned` block. First track-in (existing Order Detail / Tracking): `scheduled → in_process` (no change — `rollUpOrderStatus` already does this). Unassign: block `→ cancelled` + WO `→ received`. Move: re-target block equipment/day, WO status unchanged. |
| **Action gating (which WOs)** | Assign only for `received` WOs. **Move/Unassign only while the WO `status === "scheduled"`.** Once `in_process`, the block is **read-only history** on the board (shows live status, no actions). |
| **Interaction model** | **Action-driven, jsdom-safe** (shadcn `Select` + `Button` + `ConfirmDialog`) — no drag-and-drop, mirroring the Tracking board. |
| **One block per WO** | A WO has **one active (`planned`) block** at a time (single equipment + day). Multi-day / multi-equipment furnace routing is deferred. |
| **Permissions** | New `Permission "schedule_loads"`, granted to `["manager","office"]`. Gates the assign/move/unassign affordances. Board **view** is ungated (any authenticated operator). |
| **Write ordering** | Assign: **version-checked WO update first**, then create block (house rule — the write that can conflict runs first, so a stale order throws before any orphan block is persisted). Unassign: block `→ cancelled` first, then WO revert; both version-checked. |

---

## 3. Scope

### In scope (build now)
- **`ScheduleBlock`** domain entity (Zod schema + type) + `SCHEDULE_BLOCK_STATES` config (`lib/domain`).
- **`schedule_loads`** permission (`lib/auth/permissions.ts`).
- **`scheduled → received`** transition edge (`lib/logic/order.ts`).
- **`scheduleBlocks` repository** (`WriteRepo<ScheduleBlock>`): interface, mock Collection, provider wiring, seed.
- **Pure logic** (`lib/logic/schedule.ts`): `weekDays`, `unscheduledOrders`, `scheduleCells`, `scheduleSummary`, and pure patch/activity builders for the three mutations.
- **Query hooks** (`lib/query`): `useScheduleBlocks`, `useAssignSchedule`, `useMoveSchedule`, `useUnschedule` + query keys.
- **Schedule screen** (`/schedule`): KPI strip + roster×week grid + unscheduled queue + assign/move/unassign dialogs. Replaces the placeholder.
- **Seed additions**: a `received` WO (queue + assign E2E) and a `scheduled` WO + a pre-existing `planned` block within the current week (board non-empty + move/unassign demo).
- **Tests**: unit (logic + builders + new edge), component (RTL grid/cells/queue/dialogs/gating/states), one E2E happy path.

### Out of scope (later plans)
- **Week navigation** (prev/next week), **capacity/hours** modeling, furnace availability windows.
- **Multi-block / multi-day** furnace routing for one WO (the traveler spanning several days across equipment).
- **Drag-and-drop** reordering (kept action-driven for jsdom safety + single-source with Tracking).
- **Free-standing planning blocks** (label/sub/kind with no WO) — the reference's alternate shape.
- Real **`Equipment`** repo entity, persisted down/maintenance state, real telemetry / alarms (Plan-5 deferred set).
- **Partial shipments**; typed **`TrackingEvent`** log; real backend/DB + **atomic multi-aggregate transactions** (§13).
- **Expected-vs-actual** cross-wiring between Schedule (planned) and Shop Floor (live).

---

## 4. Architecture & stack

Unchanged from prior specs: Next.js 16 (App Router) + TypeScript; Tailwind v4 + shadcn/ui; TanStack Query v5 against repository interfaces; Zod domain models; Vitest + RTL; Playwright E2E. Per `AGENTS.md`, **read `node_modules/next/dist/docs/` before writing any Next-specific code** (this is a breaking-changes Next 16).

Locked conventions still in force:
- UI depends only on async repository interfaces via Query hooks.
- Money = integer cents; dates = ISO midnight-UTC (`formatDate`, `timeZone: "UTC"`); no `Date.now()` in pure logic (callers pass `asOf`/`at`).
- IBM Plex Mono for ids/numbers/pills (`MonoId`); exact design tokens.
- `any` confined to the **two** approved mock-plumbing signatures (`read<T>`/`write<T>` in `lib/data/mock/repositories.ts`); **no new `any`/eslint-disable** in this plan.
- Every entity carries `id, createdAt, updatedAt, version`; **every `update` is version-checked** (optimistic concurrency).
- Pure domain logic in `lib/logic/*`; domain types/config + Zod in `lib/domain/*`; hooks in `lib/query/*`; pattern + shell components in `components/*`.
- Presentational components pure; `page.tsx` thin glue; Next 16 dynamic routes via `use(params)`; permissions via authenticated `operator.role`/`useCan`, never `viewAs`.

**Deterministic demo clock (`lib/clock.ts`):** The Schedule week window is date-dependent, so it **must not** read the wall clock. The mock data layer already freezes the demo's "present" at `NOW = "2026-06-30T12:00:00.000Z"` (`lib/data/mock/store.ts`), and seed data (including the new block `day`s) is authored against it. This plan adds a neutral, mock-free `lib/clock.ts` exporting `DEMO_NOW` (same instant) and a `nowIso()` accessor; `lib/data/mock/store.ts` re-points `NOW` at `DEMO_NOW` so there is a **single source** for "now" (value unchanged → existing seed/repo tests stay green). The Schedule page uses `DEMO_NOW` as its `asOf`, so `weekDays()` always resolves to **Jun 29 – Jul 3, 2026** and the seeded blocks render regardless of the machine's wall-clock. (Tracking/Shop Floor keep their wall-clock `asOf`; their date only drives cosmetic LATE and their E2E avoids asserting it — adopting `DEMO_NOW` there is an optional, out-of-scope follow-up.) This respects "UI depends only on repo interfaces": `lib/clock.ts` is a plain domain-neutral constant, not a mock internal.

**New-entity / atomicity note:** Schedule is the first **writing** planning surface. It adds one repository (`scheduleBlocks`) and three mutations. Two of those (`useAssignSchedule`, `useUnschedule`) touch **two aggregates** (a `ScheduleBlock` and a `WorkOrder`). The mock repo has no transaction primitive, so — exactly as with Plan-3/4's win-saga, ship+invoice, and inspect-pass→cert-release — these run as **ordered, version-checked writes** (the risky write first) and their residual cross-aggregate atomicity gap is logged in the deferred ledger (§13). No new optimistic-concurrency mechanism is invented; the existing `update(id, patch, expectedVersion)` contract is reused.

---

## 5. Domain additions

### 5.1 `ScheduleBlock` entity (`lib/domain/entities.ts`)
```ts
export const SCHEDULE_BLOCK_STATES = ["planned", "cancelled"] as const;
export type ScheduleBlockState = (typeof SCHEDULE_BLOCK_STATES)[number];

export const scheduleBlockSchema = baseEntitySchema.extend({
  workOrderId: z.string(),
  equipmentId: z.string(),          // one of EQUIPMENT[].id; validated by helper (see note)
  day: z.string(),                  // ISO midnight-UTC date, e.g. "2026-06-30T00:00:00.000Z"
  state: z.enum(SCHEDULE_BLOCK_STATES),
});
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
```
- `SCHEDULE_BLOCK_STATES` + a small `scheduleBlockStateMeta` (`planned`/`cancelled` labels) live in `lib/domain/enums.ts` alongside the other status metas; the schema imports the const.
- **`equipmentId` typing:** `EquipmentId` is a literal union derived from `EQUIPMENT`. `z.string()` is used in the schema (mirrors how `customerId`/`processMasterId` foreign keys are typed as `z.string()`); an `equipmentById` lookup / `isEquipmentId` guard from `lib/domain/enums.ts` validates roster membership where it matters (assign dialog options come straight from `EQUIPMENT`, so bad ids are not constructible through the UI). The TS surface (`ScheduleBlock.equipmentId`) may be narrowed to `EquipmentId` in the mutation/logic signatures.
- No `number` field (blocks are not human-referenced), so `scheduleBlocks` is **not** added to `numberPrefix`; `create` runs without a number key.
- Export flows through `lib/domain/index.ts` (already re-exports `./entities` + `./enums`).

### 5.2 Permission (`lib/auth/permissions.ts`)
```ts
export type Permission =
  | "approve_over_limit" | "apply_discount" | "release_cert" | "close_period" | "edit_setup"
  | "schedule_loads";

const MATRIX: Record<Permission, RoleKey[]> = {
  // …existing…
  schedule_loads: ["manager", "office"],
};
```

### 5.3 Transition edge (`lib/logic/order.ts`)
```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  received: ["scheduled", "on_hold"],
  scheduled: ["in_process", "on_hold", "received"], // + received (unassign revert)
  in_process: ["ready_to_ship", "on_hold"],
  on_hold: ["received", "scheduled", "in_process", "ready_to_ship"],
  ready_to_ship: ["shipped", "on_hold"],
  shipped: [],
};
```
No other enum, meta, or entity changes. `orderStatusMeta.scheduled` (label "Scheduled", tone `neutral`) already exists and is reused.

---

## 6. Repository (`lib/data`)

### 6.1 Interface (`lib/data/repositories/index.ts`)
```ts
export interface Repositories {
  // …existing…
  scheduleBlocks: WriteRepo<ScheduleBlock>;
}
```
`list / get / create / update(id, patch, expectedVersion)` — the standard `WriteRepo<T>` surface. No custom finder is required (the board loads all blocks and filters in pure logic); a `byWorkOrder` convenience may be added only if it reads cleaner during implementation, but is not part of the contract.

### 6.2 Mock wiring (`lib/data/mock/repositories.ts`)
- `cols.scheduleBlocks = new Collection(seed.scheduleBlocks)`.
- `scheduleBlocks: write(cols.scheduleBlocks)` (no number key).
- `create` assigns `id = genId("scheduleBlocks")`, `createdAt/updatedAt = NOW`, `version = 0`; `update` performs the version check + `version + 1` (unchanged generic factory — **no new `any`**).

### 6.3 Provider / DI
No change to `lib/data/provider.tsx` — it consumes the whole `Repositories` object; the new repo is available through `useRepositories()` automatically once wired in the factory.

---

## 7. Pure logic (`lib/logic/schedule.ts`) — TDD

All functions pure and deterministic (caller supplies `asOf`); tests written first. No `Date.now()`.

### 7.1 `weekDays(asOf: string): { iso: string; label: string; weekdayShort: string }[]`
Return the **five** Mon–Fri ISO midnight-UTC dates of the week containing `asOf`, in order, with display labels (`"Mon 6/29"` etc., UTC-formatted). Monday-anchored in UTC via the **Monday on or before `asOf`** rule (a Sunday maps to the week just ending). Deterministic; no wall-clock. In the app it is called with `DEMO_NOW` → **Jun 29 – Jul 3, 2026**. Tested for a mid-week `asOf`, a Monday `asOf`, and a Sunday `asOf`.

### 7.2 `unscheduledOrders(orders: WorkOrder[], blocks: ScheduleBlock[]): WorkOrder[]`
Orders with `status === "received"` that have **no** `planned` block. (A received order can't already have a planned block under the lifecycle, but the filter is defensive + tested.) Sorted by `due` ascending for a stable queue.

### 7.3 `scheduleCells(blocks, orders, asOf): ScheduleCell[]`
```ts
type ScheduleCell = {
  blockId: string;
  equipmentId: string;
  day: string;                 // ISO date matching a weekDays().iso
  workOrderId: string;
  workOrderNumber: string;
  customerId: string;
  op: string | null;           // activeStep(order).op ?? first step op
  status: OrderStatus;         // live WO status → StatusPill
  progressPct: number;
  late: boolean;               // isLate(order, asOf)
  actionable: boolean;         // order.status === "scheduled" (move/unassign allowed)
};
```
Rules:
- Consider only `planned` blocks whose WorkOrder exists and is **not** `shipped`, and whose `day` falls within `weekDays(asOf)`.
- Resolve each into a cell positioned by `(equipmentId, day)`. Live `status`, `progressPct`, `late`, `op` derived from the WO.
- Deterministic ordering when two blocks share a cell (rare; e.g. move races): by WO number. (One-block-per-WO makes same-cell collisions unusual, but the render must be stable.)
- Customer **name** resolution happens in the component (it has `customers`); logic returns `customerId`.

### 7.4 `scheduleSummary(cells, unscheduled): { scheduled; unscheduled; late }`
`scheduled = cells.length`; `unscheduled = unscheduled.length`; `late = cells.filter(c => c.late).length`. Feeds the KPI strip.

### 7.5 Pure builders (keep hooks thin + unit-tested)
- `assignPatch(order, equipmentId, day, actor, at)` → `{ status: "scheduled", activity: [...+ "Scheduled — {equip name} · {day label}"] }` (the WO patch) **and** `{ workOrderId, equipmentId, day, state: "planned" }` (the block create input). Returned as a small typed object the hook applies.
- `unschedulePatch(order, actor, at)` → block patch `{ state: "cancelled" }` + WO patch `{ status: "received", activity: [...+ "Unscheduled — returned to Received"] }`.
- `movePatch(equipmentId, day)` → block patch `{ equipmentId, day }`.
Equipment display name comes from `equipmentById`. These builders are pure and fully tested; the hooks just call `repo.update`/`repo.create` with them.

---

## 8. Data flow & hooks (`lib/query`)

### 8.1 Query keys (`lib/query/keys.ts`)
```ts
scheduleBlocks: ["scheduleBlocks"] as const,
```

### 8.2 Read
- `useScheduleBlocks()` → `ScheduleBlock[]` (list). The page also composes existing `useWorkOrders()` + `useCustomers()`.

### 8.3 Mutations
- **`useAssignSchedule()`** — input `{ order, equipmentId, day, operator, at }`.
  1. `repo.workOrders.update(order.id, assignPatch.workOrder, order.version)` — **version-checked first**.
  2. `repo.scheduleBlocks.create(assignPatch.block)`.
  3. `onSuccess`: invalidate `workOrders`, `workOrder(id)`, `scheduleBlocks`.
- **`useMoveSchedule()`** — input `{ block, equipmentId, day }`. `repo.scheduleBlocks.update(block.id, movePatch, block.version)`. Invalidate `scheduleBlocks`.
- **`useUnschedule()`** — input `{ order, block, operator, at }`.
  1. `repo.scheduleBlocks.update(block.id, { state: "cancelled" }, block.version)`.
  2. `repo.workOrders.update(order.id, unschedulePatch.workOrder, order.version)`.
  3. `onSuccess`: invalidate `workOrders`, `workOrder(id)`, `scheduleBlocks`.

Each mutation exposes `isPending` so the board can set a `busy` flag that disables affordances mid-flight (mirrors Tracking). Cross-aggregate atomicity gap → §13.

---

## 9. Screen (`components/schedule/`, replace placeholder)

`app/(app)/schedule/page.tsx` — thin glue: runs `useScheduleBlocks` + `useWorkOrders` + `useCustomers`, reads `operator`/`useCan("schedule_loads")`, supplies the deterministic `asOf = DEMO_NOW` (from `lib/clock.ts` — **not** the wall clock, so the week window is fixed), wires the three mutations, renders `<ScheduleBoard>`. Guards `isLoading` (skeleton) and `isError` on **all three** queries (`ErrorPanel` + retry).

`components/schedule/schedule-board.tsx` (+ `schedule-cell.tsx`, `assign-dialog.tsx`, `unscheduled-queue.tsx`):
- **`PageHeader`** — title "Schedule", subtitle "Weekly equipment load — assign orders to a furnace and day."
- **Status strip** — `KpiTile` ×3: Scheduled / Unscheduled / Late (from `scheduleSummary`).
- **Grid** — rows = the full `EQUIPMENT` roster (stable order = roster order; sticky left column showing unit `name` + `equipmentKindMeta.label`, like the Shop Floor tile header), columns = `weekDays(asOf)` (Mon–Fri headers). Horizontal scroll on narrow screens.
  - **Cell with a block:** a card with `MonoId` WO#, customer name, active op, `StatusPill(orderStatusMeta[status])`, LATE pill when `late`, small progress bar. If `actionable` **and** `canSchedule`, show **Move** and **Unassign** affordances (Move opens the assign dialog pre-filled; Unassign opens `ConfirmDialog`). Non-actionable (in_process+) cells render read-only.
  - **Empty cell:** faint "—" / available; if `canSchedule`, an unobtrusive affordance is **not** required here (assignment is driven from the queue, see below) — empty cells stay display-only to keep the interaction single-sourced.
- **Unscheduled queue** — `unscheduledOrders` rendered as a rail/section (WO#, customer, due, LATE). Each item has an **Assign** button (gated `canSchedule`) → **assign dialog**: `Select` equipment (from `EQUIPMENT`) + `Select` day (from `weekDays`), confirm → `useAssignSchedule`. Empty queue shows an `EmptyState` ("All received orders scheduled").
- **Shared dialog** (`assign-dialog.tsx`): the same equipment+day `Select` dialog serves **Assign** (from a queue item, no existing block → `onAssign`) and **Move** (from an actionable cell, pre-filled with the block's current equipment/day → `onMove`); title/confirm label switch on mode.
- **States:** query `isLoading` → `SkeletonRows`; `isError` (any of the three) → `ErrorPanel` + retry; a week with no blocks still renders the grid (all empty cells) + the queue — never a dead screen.

Reused patterns: `PageHeader`, `KpiTile`, `StatusPill`, `MonoId`, `SkeletonRows`, `ErrorPanel`, `EmptyState`, `ConfirmDialog`, shadcn `Select`/`Dialog`/`Button`, progress bar. Non-drag, jsdom-safe. Nav already lists Schedule under Production — only the page swaps from placeholder to real.

---

## 10. States, validation, errors
- Query `isLoading` skeletons from simulated latency; recoverable `ErrorPanel` with retry (mock fault injection) guarded on **all three** underlying queries.
- Assign dialog validates a chosen equipment + day before enabling confirm; day options come from `weekDays` and equipment from `EQUIPMENT`, so invalid combinations are not constructible.
- Mutations surface a **version-conflict** the same way other screens do (the mutation rejects; the query refetch on error/settle returns the fresh state). Buttons disabled while `busy`.
- The grid degrades to an all-empty week when there are no `planned` blocks (still a valid, informative screen with a populated queue).

---

## 11. Testing strategy (TDD where it counts)

**Gate (must stay green):** `npm test` · `tsc --noEmit` · `eslint --max-warnings 0` · `next build` · `test:e2e`. No new `any`/eslint-disable.

- **Unit (Vitest, tests first):**
  - `weekDays` — mid-week, Monday, Sunday anchors; five entries; UTC labels; Monday-on-or-before rule.
  - `unscheduledOrders` — received-with-no-planned-block only; excludes scheduled/in_process; sorted by due.
  - `scheduleCells` — planned-only (cancelled dropped); shipped WO dropped; block outside the week dropped; LATE derivation; `actionable` true only for `scheduled`; same-cell tie-break by WO number; missing-WO defensive drop.
  - `scheduleSummary` — counts incl. late.
  - Builders — `assignPatch` (WO patch + block input + activity message), `unschedulePatch` (cancel + revert + activity), `movePatch`.
  - `ORDER_TRANSITIONS` — `canTransition("scheduled","received")` true; existing edges unchanged.
  - Repo — `scheduleBlocks` create/update round-trip + optimistic-concurrency conflict (mirrors the existing repo test).
- **Component (RTL):** `ScheduleBoard` — grid rows = roster, columns = week; block cell content (WO#, customer, op, status pill, LATE, progress); empty cell; **gated affordances** (Assign/Move/Unassign present for `manager`, absent for `sales`); assign dialog (select equipment + day → calls `onAssign`); move; unassign confirm; read-only non-actionable cell; loading skeleton; error panel (each of the three query errors); empty-week render; empty-queue `EmptyState`.
- **E2E (Playwright):** **add** `tests/e2e/schedule.spec.ts` — navigate to Schedule via in-app nav; assert a seeded `planned` block cell shows its WO# with a "Scheduled" pill; open the Unscheduled queue, Assign a `received` WO to an equipment + day; assert a new cell appears with that WO# and a "Scheduled" pill and the WO leaves the queue. (In-app nav only; mock store resets on full reload; assert clock-independent facts only.)

---

## 12. Seed data (`lib/data/seed`)

The seed currently has **no `received` and no `scheduled`** WorkOrder (statuses present: `in_process` ×4, `on_hold` ×1, `ready_to_ship` ×2). Add:
- **≥1 `received` WO** with live `steps` all `pending` (so it's assignable) — powers the Unscheduled queue and the assign E2E. Give it a `due` inside/near the current week and a customer in good standing (not credit-hold) to keep the flow clean.
- **≥1 `scheduled` WO** (steps still `pending`) **plus one pre-existing `planned` `ScheduleBlock`** referencing it, with `day` inside the current week (Jun 29 – Jul 3, 2026) and a real `equipmentId` — makes the board non-empty on load and demonstrates Move/Unassign.
- Seed `scheduleBlocks: ScheduleBlock[]` (fixed timestamps + `version: 0`, ids `sb-*`, `state: "planned"`); their `day` values are Mon–Fri dates of the `DEMO_NOW` week (Jun 29 – Jul 3, 2026). Return them from `buildSeed()`. No counter entry (blocks aren't numbered).
- **Do not disturb** the `in_process` / `ready_to_ship` / `on_hold` / shipped WOs, invoices, certs, or the Q→O→I / tracking / shop-floor E2E happy paths. Fix any dashboard/seed/repo tests whose counts shift from the two new orders (e.g. open-order / late tallies), asserting the corrected numbers.

---

## 13. Build sequence (high level — detailed plan via writing-plans)
1. Domain + clock: `lib/clock.ts` (`DEMO_NOW`/`nowIso`) with `lib/data/mock/store.ts` re-pointing `NOW` at it (value unchanged); `SCHEDULE_BLOCK_STATES` + `scheduleBlockStateMeta` + `scheduleBlockSchema`/type; `schedule_loads` permission; `scheduled → received` transition edge. Export via `lib/domain/index.ts`.
2. Repository: `scheduleBlocks` interface + mock Collection + factory wiring; repo test (create/update/version-conflict).
3. Pure logic (tests first): `weekDays`, `unscheduledOrders`, `scheduleCells`, `scheduleSummary`, `assignPatch`/`unschedulePatch`/`movePatch`.
4. Hooks (tests where they carry logic): `useScheduleBlocks`, `useAssignSchedule`, `useMoveSchedule`, `useUnschedule` + keys.
5. Seed: add received WO + scheduled WO + planned block; fix affected seed/dashboard tests.
6. Components (RTL tests): `ScheduleBoard` + `ScheduleCell` + `AssignDialog` + `UnscheduledQueue` — cell variants, grid, queue, gating, dialogs, loading/error/empty.
7. Page: `app/(app)/schedule/page.tsx` — replace placeholder; wire queries + mutations + `asOf` + `useCan`.
8. E2E `tests/e2e/schedule.spec.ts` (happy path).
9. Whole-branch adversarial review; address findings; PR (verify check required by branch protection).

---

## 14. Deferred-item ledger (post-Plan-6)

**Resolved by Plan 6:** the weekly equipment-load **Schedule** board; the `/schedule` placeholder retired; the `scheduled` `OrderStatus` reactivated (now has a producer); `ScheduleBlock` realized as a **WO-linked repo entity** with optimistic-concurrency updates.

**Still deferred:**
- **Backend atomicity** — the deferred multi-aggregate transaction item now also covers **assign** (WO update + block create) and **unschedule** (block cancel + WO revert), joining win-saga, ship+invoice, and inspect-pass→cert-release. Ordered version-checked writes minimize orphan risk; wrap in a DB transaction (or add a compensating primitive) when Postgres lands. The mock repo still has **no delete/transaction primitive** — unassign is soft-cancel by design.
- **Week navigation**, **capacity/hours**, furnace availability windows; **multi-block / multi-day** routing for one WO; **drag-and-drop**; **free-standing** planning blocks (label/sub/kind, no WO) — all out of this slice.
- Real **`Equipment`** repository entity; persisted per-furnace **down/maintenance** state (+ pyrometry / AMS-2750 TUS-SAT redesign, `CAR`s); real furnace **telemetry** (live temp/countdown/SCADA/SSI, genuine setpoint-deviation Alarm) — Shop Floor still shows derived setpoint + running-only est-finish.
- **Partial shipments**; typed **`TrackingEvent`** log / shop-wide scan feed.
- **"Superseded" QuoteStatus** (Plan-3 carry-forward) — still a product decision.
- **Expected-vs-actual** overlay relating Schedule (planned) to Shop Floor (live) — deliberately independent this slice.
- Pre-existing minors carried from Plan-2/3/4/5 memory (`parseNetDays` discount-terms, broad `useUpdateQuote` patch type, `numbers.next` guard, `useCustomer("")` null query, Documents entity) — unchanged, low-risk.

---

## 15. Assumptions & open items
- App name **HeatSynQ**; demo shop **Heritage Heat Treat** (unchanged).
- The `EQUIPMENT` roster (10 units) from Plan 5 is reused verbatim as the board's rows; no roster change.
- The board shows a **single current week** (Mon–Fri) anchored to the fixed mock clock; week navigation is a later slice.
- A WorkOrder has **one active `planned` block**; the board and logic tolerate (but do not expect) same-cell collisions deterministically.
- Schedule **view** is ungated; **assign/move/unassign** require `schedule_loads` (`manager`/`office`).
- All Plan-6 locked decisions in §2 stand unless changed.

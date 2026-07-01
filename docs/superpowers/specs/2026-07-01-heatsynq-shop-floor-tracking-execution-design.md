# HeatSynQ — Shop-Floor Execution & Tracking (Design Spec)

**Date:** 2026-07-01
**Status:** Approved (design); ready for implementation planning
**Repo:** https://github.com/CoJoA13/HeatSynQ.git
**Plan:** 4 (Shop-Floor & Tracking execution)
**Builds on:** Plans 1–3 (Foundation, Data-driven screens, Quote→Order→Invoice), all merged to `main`.
**Grounded reference:** [`../reference/2026-06-30-heatsynq-grounded-reference.md`](../reference/2026-06-30-heatsynq-grounded-reference.md) (design tokens, full data model, glossary, screen inventory — mined from the prototype). The ⬜ later-slice entities `OrderStep`, `Equipment`, `Area`, `TrackingEvent`, `ScheduleBlock` live in §2 there.
**Prior spec (conventions):** [`2026-06-30-heatsynq-foundation-quote-order-invoice-design.md`](./2026-06-30-heatsynq-foundation-quote-order-invoice-design.md).

---

## 1. Overview

Plans 1–3 delivered the app foundation and the Quote → Order → Invoice slice. The `WorkOrder` already carries a **read-only** traveler snapshot (`steps: ProcessStep[]`), a hardcoded `progressPct: 0`, an `activity[]` feed, and header status transitions driven **manually** by buttons on Order Detail. Ship is cert-gated.

This spec makes production **execution** real: the traveler becomes live (per-step track-in / track-out scans driving each step's state), step state rolls up into the `WorkOrder` header status and progress, an inspection step drives cert release, and a **Tracking kanban board** projects every open order onto shop stages.

This resolves the Plan-3 carry-forward "Tracking will want the traveler/OrderStep execution the Q→O→I slice stubbed," and the **credit-hold shipment block** deferred from the foundation spec.

### Product framing (unchanged)
- Visual Shop is reference only (domain, terminology). HeatSynQ is its own product/data-model/UX.
- Frontend-first on a typed mock data layer behind async repository interfaces; backend-ready seams preserved.

---

## 2. Decisions locked (from brainstorming, 2026-07-01)

| Decision | Choice |
|---|---|
| **Plan-4 scope** | **Execution + Tracking only.** Live traveler execution + the Tracking kanban board. Shop Floor grid and Schedule board are separate later plans. |
| **Status rollup** | **Tracking drives forward status + progress; holds stay manual.** First track-in → In Process; all steps tracked-out → Ready to ship; `progressPct = done/total`. On Hold / Resume and Ship stay manual. |
| **Data-model boundary** | **Embedded on `WorkOrder`.** `steps` becomes `OrderStep[]` carrying live state; scans append to the WO. Track-in/out = one version-checked `workOrders.update`. No new repos, no new cross-aggregate transaction. |
| **Kanban model** | **Ordered `Area` config set**, area assigned per step. A WO card sits in the column of its current active step's area. Routes vary by recipe because area is per-step, not per-board. |
| **Area sequence** | `received → rack → in_process → wash → final_inspect → available_to_ship → shipped` (Wash is **post-process**, per shop correction). |
| **Partial shipment** | **Deferred.** Whole-WO ship only; `shipped` = Complete. Per-line ship qty / multiple invoices per WO / Shipped-Partial is a later plan. |
| **Board interaction** | **Scan-driven.** Track In / Track Out quick actions on the card; full control on Order Detail. No drag-drop (jsdom-safe, single source of truth). |
| **Inspection** | **Wire pass/fail.** Track-out of an inspect step prompts Pass/Fail. Pass → auto-release the WO's cert (if required); Fail → WO On Hold. Manual cert Release stays a manager override. |
| **Credit hold** | **Enforce the shipment block now** (customer Hold blocks Ship). Companion guard: block order creation when winning a quote for a Hold customer. Resolves the deferred credit-hold carry-forward. |
| **Manual forward buttons** | **Removed** from Order Detail (Received→…→Ready to ship now driven by the traveler). Keep On Hold / Resume, Ship (gated), manual cert Release. |
| **Scheduled status** | Bypassed until the Schedule plan — first track-in goes Received → In Process directly. |
| **Permissions** | Any authenticated operator may track-in/out and record an inspection result (attributed to them). Manual cert Release stays manager-only; pass-driven auto-release is a system action. |
| **`Area` / `TrackingEvent`** | `Area` = static ordered config (like nav / status metas), **not** a repo. Scan events are realized as `activity[]` entries + per-step timestamps; a typed `TrackingEvent` log is a later enhancement. |

---

## 3. Scope

### In scope (build now)
- **`OrderStep` live state** embedded on `WorkOrder`; `Area` config; `areaForOp` mapper.
- **Pure execution logic:** step track-in/out state machine, status rollup, progress, inspect pass/fail, credit-hold ship block.
- **Mutations:** track-in, track-out (with inspect result), inspect-pass cert auto-release, inspect-fail hold; credit-hold guards.
- **Order Detail traveler** upgraded to a live, actionable traveler; manual forward-status buttons removed.
- **Tracking board** (`/tracking`) replacing the placeholder: Area-lane kanban with per-card quick track actions and LATE flags.
- **Seed** updates: per-step areas; a mid-execution order; a Hold-customer order.
- **E2E:** update the Q→O→I happy path to ship via the traveler; add a Tracking board E2E.

### Out of scope (this plan)
- **Shop Floor** equipment grid and the **`Equipment`** entity (+ live furnace status/telemetry). Later plan.
- **Schedule** weekly equipment-load board and the **`ScheduleBlock`** entity. Later plan.
- **Partial shipments** (per-line ship qty, multiple invoices per WO, Shipped-Partial state).
- Typed **`TrackingEvent`** entity / shop-wide scan feed (activity entries suffice for the slice).
- Real backend/DB, real atomic transactions (the win/ship/inspect-release atomicity remains the documented backend item), real auth.
- Standards / Reports / Setup beyond their existing placeholders.

---

## 4. Architecture & stack

Unchanged from the foundation spec: Next.js (App Router) + TypeScript; Tailwind v4 + shadcn/ui; TanStack Query v5 against repository interfaces; Zod domain models; Vitest + RTL; Playwright E2E. Locked conventions still in force:

- UI depends only on async repository interfaces via Query hooks.
- Money = integer cents (`formatMoney`); dates = ISO midnight-UTC (`formatDate`, `timeZone: "UTC"`).
- IBM Plex Mono for ids/numbers/pills; exact design tokens.
- `any` confined to the two approved mock-plumbing signatures.
- Every entity carries `id, createdAt, updatedAt, version`; every `update` is version-checked (optimistic concurrency).
- Pure domain logic in `lib/logic/*`; domain types + Zod in `lib/domain/*`; mock repos + seed in `lib/data/*`; hooks in `lib/query/*`; pattern + shell components in `components/*`.
- Presentational components pure; `page.tsx` thin glue; Next 16 dynamic routes via `use(params)`; permissions via authenticated `operator.role` / `useCan`, never `viewAs`.

**New-entity/atomicity note:** because `OrderStep` is embedded on `WorkOrder`, every scan is a single version-checked `workOrders.update` — no new atomicity gap. The one two-aggregate path is **inspect-pass → cert release** (WO update then cert release), which reuses the exact ordering already used by `useShipOrder` (update WO first, then the dependent write). True all-or-nothing rollback still belongs to the eventual Postgres backend and stays on the deferred ledger (§13).

---

## 5. Data model changes (`lib/domain`)

### 5.1 `OrderStep` (replaces `ProcessStep` on `WorkOrder.steps`)
`ProcessStep` today: `n, op, equip, instr, params[], track`. Two additions and one new schema:

- **`ProcessStep` gains `areaId: AreaId`** — so a recipe's carried traveler already knows each step's area. Seed assigns it (default via `areaForOp`, override per recipe).
- **`OrderStep` = `ProcessStep` + live state:**
  - `state: OrderStepState` — `"pending" | "in_process" | "done"`.
  - `operatorId: string | null`, `operatorInitials: string | null` — who last acted.
  - `trackedInAt: string | null`, `trackedOutAt: string | null` — ISO stamps.
  - `inspectResult: "pass" | "fail" | null` — only set on `track:"inspect"` steps.
- `WorkOrder.steps` type changes `ProcessStep[]` → `OrderStep[]`. `createOrderFromQuote` initializes each to `{ state:"pending", operatorId:null, operatorInitials:null, trackedInAt:null, trackedOutAt:null, inspectResult:null }` with `areaId` carried from the process master step.

### 5.2 `Area` (static config, not a repo)
In `lib/domain/enums.ts` (alongside the status metas):

```ts
export const AREAS = ["received","rack","in_process","wash","final_inspect","available_to_ship","shipped"] as const;
export type AreaId = (typeof AREAS)[number];
export const areaMeta: Record<AreaId, { label: string; tone: StatusTone }> = { … };
```

`areaForOp(op: string): AreaId` — pure mapper (in `lib/logic/tracking.ts`) giving a sensible default from an op name (e.g. `/wash/i → wash`, `/inspect/i → final_inspect`, `/receiv/i → received`, `/rack/i → rack`, thermal ops → `in_process`, `/cert|ship/i → available_to_ship`), with an `in_process` fallback so no op is unmapped.

### 5.3 New enum
`ORDER_STEP_STATES = ["pending","in_process","done"]`; `orderStepStateMeta` for pill/icon tone.

No other entity changes. No new repository interfaces. `Equipment`, `Area`-as-entity, `ScheduleBlock`, `TrackingEvent` remain ⬜.

---

## 6. Business rules & state machines (pure functions)

### 6.1 Step state machine (`lib/logic/tracking.ts`)
Three states: `pending → in_process → done`. The step's `track` point decides which scans the UI offers and how many complete it — but the state set and the pure functions are uniform:

- `trackInStep(steps, n, actor, nowIso)` → step `n` `pending → in_process`, stamps `trackedInAt` + operator. Guard: must be `pending`.
- `trackOutStep(steps, n, actor, nowIso, inspectResult?)` → step `n` `→ done`, stamps `trackedOutAt` + operator; records `inspectResult` on `track:"inspect"` steps. Guard: must be `in_process` **or** `pending` (single-scan steps skip `in_process`).
- Both pure; the hook supplies `actor` (current operator) + `nowIso`.

Per `track` point (UI behavior over the same functions):
- `track_in_out` → **Track In** then **Track Out** (two scans; `pending → in_process → done`).
- `track_in` / `track_out` → **one** button; the single scan completes the step (`pending → done` via `trackOutStep`).
- `inspect` → one **Track Out** with **Pass / Fail** (`pending → done` on pass; Fail → order `on_hold`, step keeps `inspectResult:"fail"`, not `done`).
- `none` → no scan; **informational only** — excluded from the actionable "current step" and from the progress/rollup denominator (see §6.2).

### 6.2 Status rollup (`lib/logic/order.ts`, forward-only)
`rollUpOrderStatus(steps, current): OrderStatus` — over **trackable** steps only (`track !== "none"`):
- `current === "on_hold"` → unchanged (holds are manual; resume is manual).
- any trackable step `in_process`/`done`, not all trackable steps `done`, and `current ∈ {received, scheduled}` → `in_process`.
- all trackable steps `done` → `ready_to_ship`.
- `current ∈ {ready_to_ship, shipped}` → unchanged (ship is manual).
- otherwise unchanged.

Never returns `on_hold` or `shipped`. `orderProgressPct(steps) = round(doneTrackable / totalTrackable * 100)` (0 when no trackable steps).

### 6.3 Inspection
Track-out of a `track:"inspect"` step:
- `pass` → step `done`; if the WO's cert is required and `pending`, fire the cert-release path (unblocks ship); activity "Final inspect passed — cert C-#### released".
- `fail` → WO → `on_hold`; step recorded `inspectResult:"fail"` but **not** `done`; activity "Final inspect failed — order on hold". Resume + re-inspect is the manual recovery path.

### 6.4 Ship gate + credit hold (`lib/logic/order.ts`)
Extend `canShipOrder(order, cert, customer)`:
- `customer.status === "hold"` → `{ ok:false, reason:"Customer on credit hold — shipment blocked" }` (checked first).
- then the existing cert rule: cert-required orders need a Released cert.
Companion: `useWinQuote` blocks order creation when the customer is Hold (`"Customer on credit hold — cannot create order"`); quoting stays allowed (foundation-spec default).

### 6.5 Order lifecycle after Plan 4
```
received --first track-in--> in_process --all steps done--> ready_to_ship --Ship (gated)--> shipped
any --On Hold (manual)--> on_hold --Resume (manual)--> (recomputed)
final_inspect track-out fail --> on_hold
```
`scheduled` is not produced by the flow this plan (Schedule plan reintroduces it). `ORDER_TRANSITIONS` still governs the manual `on_hold`/resume/ship edges.

---

## 7. Mutations (`lib/query/hooks.ts`)

All version-checked `workOrders.update`, invalidating `workOrder(id)` + `workOrders` (+ `certifications` where relevant):

- **`useTrackInStep({ order, stepN, operator })`** — `trackInStep` → recompute status + progress → append activity → update.
- **`useTrackOutStep({ order, stepN, operator, inspectResult? })`** — `trackOutStep` → recompute status + progress → append activity → update; on inspect **pass** with a required pending cert, then release the cert (reusing `useReleaseCertification`'s repo call: update WO first, then cert — same ordering as ship); on inspect **fail**, set status `on_hold`.
- **Order Detail wiring:** remove the manual forward-transition buttons; keep On Hold / Resume (via `useTransitionOrder`), Ship (`useShipOrder`, now also credit-hold gated), and manual cert Release (`useReleaseCertification`, manager). Track In / Track Out live on each active traveler step.

`useShipOrder` and `useWinQuote` gain the customer argument needed for the credit-hold checks.

---

## 8. Screens

### 8.1 Order Detail traveler (upgrade `components/orders/order-detail.tsx`)
Each step renders its live state: `pending` (neutral), `in_process` (◉ + operator + track-in time), `done` (✓ + operator + track-out time). The current actionable step shows **Track In** or **Track Out**; an inspect step's Track Out prompts **Pass / Fail**. Progress bar reflects `progressPct`. Manual forward buttons gone; On Hold / Resume / Ship / cert Release remain.

### 8.2 Tracking board (`/tracking`, `components/tracking/tracking-board.tsx`)
Replaces the placeholder. Columns = the ordered `Area` set. Each open WO is a card in the column of its **current active step's area** (a WO with no started steps sits in `received`; a fully-done WO in `available_to_ship`; a shipped WO in `shipped`). Card shows: WO# (mono), customer, part/summary, current op, a **LATE** pill when past due and not shipped (reuse `isLate`), and **Track In / Track Out** quick actions that advance the same step state. Loading skeleton, error panel + retry, empty state — consistent with existing list screens. Non-drag.

Nav: `nav-config.ts` already lists Tracking; only the page swaps from placeholder to real.

---

## 9. Seed data (`lib/data/seed`)
- Stamp `areaId` on every process-master step (via `areaForOp`, overriding where a recipe's real routing differs).
- Ensure ≥1 work order mid-execution (a couple of steps `done`, one `in_process`) so the board shows movement, plus orders at `received` and `ready_to_ship`.
- Keep a Hold-customer order (e.g. Vulcan Forge) that reaches `ready_to_ship` to demo the credit-hold ship block.
- Existing seed invoices/certs stay consistent (the Q→O→I E2E order remains billable).

---

## 10. States, validation, errors
Unchanged patterns: Query `isLoading` skeletons from simulated latency; recoverable `ErrorPanel` with retry (mock fault injection); `EmptyState` for empty boards; guarded, disabled-until-valid actions. Track actions disable while a mutation is in flight (`busy`) and after a step reaches a terminal state.

---

## 11. Testing strategy (TDD where it counts)
- **Unit (Vitest, tests first):** `areaForOp` mapping + fallback; `trackInStep`/`trackOutStep` transitions + guards; `rollUpOrderStatus` (received→in_process, all-done→ready_to_ship, hold/shipped invariants); `orderProgressPct`; inspect pass (cert release path) / fail (hold); `canShipOrder` credit-hold + cert combinations.
- **Component (RTL):** Order Detail traveler — track-in/out advance state + stamps, inspect Pass/Fail prompt, manual buttons absent; Tracking board — card lands in correct area, LATE pill, quick actions call the right mutation, empty/loading/error.
- **E2E (Playwright):**
  - **Update** `tests/e2e/quote-to-invoice.spec.ts` so the order reaches Shipped via the traveler (track every step → inspect Pass → cert auto-releases → Ready to ship → Ship → bill → Sent → A/R), matching the new ship gate.
  - **Add** `tests/e2e/tracking.spec.ts` proving a card advances across Area columns via the card's quick track actions (in-app nav only; the mock store resets on full reload).

**Gate (must stay green):** `npm test` · `tsc --noEmit` · `eslint --max-warnings 0` · `next build` · `test:e2e`.

---

## 12. Build sequence (high level — detailed plan via writing-plans)
1. `Area` config + `orderStepStateMeta` enum + `areaForOp` (unit tests first).
2. `OrderStep` domain type + Zod; migrate `WorkOrder.steps` and `ProcessStep.areaId`; update `createOrderFromQuote` to emit live `OrderStep`s.
3. Pure logic: step state machine, `rollUpOrderStatus`, `orderProgressPct`, inspect pass/fail, `canShipOrder` credit-hold (tests first).
4. Seed: per-step areas, mid-execution order, Hold-customer ready-to-ship order; fix repo/seed tests.
5. Mutations: `useTrackInStep`, `useTrackOutStep`, inspect auto-release / fail-hold; credit-hold in `useShipOrder`/`useWinQuote`.
6. Order Detail traveler upgrade; remove manual forward buttons.
7. Tracking board component + route (replace placeholder).
8. E2E: update Q→O→I path; add tracking spec.
9. Whole-branch adversarial review; PR (verify check required by branch protection).

---

## 13. Deferred-item ledger (post-Plan-4)
**Resolved by Plan 4:** traveler/`OrderStep` execution; credit-hold **shipment** block (+ order-creation block on win).

**Still deferred:**
- **Atomicity** of win / ship / inspect-pass-release — mock repo has no delete/transaction primitive; belongs to the Postgres backend (single transaction) or a compensating-delete repo primitive. Version-check-first ordering prevents the common stale-row orphan.
- **"Superseded" QuoteStatus** — Quote-only; not touched by Plan 4; still a product decision (new status vs accept `lost`) with `useReviseQuote` retiring the original.
- **Shop Floor** grid + **`Equipment`** entity + furnace status/telemetry — its own plan.
- **Schedule** weekly-load board + **`ScheduleBlock`** entity — its own plan.
- **Partial shipments** — per-line ship qty, multiple invoices per WO, Shipped-Partial state, kanban Shipped-Partial label.
- **Typed `TrackingEvent`** log / shop-wide scan feed (activity entries + step stamps suffice for now).
- Pre-existing minors carried from Plan 3 memory (`parseNetDays` discount-terms, broad `useUpdateQuote` patch type, `numbers.next` guard, `useCustomer("")` null query, Documents entity) — unchanged, low-risk.

---

## 14. Assumptions & open items
- App name **HeatSynQ**; demo shop **Heritage Heat Treat** (unchanged).
- Any authenticated operator can track; no new "floor" role added this plan.
- `scheduled` status is dormant until the Schedule plan.
- All Plan-4 locked decisions in §2 stand unless changed.

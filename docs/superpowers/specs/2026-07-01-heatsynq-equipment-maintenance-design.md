# HeatSynQ Plan 8 — Equipment & Maintenance (design)

Date: 2026-07-01
Status: approved in brainstorming (all 8 sections user-approved; §5 story units corrected against seed facts per its verify-at-implementation clause)
Reference: `docs/superpowers/reference/2026-06-30-heatsynq-grounded-reference.md` (Maintenance §2 line 217, CAR/Q18 line 441, Equipment line 211)
Prior specs: Plan 5 `2026-07-01-heatsynq-shop-floor-equipment-design.md` (static roster + honest telemetry), Plan 6 `2026-07-01-heatsynq-schedule-design.md` (ScheduleBlock, string FK), Plan 7 `2026-07-01-heatsynq-certifications-standards-design.md` (`isReviewDue` precedent).

## 1. Overview

Plan 8 promotes the Plan-5 static `EQUIPMENT` config into a **real seeded WriteRepo entity** with one persisted operational field (`availability`), and adds the reference's redesign-only **Maintenance** entity as an AMS-2750 pyrometry schedule (`tus`/`sat` rows per furnace) with a mark-complete write. Everything else stays derived at read: running/idle/on_hold remain pure projections over WorkOrder steps (Plan-5 rule), due/overdue remains a pure function of `nextDueAt` vs an `asOf` the page passes (Plan-7 rule). The honest-telemetry rule holds: **no fabricated live temperatures, countdowns, or alarms.**

User rulings (brainstorming):
1. **Screen home:** extend Shop Floor — new `/shop-floor/[equipmentId]` detail; no new nav item (Q18 main-nav ruling holds).
2. **State model:** persist ONE field `availability: available | down | maintenance` (+ nullable note); display state = availability wins when not available, else derived.
3. **Maintenance model:** WriteRepo, one row per equipment×type; mark-complete = single version-checked update rolling `lastDoneAt`/`nextDueAt` forward. No history log.
4. **Permission:** new `maintain_equipment: ["manager","office"]` gates both writes.
5. **Schedule reaction:** UI-filter + flag (dialogs list available units only; row chips; no hook-level guard).
6. **CARs:** deferred again (Q18).
7. **Migration:** full promotion — roster data moves to seed; `EQUIPMENT` const and `EquipmentId`/`EquipmentDef` types deleted; equipmentId is `string` everywhere.

## 2. Decision table

| Decision | Ruling |
|---|---|
| Equipment data home | **Seeded WriteRepo** (`equipment: WriteRepo<Equipment>`). Crosses tier 1→3 (static config → WriteRepo). Seeded ids `eq-*` stable (mock update preserves ids); rows un-numbered. |
| Stored vs derived state | Stored: `availability` (+`note`). Derived: running/idle/on_hold from WO steps, LATE from `isLate`, due/overdue from `nextDueAt`. Never store a derivable value. |
| `EquipmentId` union | **Deleted.** Only `lib/logic/shop-floor.ts` needed it; its 7 fallback ids become plain string literals whose seed presence is test-pinned. FK convention already `z.string()` (ScheduleBlock precedent). |
| Roster order | Seed array order = display order (Collection Map preserves insertion order; same contract all seeded lists rely on). Current 10-unit order preserved verbatim. |
| Maintenance shape | One row per equipment×type: `{equipmentId, type: tus\|sat, specificationId → spec-ams2750, intervalDays, lastDoneAt, nextDueAt}`. Mirrors Standard's reviewedAt/nextReviewAt. |
| Mark complete | Single version-checked update: `completePatch(task, at)` → `{ lastDoneAt: floorDayUtc(at), nextDueAt: floorDayUtc(at) + intervalDays }`. No second write, no atomicity-ledger entry. |
| Availability precedence | `availability !== "available"` → tile/detail state = `down`/`maintenance` **but a tracked-in load still renders** (work is physically in the furnace — honest). Est-finish stays gated on `state === "running"`, so no forecast on a down unit. |
| Schedule gating | Assign/move dialog options = available units only; default = first available. Board row header DOWN/MAINT chip. Blocks on a non-available unit stay visible + actionable (move/unassign = recovery). No mutationFn guard (mutation errors render nowhere; stale-dialog race accepted like the deferred move race). |
| Permissions | `maintain_equipment: ["manager","office"]` (mirrors `schedule_loads`). View ungated. `edit_setup` stays reserved for the future Setup screen. |
| Clock | `/shop-floor` (+ new detail) adopts `DEMO_NOW` as `asOf` and mutation `at` (due pills must be deterministic). Today/Tracking/Invoicing/A-R stay wall-clock (out of scope). |
| CARs | Deferred (own future slice). |

## 3. Out of scope

- CARs (corrective actions) — reference Q18, deferred again.
- Live telemetry: temperatures, countdowns, SCADA/SSI, genuine setpoint-deviation Alarm. Honest-telemetry rule unchanged.
- AMS-2750 furnace-class / instrumentation-type taxonomy (reference contains none); real per-class survey intervals — `intervalDays` is a demo value.
- Maintenance history / event log (completed surveys are not archived; the row rolls forward — Standard precedent).
- Auto-flip availability from an overdue survey; auto-hold WOs when their furnace goes down (no WO side-effects at all).
- Equipment CRUD (add/retire units), Setup screen, equipment activity log.
- Hook-level schedule guard re-reading equipment (see decision table).
- DEMO_NOW adoption outside `/shop-floor`; mutation-error surfacing convention (version conflict stays a silent no-op).

## 4. Domain

`lib/domain/enums.ts`:
- **Delete** `EQUIPMENT`, `EquipmentDef`, `EquipmentId` (rows become seed data).
- Keep `EQUIPMENT_KINDS` + `equipmentKindMeta` (app vocab).
- Extend `EQUIPMENT_STATES = ["running","idle","on_hold","down","maintenance"]`; `equipmentStateMeta` adds `down: { label: "Down", tone: "danger" }`, `maintenance: { label: "Maintenance", tone: "warn" }`.
- New `EQUIPMENT_AVAILABILITY = ["available","down","maintenance"] as const` + `equipmentAvailabilityMeta` (available/neutral "Available", down/danger "Down", maintenance/warn "Maintenance").
- New `MAINTENANCE_TYPES = ["tus","sat"] as const` + `maintenanceTypeMeta: Record<MaintenanceType, { label: string }>` — `tus: "TUS"`, `sat: "SAT"` (glossary line on the detail page spells out Temperature Uniformity Survey / System Accuracy Test as static copy).

`lib/domain/entities.ts`:
```ts
export const equipmentSchema = baseEntitySchema.extend({
  name: z.string(),
  kind: z.enum(EQUIPMENT_KINDS),
  availability: z.enum(EQUIPMENT_AVAILABILITY),
  note: z.string().nullable(), // why down/maintenance; null when available
});
export type Equipment = z.infer<typeof equipmentSchema>;

export const maintenanceSchema = baseEntitySchema.extend({
  equipmentId: z.string(),      // FK equipment (z.string(), FK convention)
  type: z.enum(MAINTENANCE_TYPES),
  specificationId: z.string(),  // FK specification (spec-ams2750)
  intervalDays: z.number().int().positive(),
  lastDoneAt: z.string(),       // ISO midnight-UTC
  nextDueAt: z.string(),        // ISO midnight-UTC
});
export type Maintenance = z.infer<typeof maintenanceSchema>;
```

## 5. Pure logic

New `lib/logic/maintenance.ts`:
- `isMaintenanceDue(task: Maintenance, asOf: string): boolean` — `nextDueAt <= asOf` via `Date.getTime` (boundary instant counts as due; exact Plan-7 `isReviewDue` semantics).
- `dueMaintenance(tasks, asOf): Maintenance[]` — filtered + sorted by `nextDueAt` asc.
- `maintenanceForEquipment(tasks, equipmentId): Maintenance[]` — sorted by `nextDueAt` asc.
- `completePatch(task, atIso): { lastDoneAt: string; nextDueAt: string }` — floors `atIso` to midnight-UTC, adds `intervalDays` days (UTC arithmetic, no `Date.now()`).

`lib/logic/shop-floor.ts` changes:
- `equipmentForStep(step, equipment: Equipment[]): string` — same exact-name → keyword heuristic → `"eq-iq-1"` fallback; the 7 fallback ids stay as string literals (seed-pinned).
- `equipmentLoads(orders, equipment: Equipment[], asOf): EquipmentLoad[]` — iterates the given rows in list order. Per unit: candidates/current/queued as today; then `state = eq.availability !== "available" ? eq.availability : (derived running/idle/on_hold)`. Load object still populated when a candidate exists regardless of availability; `estFinishIso` gate unchanged (`state === "running"`).
- `EquipmentLoad.equipmentId: string`; `shopFloorSummary(loads)` adds `outOfService` (count of state down|maintenance).

`lib/logic/schedule.ts` changes:
- Module-level `EQUIP_BY_ID` deleted.
- `assignPatch(order, equipment: Pick<Equipment, "id" | "name">, day, actor, at)` — block gets `equipmentId: equipment.id`; activity message `` `Scheduled — ${equipment.name} · ${weekDayLabel(day)}` `` (unchanged output; the raw-id fallback disappears because callers now pass the selected unit).
- `movePatch`, `unschedulePatch`, `scheduleCells`, `weekDays`, `unscheduledOrders`, `scheduleSummary` untouched.

## 6. Repositories, mock, seed

`lib/data/repositories/index.ts`: add `equipment: WriteRepo<Equipment>; maintenance: WriteRepo<Maintenance>;` (no custom finders — lists are small, logic filters).

Mock: `cols.equipment = new Collection(seed.equipment)`, `cols.maintenance = new Collection(seed.maintenance)`; wiring `equipment: write(cols.equipment)`, `maintenance: write(cols.maintenance)` (un-keyed → no auto-number; runtime creates unused). No `numberPrefix` entries, no counters.

Seed (`lib/data/seed/index.ts`), new arrays + `buildSeed()` keys:
- `equipment`: the 10 current roster rows verbatim (ids/names/kinds/order), `...meta`, plus:
  - `eq-temper-2`: `availability: "down"`, `note: "Setpoint deviation +18°F — control board fault"` (coheres with wo-48142 activity "On hold — Temper Oven #2 alarm (+18°F)"; unit has no in-process load — temper steps are pending).
  - `eq-vac-1`: `availability: "maintenance"`, `note: "SAT in progress — system accuracy test"` (no in-process load; wo-48205's vacuum step is done).
  - Other 8: `availability: "available"`, `note: null`.
- `maintenance`: 16 rows — `tus` + `sat` for the 8 thermal units (`eq-iq-1/2/3`, `eq-temper-1/2`, `eq-vac-1`, `eq-pit-1`, `eq-belt-1`); wash/inspect excluded (not temperature-processing). All `specificationId: "spec-ams2750"`. `intervalDays`: tus 90, sat 30 (demo values). Ids `mnt-<unit-suffix>-<type>`, e.g. `mnt-iq-3-tus`, `mnt-vac-1-sat`.
- Due story vs `DEMO_NOW` (2026-06-30) — **exactly two due rows**:
  - `mnt-iq-3-tus` `nextDueAt: "2026-06-25T00:00:00.000Z"` — **overdue** on an available, loaded unit (eq-iq-3 holds wo-48142's in-process Neutral-harden step, order on_hold) → the compliance red-flag story feeding the Pyrometry-due KPI.
  - `mnt-vac-1-sat` `nextDueAt: "2026-06-30T00:00:00.000Z"` — **due today** (pins the boundary-counts-as-due semantics) on the unit that is in maintenance → the e2e mark-complete story.
  - All other `nextDueAt` in July–Sept 2026; `lastDoneAt` = `nextDueAt − intervalDays`.
- **No WorkOrder/quote/cert changes** → `q3-o9-c3` badge pin and Plan-7 seed stories untouched.

Seed-state tile picture (for test/e2e grounding): running = eq-wash-1 (WO-48211) + eq-pit-1 (WO-48190, LATE); on_hold = eq-iq-3 (WO-48142); down = eq-temper-2; maintenance = eq-vac-1; idle = 5.

## 7. Permissions & writes

`lib/auth/permissions.ts`: `maintain_equipment: ["manager", "office"]`.

`lib/query/keys.ts`: `equipment: ["equipment"]`, `equipmentUnit: (id) => ["equipment", id]`, `maintenance: ["maintenance"]`.

`lib/query/hooks.ts`:
- Reads: `useEquipment()`, `useEquipmentUnit(id)` (detail key, prefix-invalidated), `useMaintenance()`.
- `useSetEquipmentAvailability()` — vars `{ equipment: Equipment; availability: EquipmentAvailability; note: string | null }` → `r.equipment.update(equipment.id, { availability, note }, equipment.version)`; onSuccess invalidates `queryKeys.equipment` (prefix covers detail).
- `useCompleteMaintenance()` — vars `{ task: Maintenance; at: string }` → `r.maintenance.update(task.id, completePatch(task, at), task.version)`; invalidates `queryKeys.maintenance`.
- Both single-aggregate, version-checked; failed mutation = silent no-op after busy clears (existing convention).
- `useAssignSchedule` vars change: `equipmentId: string` → `equipment: Equipment` (mutationFn passes it to the new `assignPatch` signature; write ordering — WO first, then block — unchanged). `useMoveSchedule`/`useUnschedule` untouched.

## 8. Screens

### 8.1 `/shop-floor` (changed)
- Queries: `useWorkOrders` + `useCustomers` + `useEquipment` + `useMaintenance` — 4-query skeleton/error guards.
- `asOf = DEMO_NOW` (was wall clock).
- KPI strip: Running, Idle, On hold, Late + **Out of service** (tone warn) + **Pyrometry due** (`dueMaintenance(tasks, asOf).length`, tone danger when > 0).
- Tiles: availability pill (DOWN danger / MAINTENANCE warn) + note line when not available; load block renders as today when present.
- **Every tile is a button → `router.push(\`/shop-floor/${equipmentId}\`)`** (uniform, idle/down tiles included; the loaded-tile → order drill moves into the detail page).

### 8.2 `/shop-floor/[equipmentId]` (new)
Next 16 client page, `params: Promise<{ equipmentId: string }>` via `use(params)` (read `node_modules/next/dist/docs/` before writing — AGENTS.md). Guards: skeleton → ErrorPanel(+refetch) → EmptyState "Equipment not found".
- **Header**: name (MonoId-style id shown small), kind label, state pill (same derivation as its tile: availability-first).
- **Current load** card: WO number → Link `/orders/{id}`, customer, op, progress bar, operator initials, setpoint, est finish (running only), `+N queued`. EmptyState when idle.
- **Availability control** (visible only with `maintain_equipment`):
  - available → "Mark down" / "Start maintenance" buttons, each opens a small dialog (radix Dialog + native inputs, AssignDialog remount-on-`open` key pattern) with required note textarea → `useSetEquipmentAvailability`.
  - down/maintenance → note shown + "Return to service" via `ConfirmDialog` → availability `available`, note `null`.
- **Pyrometry (AMS 2750)** table: per row — type pill (TUS/SAT), spec code (resolved from `useSpecifications()`), interval, last done, next due + **Overdue/Due pill** when `isMaintenanceDue(row, DEMO_NOW)`, "Mark complete" button (permission-gated) → ConfirmDialog → `useCompleteMaintenance` with `at = DEMO_NOW`. Static glossary line under the table (TUS/SAT expansions). Wash/inspect: EmptyState "No pyrometry schedule".

### 8.3 `/schedule` (changed)
- Adds `useEquipment()` → 4th loading/error guard.
- `ScheduleBoard` + `AssignDialog` take `equipment: Equipment[]` prop (static import removed). Row header: DOWN/MAINT chip via `equipmentAvailabilityMeta` when not available. Dialog options: `equipment.filter(e => e.availability === "available")`; default selection = first available. `onAssign`/`useAssignSchedule` vars carry the selected `Equipment` (name feeds the activity message).
- Cells/blocks logic unchanged; blocks on non-available rows stay actionable.

## 9. Components

- `components/shop-floor/equipment-tile.tsx` — prop type `Equipment` (was `EquipmentDef`); availability pill + note branch; whole tile a single `<button>` (no nested buttons).
- `components/shop-floor/shop-floor-grid.tsx` — takes `equipment`, `maintenance` props; passes to `equipmentLoads`/KPIs; `onSelect(equipmentId)`.
- New `components/shop-floor/equipment-detail.tsx` (+ small `availability-dialog.tsx` if extracted) and `components/shop-floor/pyrometry-table.tsx` — presentational, ListCard/DetailHeader/SummaryRail primitives, MonoId for ids/dates, exact tokens.
- `components/schedule/schedule-board.tsx`, `assign-dialog.tsx` — `equipment` prop, filter, chips (per §8.3).

## 10. Testing

Unit/component (TDD per task):
- Schema: equipment/maintenance parse + reject (bad kind, bad availability, negative interval).
- `maintenance.ts`: boundary due (before/on/after), `completePatch` rolls dates from a mid-day `at` to midnight-UTC + interval, `dueMaintenance` sort.
- `shop-floor.ts`: availability precedence (down + tracked-in candidate → state down, load present, `estFinishIso` null; maintenance + no candidate → state maintenance; available unchanged running/idle/on_hold); `equipmentForStep` with injected roster; `shopFloorSummary.outOfService`.
- `schedule.ts`: `assignPatch` new signature pins message `"Scheduled — Batch IQ #2 · Wed 7/1"`.
- Seed: zod lines for both arrays; FKs — `maintenance.equipmentId` ∈ seed.equipment, `scheduleBlocks.equipmentId` ∈ seed.equipment (replaces EQUIPMENT check), `maintenance.specificationId` ∈ specifications; the 7 heuristic-fallback ids present in seed.equipment; story pins — exactly two `isMaintenanceDue` rows (`mnt-iq-3-tus`, `mnt-vac-1-sat`), eq-temper-2 down / eq-vac-1 maintenance / others available.
- Hooks: both mutations happy-path + stale-version rejection + invalidation keys.
- Components: tile pill/note/click; grid KPI counts incl. new tiles; detail page sections, permission hiding, not-found; assign-dialog excludes non-available + default first available; board row chip.
- Pages: 4-query guard branches (shop-floor, schedule), detail guards.
- Migrations: `lib/domain/equipment.test.ts` → seed-roster invariants (unique ids/names, kinds covered, availability values); shop-floor/schedule tests gain equipment fixtures; pinned counts updated (grid Idle, summary numbers reflect 2 out-of-service units).

E2E (7 specs after):
- New `tests/e2e/equipment-maintenance.spec.ts`: `/shop-floor` → Pyrometry-due KPI visible → click `equipment-tile-eq-vac-1` (MAINTENANCE pill) → detail → SAT row Due pill → Mark complete → pill gone, next due rolls forward → Return to service → state pill leaves maintenance (Idle). Clock-independent (DEMO_NOW-anchored).
- Updated `tests/e2e/shop-floor.spec.ts`: wash tile → `/shop-floor/eq-wash-1` → current-load WO-48211 link → `/orders/wo-48211` → `order-progress`.
- `schedule.spec.ts` unaffected (eq-iq-1 available; sb-1 on eq-iq-2 available).

Gate: `npm test`, `tsc --noEmit`, `eslint --max-warnings 0`, `next build` (detail route dynamic), `test:e2e` (7 specs). No new `any`/`eslint-disable`.

## 11. Migration inventory (static → repo)

| Consumer | Change |
|---|---|
| `lib/domain/enums.ts` | delete EQUIPMENT/EquipmentDef/EquipmentId; extend states; add availability + maintenance vocab |
| `lib/logic/shop-floor.ts` | equipment param; string ids; availability precedence; summary field |
| `lib/logic/schedule.ts` | drop EQUIP_BY_ID; assignPatch takes unit |
| `components/shop-floor/*` | props/type swap; tile nav change; new detail components |
| `components/schedule/{schedule-board,assign-dialog}.tsx` | equipment prop; filter; chips |
| `app/(app)/shop-floor/page.tsx` | +2 queries; DEMO_NOW; new route dir `[equipmentId]/` |
| `app/(app)/schedule/page.tsx` | +useEquipment; prop threading; vars carry unit |
| `lib/data/{repositories,mock,seed}` | two repos, two collections, two seed arrays |
| `lib/data/seed/seed.test.ts` | FK source swap + new validations/stories |
| `lib/query/{keys,hooks}.ts` | keys, 3 reads, 2 mutations |
| `lib/auth/permissions.ts` | maintain_equipment |
| ~15 test files | mechanical fixture/signature updates (inventoried in context map) |

## 12. Error handling

Query failures: per-query `ErrorPanel` + refetch (existing pattern). Mutations: busy-disable only; version conflict throws in repo and surfaces nowhere (accepted convention, listed §3). Unknown `equipmentId` route param → EmptyState not-found. Blocks referencing a non-available unit render flagged, never dropped.

## 13. Deferred ledger (post-Plan-8)

CARs; live telemetry (SSI/SCADA temps, countdown, real Alarm); AMS-2750 class/instrumentation + real intervals; maintenance history log; overdue-survey → availability coupling; down-furnace → WO auto-hold; equipment CRUD + Setup screen; equipment activity log; hook-level schedule availability guard; DEMO_NOW on remaining wall-clock pages; Standards mark-reviewed; cert releasedBy/doc-link; partial shipments; TrackingEvent; superseded QuoteStatus; backend atomicity ledger (unchanged — Plan 8 adds no multi-aggregate writes); `inv-summit-48120` quirk.

## 14. Assumptions

- Seed order of the equipment array is the display order contract (no `sortIndex` field needed).
- `intervalDays` demo values (TUS 90 / SAT 30) are illustrative, not AMS-2750-accurate per class.
- Runtime `create` on the two new repos exists (WriteRepo) but no UI produces it this slice.
- The wo-48142 story reads: order held during Neutral harden on eq-iq-3 because its next step's oven (eq-temper-2) is down — activity string and availability note now corroborate.

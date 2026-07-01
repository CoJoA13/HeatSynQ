# HeatSynQ Schedule (Weekly Equipment-Load Board) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/schedule` placeholder with a weekly equipment-load board where a planner assigns received work orders onto a furnace and day, persisting a `ScheduleBlock` and driving the order into the `scheduled` status.

**Architecture:** A new WO-linked repository entity (`ScheduleBlock`) with optimistic-concurrency updates; pure logic projects `planned` blocks onto an `EQUIPMENT`-rows × current-Mon–Fri-week grid; three mutations (assign/move/unschedule) with ordered version-checked writes; an action-driven (native-`<select>`, jsdom-safe) board that reads the existing `useWorkOrders`/`useCustomers` plus the new `useScheduleBlocks`. A deterministic demo clock (`lib/clock.ts`) fixes the week window so seeded blocks render regardless of wall-clock.

**Tech Stack:** Next.js 16 (App Router) + TypeScript; Tailwind v4 + shadcn/ui (radix Dialog; native `<select>` for pickers); TanStack Query v5; Zod; Vitest + RTL + `@testing-library/user-event`; Playwright.

Design spec: [`docs/superpowers/specs/2026-07-01-heatsynq-schedule-design.md`](../specs/2026-07-01-heatsynq-schedule-design.md).

## Global Constraints

Every task's requirements implicitly include this section.

- **Read `node_modules/next/dist/docs/` before writing any Next-specific code** (AGENTS.md — this is a breaking-changes Next 16). Applies to Task 9 (page).
- UI depends only on async repository interfaces via Query hooks. Pure domain logic in `lib/logic/*`; domain types/config + Zod in `lib/domain/*`; hooks in `lib/query/*`; components in `components/*`; thin `page.tsx` glue.
- Money = integer cents; dates = ISO midnight-UTC. **No `Date.now()` / `new Date()` for the schedule week** — pages pass `DEMO_NOW`; logic takes `asOf`/`at` params.
- IBM Plex Mono for ids/numbers/pills (`MonoId`); exact design tokens; reuse existing pattern components.
- `any` confined to the **two** existing mock-plumbing signatures (`read<T>`/`write<T>`). **No new `any`, no new `eslint-disable`.**
- Every entity carries `id, createdAt, updatedAt, version`; **every `update` is version-checked**.
- **Gate (must stay green after every task):** `npm test` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `npm run build` · `npm run test:e2e`.
- Commit after every task (small, frequent commits). Work on branch `heatsynq-schedule` (already created; the design spec is committed there).

**Locked names** (use verbatim across tasks): `DEMO_NOW`, `nowIso`; `SCHEDULE_BLOCK_STATES`, `ScheduleBlockState`, `scheduleBlockStateMeta`, `scheduleBlockSchema`, `ScheduleBlock`; permission `schedule_loads`; repo `scheduleBlocks`; `queryKeys.scheduleBlocks`; logic `weekDays`/`WeekDay`/`weekDayLabel`/`unscheduledOrders`/`scheduleCells`/`ScheduleCell`/`scheduleSummary`/`assignPatch`/`AssignPatch`/`unschedulePatch`/`UnschedulePatch`/`movePatch`; hooks `useScheduleBlocks`/`useAssignSchedule`/`useMoveSchedule`/`useUnschedule`; components `ScheduleBoard`/`ScheduleCellCard`/`UnscheduledQueue`/`AssignDialog`; seed `wo-48230` (scheduled), `wo-48231` (received), block `sb-1`.

---

### Task 1: Deterministic demo clock

**Files:**
- Create: `lib/clock.ts`
- Create: `lib/clock.test.ts`
- Modify: `lib/data/mock/store.ts:16`

**Interfaces:**
- Produces: `DEMO_NOW: string` (= `"2026-06-30T12:00:00.000Z"`), `nowIso(): string`. Mock store's `NOW` re-points at `DEMO_NOW` (value unchanged).

- [ ] **Step 1: Write the failing test**

Create `lib/clock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DEMO_NOW, nowIso } from "./clock";
import { NOW } from "./data/mock/store";

describe("demo clock", () => {
  it("DEMO_NOW is the frozen demo instant", () => {
    expect(DEMO_NOW).toBe("2026-06-30T12:00:00.000Z");
    expect(nowIso()).toBe(DEMO_NOW);
  });
  it("mock store NOW is the single source (equals DEMO_NOW)", () => {
    expect(NOW).toBe(DEMO_NOW);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/clock.test.ts`
Expected: FAIL — `Cannot find module './clock'`.

- [ ] **Step 3: Create `lib/clock.ts`**

```ts
/**
 * The demo's canonical "now" — a frozen instant so date-derived views (the
 * Schedule week window) are deterministic and independent of the machine's
 * wall clock. The mock data layer's `NOW` re-points at this constant so there
 * is a single source of truth for "the present" across data + UI.
 */
export const DEMO_NOW = "2026-06-30T12:00:00.000Z";

export function nowIso(): string {
  return DEMO_NOW;
}
```

- [ ] **Step 4: Re-point the mock clock at `DEMO_NOW`**

In `lib/data/mock/store.ts`, replace line 16:
```ts
export const NOW = "2026-06-30T12:00:00.000Z"; // fixed mock clock (no Date.now in deterministic tests)
```
with:
```ts
import { DEMO_NOW } from "@/lib/clock";
export const NOW = DEMO_NOW; // single source of truth for the demo's frozen "now"
```
(Place the `import` at the top of the file with the other statements; keep the `export const NOW` where it was.)

- [ ] **Step 5: Run the tests and the gate**

Run: `npx vitest run lib/clock.test.ts` → PASS.
Run: `npx vitest run` → all green (value of `NOW` is unchanged, so no seed/repo test shifts).
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add lib/clock.ts lib/clock.test.ts lib/data/mock/store.ts
git commit -m "feat(schedule): add deterministic demo clock (DEMO_NOW), single-source NOW"
```

---

### Task 2: ScheduleBlock domain, permission, transition edge

**Files:**
- Modify: `lib/domain/enums.ts` (append states + meta)
- Modify: `lib/domain/entities.ts:3-6` (import) + append schema
- Modify: `lib/auth/permissions.ts` (add permission)
- Modify: `lib/logic/order.ts:75` (transition edge)
- Create: `lib/domain/schedule-block.test.ts`
- Modify: `lib/logic/order.test.ts` (add edge assertion) — if the file exists; otherwise create `lib/logic/order-transitions.test.ts`
- Modify: `tests/use-can.test.tsx` (add schedule_loads assertion) — or create `lib/auth/permissions.test.ts`

**Interfaces:**
- Produces: `SCHEDULE_BLOCK_STATES = ["planned","cancelled"]`, `ScheduleBlockState`, `scheduleBlockStateMeta`. `scheduleBlockSchema` / `ScheduleBlock = { id, createdAt, updatedAt, version, workOrderId, equipmentId, day, state }`. `Permission` union gains `"schedule_loads"` (→ `["manager","office"]`). `ORDER_TRANSITIONS.scheduled` gains `"received"`.

- [ ] **Step 1: Write the failing tests**

Create `lib/domain/schedule-block.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scheduleBlockSchema, SCHEDULE_BLOCK_STATES } from "@/lib/domain";
import { canTransitionOrder } from "@/lib/logic/order";
import { can } from "@/lib/auth/permissions";

describe("ScheduleBlock schema", () => {
  it("parses a valid planned block", () => {
    const b = scheduleBlockSchema.parse({
      id: "sb-1", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0,
      workOrderId: "wo-48230", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned",
    });
    expect(b.state).toBe("planned");
  });
  it("rejects an unknown state", () => {
    expect(() => scheduleBlockSchema.parse({
      id: "sb-1", createdAt: "x", updatedAt: "x", version: 0,
      workOrderId: "wo-1", equipmentId: "eq-iq-1", day: "d", state: "bogus",
    })).toThrow();
  });
  it("exposes the two states", () => {
    expect(SCHEDULE_BLOCK_STATES).toEqual(["planned", "cancelled"]);
  });
});

describe("scheduled → received transition (unassign revert)", () => {
  it("allows scheduled → received", () => {
    expect(canTransitionOrder("scheduled", "received")).toBe(true);
  });
  it("keeps existing scheduled edges", () => {
    expect(canTransitionOrder("scheduled", "in_process")).toBe(true);
    expect(canTransitionOrder("scheduled", "on_hold")).toBe(true);
  });
});

describe("schedule_loads permission", () => {
  it("is granted to manager and office, not sales", () => {
    expect(can("manager", "schedule_loads")).toBe(true);
    expect(can("office", "schedule_loads")).toBe(true);
    expect(can("sales", "schedule_loads")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/domain/schedule-block.test.ts`
Expected: FAIL — `scheduleBlockSchema` / `SCHEDULE_BLOCK_STATES` not exported; `schedule_loads` not in matrix.

- [ ] **Step 3: Add states + meta to `lib/domain/enums.ts`**

Append at the end of the file:
```ts
export const SCHEDULE_BLOCK_STATES = ["planned","cancelled"] as const;
export type ScheduleBlockState = (typeof SCHEDULE_BLOCK_STATES)[number];
export const scheduleBlockStateMeta: Record<ScheduleBlockState, { label: string; tone: StatusTone }> = {
  planned:   { label: "Planned",   tone: "info" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
```

- [ ] **Step 4: Add the schema to `lib/domain/entities.ts`**

In the enum import block (lines 3–6), add `SCHEDULE_BLOCK_STATES`:
```ts
import {
  QUOTE_STATUSES, ORDER_STATUSES, INVOICE_STATUSES, CERT_STATUSES,
  CUSTOMER_STATUSES, PRICING_BASES, ROLE_KEYS, AREAS, ORDER_STEP_STATES,
  SCHEDULE_BLOCK_STATES,
} from "./enums";
```
Append at the end of the file:
```ts
export const scheduleBlockSchema = baseEntitySchema.extend({
  workOrderId: z.string(),
  equipmentId: z.string(), // one of EQUIPMENT[].id (foreign keys are z.string(), like customerId)
  day: z.string(),         // ISO midnight-UTC date
  state: z.enum(SCHEDULE_BLOCK_STATES),
});
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
```
(`lib/domain/index.ts` already re-exports `./entities` and `./enums`, so no index edit is needed.)

- [ ] **Step 5: Add the permission in `lib/auth/permissions.ts`**

Extend the `Permission` union and `MATRIX`:
```ts
export type Permission = "approve_over_limit" | "apply_discount" | "release_cert" | "close_period" | "edit_setup" | "schedule_loads";

const MATRIX: Record<Permission, RoleKey[]> = {
  approve_over_limit: ["manager"],
  apply_discount: ["manager", "sales"],
  release_cert: ["manager"],
  close_period: ["manager", "office"],
  edit_setup: ["manager"],
  schedule_loads: ["manager", "office"],
};
```

- [ ] **Step 6: Add the transition edge in `lib/logic/order.ts`**

Change line 75 from:
```ts
  scheduled: ["in_process", "on_hold"],
```
to:
```ts
  scheduled: ["in_process", "on_hold", "received"],
```

- [ ] **Step 7: Run tests + gate**

Run: `npx vitest run lib/domain/schedule-block.test.ts` → PASS.
Run: `npx vitest run` → all green.
Run: `npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.

- [ ] **Step 8: Commit**

```bash
git add lib/domain/enums.ts lib/domain/entities.ts lib/auth/permissions.ts lib/logic/order.ts lib/domain/schedule-block.test.ts
git commit -m "feat(schedule): ScheduleBlock entity, schedule_loads perm, scheduled→received edge"
```

---

### Task 3: `scheduleBlocks` repository

**Files:**
- Modify: `lib/data/repositories/index.ts:1-4` (import) + `:29-43` (interface)
- Modify: `lib/data/mock/repositories.ts:50-63` (cols) + `:65-81` (return)
- Modify: `lib/data/seed/index.ts` (add empty `scheduleBlocks` array + return it) — the real seed rows come in Task 6
- Create: `lib/data/mock/schedule-blocks-repo.test.ts`

**Interfaces:**
- Consumes: `ScheduleBlock` (Task 2), `WriteRepo` (existing).
- Produces: `Repositories.scheduleBlocks: WriteRepo<ScheduleBlock>`; `buildSeed()` returns `scheduleBlocks: ScheduleBlock[]`.

- [ ] **Step 1: Write the failing test**

Create `lib/data/mock/schedule-blocks-repo.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createMockRepositories } from "./repositories";

describe("scheduleBlocks repo", () => {
  it("creates a block with server-assigned base fields", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const created = await repos.scheduleBlocks.create({
      workOrderId: "wo-48231", equipmentId: "eq-iq-1", day: "2026-06-29T00:00:00.000Z", state: "planned",
    });
    expect(created.id).toBeTruthy();
    expect(created.version).toBe(0);
    expect(created.state).toBe("planned");
  });

  it("enforces optimistic concurrency on update", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const b = await repos.scheduleBlocks.create({
      workOrderId: "wo-48231", equipmentId: "eq-iq-1", day: "2026-06-29T00:00:00.000Z", state: "planned",
    });
    await expect(repos.scheduleBlocks.update(b.id, { state: "cancelled" }, b.version + 5)).rejects.toThrow();
    const ok = await repos.scheduleBlocks.update(b.id, { state: "cancelled" }, b.version);
    expect(ok.state).toBe("cancelled");
    expect(ok.version).toBe(b.version + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/data/mock/schedule-blocks-repo.test.ts`
Expected: FAIL — `repos.scheduleBlocks` is undefined.

- [ ] **Step 3: Add to the repository interface**

In `lib/data/repositories/index.ts`, add `ScheduleBlock` to the type import (lines 1–4):
```ts
import type {
  Customer, Contact, Part, ProcessMaster, Specification, PriceKey, PricingRule,
  Quote, WorkOrder, Certification, Invoice, Operator, ScheduleBlock,
} from "@/lib/domain";
```
Add the field inside `interface Repositories` (after `invoices`):
```ts
  scheduleBlocks: WriteRepo<ScheduleBlock>;
```

- [ ] **Step 4: Seed an empty array (real rows land in Task 6)**

In `lib/data/seed/index.ts`, add `ScheduleBlock` to the type import block (lines 1–15) and declare the array just before the `counters` line (~847):
```ts
  const scheduleBlocks: ScheduleBlock[] = [];
```
Add `scheduleBlocks,` to the object returned by `buildSeed()` (the block at ~849).

- [ ] **Step 5: Wire the mock repo**

In `lib/data/mock/repositories.ts`, add to `cols` (after `operators`):
```ts
    scheduleBlocks: new Collection(seed.scheduleBlocks),
```
Add to the returned object (after `invoices: write(cols.invoices, "invoices"),`):
```ts
    scheduleBlocks: write(cols.scheduleBlocks),
```
(No `key` argument — blocks are not numbered, so no `numberPrefix` entry. Generic factory assigns `id`, `createdAt`, `updatedAt`, `version` and version-checks `update` unchanged; no new `any`.)

- [ ] **Step 6: Run test + gate**

Run: `npx vitest run lib/data/mock/schedule-blocks-repo.test.ts` → PASS.
Run: `npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.

- [ ] **Step 7: Commit**

```bash
git add lib/data/repositories/index.ts lib/data/mock/repositories.ts lib/data/seed/index.ts lib/data/mock/schedule-blocks-repo.test.ts
git commit -m "feat(schedule): scheduleBlocks WriteRepo (interface + mock wiring + seed slot)"
```

---

### Task 4: Pure logic `lib/logic/schedule.ts`

**Files:**
- Create: `lib/logic/schedule.ts`
- Create: `lib/logic/schedule.test.ts`

**Interfaces:**
- Consumes: `WorkOrder`, `ScheduleBlock`, `OrderStatus`, `ActivityEntry` (domain); `EQUIPMENT` (enums); `activeStep` (`./tracking`); `isLate` (`./dashboard`); `activityEntry` (`./order`).
- Produces:
  - `type WeekDay = { iso: string; label: string; weekdayShort: string }`
  - `weekDays(asOf: string): WeekDay[]` — five Mon–Fri, Monday-on-or-before rule.
  - `weekDayLabel(dayIso: string): string`
  - `unscheduledOrders(orders, blocks): WorkOrder[]`
  - `type ScheduleCell` (fields below); `scheduleCells(blocks, orders, asOf): ScheduleCell[]`
  - `scheduleSummary(cells, unscheduled): { scheduled; unscheduled; late }`
  - `type AssignPatch`; `assignPatch(order, equipmentId, day, actor, at): AssignPatch`
  - `type UnschedulePatch`; `unschedulePatch(order, actor, at): UnschedulePatch`
  - `movePatch(equipmentId, day): { equipmentId; day }`

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/schedule.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  weekDays, weekDayLabel, unscheduledOrders, scheduleCells, scheduleSummary,
  assignPatch, unschedulePatch, movePatch,
} from "./schedule";
import type { WorkOrder, ScheduleBlock } from "@/lib/domain";

const ASOF = "2026-06-30T12:00:00.000Z"; // Tuesday
const WEEK = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03"];

function wo(over: Partial<WorkOrder>): WorkOrder {
  return {
    id: "wo-x", createdAt: "t", updatedAt: "t", version: 0, number: "WO-X",
    customerId: "cust-apex", customerPO: "", quoteId: null, processSummary: "Carburize",
    processMasterId: null, status: "received", orderedDate: "2026-06-01T00:00:00.000Z",
    due: "2026-07-03T00:00:00.000Z", certifyRequired: false, certSpecId: null,
    orderValueCents: 0, progressPct: 0, lines: [], pricing: [],
    steps: [{ n: 1, op: "Carburize", equip: "Batch IQ #1", instr: "", params: [], track: "track_in_out",
      areaId: "in_process", state: "pending", operatorId: null, operatorInitials: null,
      trackedInAt: null, trackedOutAt: null, inspectResult: null }],
    activity: [], ...over,
  };
}
function block(over: Partial<ScheduleBlock>): ScheduleBlock {
  return { id: "sb-x", createdAt: "t", updatedAt: "t", version: 0,
    workOrderId: "wo-x", equipmentId: "eq-iq-1", day: "2026-07-01T00:00:00.000Z", state: "planned", ...over };
}

describe("weekDays", () => {
  it("returns Mon–Fri of the week containing a mid-week asOf", () => {
    const days = weekDays(ASOF);
    expect(days.map((d) => d.iso.slice(0, 10))).toEqual(WEEK);
    expect(days[0].label).toBe("Mon 6/29");
    expect(days[0].iso).toBe("2026-06-29T00:00:00.000Z");
  });
  it("Monday asOf resolves to its own week", () => {
    expect(weekDays("2026-06-29T00:00:00.000Z").map((d) => d.iso.slice(0, 10))).toEqual(WEEK);
  });
  it("Sunday asOf resolves to the Monday on/before (week just ending)", () => {
    // 2026-07-05 is a Sunday → Monday-on-or-before is 2026-06-29.
    expect(weekDays("2026-07-05T00:00:00.000Z").map((d) => d.iso.slice(0, 10))).toEqual(WEEK);
  });
});

describe("weekDayLabel", () => {
  it("formats an ISO day in UTC", () => {
    expect(weekDayLabel("2026-07-02T00:00:00.000Z")).toBe("Thu 7/2");
  });
});

describe("unscheduledOrders", () => {
  it("returns received orders with no planned block, sorted by due", () => {
    const a = wo({ id: "a", status: "received", due: "2026-07-03T00:00:00.000Z" });
    const b = wo({ id: "b", status: "received", due: "2026-07-01T00:00:00.000Z" });
    const scheduled = wo({ id: "c", status: "scheduled" });
    const blocks = [block({ id: "sb-a", workOrderId: "a", state: "cancelled" })]; // cancelled → still unscheduled
    const out = unscheduledOrders([a, b, scheduled], blocks);
    expect(out.map((o) => o.id)).toEqual(["b", "a"]);
  });
  it("excludes an order that has a planned block", () => {
    const a = wo({ id: "a", status: "received" });
    const out = unscheduledOrders([a], [block({ workOrderId: "a", state: "planned" })]);
    expect(out).toEqual([]);
  });
});

describe("scheduleCells", () => {
  it("projects a planned block in-week onto a cell with live status", () => {
    const order = wo({ id: "a", number: "WO-A", status: "scheduled", due: "2026-07-03T00:00:00.000Z" });
    const cells = scheduleCells([block({ id: "sb-a", workOrderId: "a" })], [order], ASOF);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      blockId: "sb-a", equipmentId: "eq-iq-1", day: "2026-07-01T00:00:00.000Z",
      workOrderNumber: "WO-A", op: "Carburize", status: "scheduled", late: false, actionable: true,
    });
  });
  it("drops cancelled blocks, shipped orders, and blocks outside the week", () => {
    const order = wo({ id: "a", status: "scheduled" });
    const shipped = wo({ id: "b", status: "shipped" });
    const cells = scheduleCells([
      block({ id: "c1", workOrderId: "a", state: "cancelled" }),
      block({ id: "c2", workOrderId: "b", state: "planned" }),
      block({ id: "c3", workOrderId: "a", day: "2026-08-10T00:00:00.000Z", state: "planned" }),
    ], [order, shipped], ASOF);
    expect(cells).toEqual([]);
  });
  it("marks a past-due open order LATE and non-actionable once in_process", () => {
    const order = wo({ id: "a", status: "in_process", due: "2026-06-20T00:00:00.000Z" });
    const cells = scheduleCells([block({ workOrderId: "a" })], [order], ASOF);
    expect(cells[0].late).toBe(true);
    expect(cells[0].actionable).toBe(false);
  });
  it("orders same-cell collisions deterministically by WO number", () => {
    const o1 = wo({ id: "1", number: "WO-100", status: "scheduled" });
    const o2 = wo({ id: "2", number: "WO-050", status: "scheduled" });
    const cells = scheduleCells([
      block({ id: "b1", workOrderId: "1" }), block({ id: "b2", workOrderId: "2" }),
    ], [o1, o2], ASOF);
    expect(cells.map((c) => c.workOrderNumber)).toEqual(["WO-050", "WO-100"]);
  });
});

describe("scheduleSummary", () => {
  it("counts scheduled, unscheduled, late", () => {
    const order = wo({ id: "a", status: "in_process", due: "2026-06-20T00:00:00.000Z" });
    const cells = scheduleCells([block({ workOrderId: "a" })], [order], ASOF);
    expect(scheduleSummary(cells, [wo({ id: "q" })])).toEqual({ scheduled: 1, unscheduled: 1, late: 1 });
  });
});

describe("mutation patch builders", () => {
  it("assignPatch sets scheduled + activity and a planned block input", () => {
    const order = wo({ id: "a", activity: [{ actor: "System", message: "Order received", at: "t0" }] });
    const p = assignPatch(order, "eq-iq-2", "2026-07-01T00:00:00.000Z", "Dana Mercer", "t1");
    expect(p.workOrder.status).toBe("scheduled");
    expect(p.workOrder.activity.at(-1)).toEqual({ actor: "Dana Mercer", message: "Scheduled — Batch IQ #2 · Wed 7/1", at: "t1" });
    expect(p.block).toEqual({ workOrderId: "a", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned" });
  });
  it("unschedulePatch cancels the block and reverts to received + activity", () => {
    const order = wo({ id: "a", status: "scheduled", activity: [] });
    const p = unschedulePatch(order, "Dana Mercer", "t2");
    expect(p.block).toEqual({ state: "cancelled" });
    expect(p.workOrder.status).toBe("received");
    expect(p.workOrder.activity.at(-1)).toEqual({ actor: "Dana Mercer", message: "Unscheduled — returned to Received", at: "t2" });
  });
  it("movePatch returns the new equipment + day", () => {
    expect(movePatch("eq-vac-1", "2026-07-02T00:00:00.000Z")).toEqual({ equipmentId: "eq-vac-1", day: "2026-07-02T00:00:00.000Z" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/logic/schedule.test.ts`
Expected: FAIL — `Cannot find module './schedule'`.

- [ ] **Step 3: Implement `lib/logic/schedule.ts`**

```ts
import type { WorkOrder, ScheduleBlock, OrderStatus, ActivityEntry } from "@/lib/domain";
import { EQUIPMENT } from "@/lib/domain/enums";
import { activeStep } from "./tracking";
import { isLate } from "./dashboard";
import { activityEntry } from "./order";

const DAY_MS = 86_400_000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const EQUIP_BY_ID = new Map(EQUIPMENT.map((e) => [e.id, e]));

export type WeekDay = { iso: string; label: string; weekdayShort: string };

export function weekDayLabel(dayIso: string): string {
  const d = new Date(dayIso);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function weekDays(asOf: string): WeekDay[] {
  const d = new Date(asOf);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(midnight).getUTCDay();     // 0=Sun..6=Sat
  const deltaToMonday = (dow + 6) % 7;            // Mon→0 … Sun→6 (Monday on or before)
  const monday = midnight - deltaToMonday * DAY_MS;
  return Array.from({ length: 5 }, (_, i) => {
    const iso = new Date(monday + i * DAY_MS).toISOString();
    return { iso, label: weekDayLabel(iso), weekdayShort: weekDayLabel(iso).split(" ")[0] };
  });
}

export function unscheduledOrders(orders: WorkOrder[], blocks: ScheduleBlock[]): WorkOrder[] {
  const plannedWo = new Set(blocks.filter((b) => b.state === "planned").map((b) => b.workOrderId));
  return orders
    .filter((o) => o.status === "received" && !plannedWo.has(o.id))
    .sort((a, b) => a.due.localeCompare(b.due));
}

export type ScheduleCell = {
  blockId: string;
  equipmentId: string;
  day: string;
  workOrderId: string;
  workOrderNumber: string;
  customerId: string;
  op: string | null;
  status: OrderStatus;
  progressPct: number;
  late: boolean;
  actionable: boolean;
};

export function scheduleCells(blocks: ScheduleBlock[], orders: WorkOrder[], asOf: string): ScheduleCell[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const weekIsos = new Set(weekDays(asOf).map((w) => w.iso));
  const cells: ScheduleCell[] = [];
  for (const b of blocks) {
    if (b.state !== "planned") continue;
    if (!weekIsos.has(b.day)) continue;
    const order = orderById.get(b.workOrderId);
    if (!order || order.status === "shipped") continue;
    const step = activeStep(order.steps);
    cells.push({
      blockId: b.id, equipmentId: b.equipmentId, day: b.day,
      workOrderId: order.id, workOrderNumber: order.number, customerId: order.customerId,
      op: step?.op ?? null, status: order.status, progressPct: order.progressPct,
      late: isLate(order, asOf), actionable: order.status === "scheduled",
    });
  }
  return cells.sort((a, b) => a.workOrderNumber.localeCompare(b.workOrderNumber));
}

export function scheduleSummary(
  cells: ScheduleCell[], unscheduled: WorkOrder[],
): { scheduled: number; unscheduled: number; late: number } {
  return { scheduled: cells.length, unscheduled: unscheduled.length, late: cells.filter((c) => c.late).length };
}

export type AssignPatch = {
  workOrder: { status: OrderStatus; activity: ActivityEntry[] };
  block: { workOrderId: string; equipmentId: string; day: string; state: "planned" };
};
export function assignPatch(order: WorkOrder, equipmentId: string, day: string, actor: string, at: string): AssignPatch {
  const equip = EQUIP_BY_ID.get(equipmentId);
  const message = `Scheduled — ${equip?.name ?? equipmentId} · ${weekDayLabel(day)}`;
  return {
    workOrder: { status: "scheduled", activity: [...order.activity, activityEntry(actor, message, at)] },
    block: { workOrderId: order.id, equipmentId, day, state: "planned" },
  };
}

export type UnschedulePatch = {
  block: { state: "cancelled" };
  workOrder: { status: OrderStatus; activity: ActivityEntry[] };
};
export function unschedulePatch(order: WorkOrder, actor: string, at: string): UnschedulePatch {
  return {
    block: { state: "cancelled" },
    workOrder: { status: "received", activity: [...order.activity, activityEntry(actor, "Unscheduled — returned to Received", at)] },
  };
}

export function movePatch(equipmentId: string, day: string): { equipmentId: string; day: string } {
  return { equipmentId, day };
}
```

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run lib/logic/schedule.test.ts` → PASS (all cases).
Run: `npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/schedule.ts lib/logic/schedule.test.ts
git commit -m "feat(schedule): pure logic — weekDays, cells, queue, summary, patch builders"
```

---

### Task 5: Query keys + mutation hooks

**Files:**
- Modify: `lib/query/keys.ts` (add `scheduleBlocks`)
- Modify: `lib/query/hooks.ts` (imports + 1 query hook + 3 mutation hooks)
- Create: `tests/schedule-hooks.test.tsx`

**Interfaces:**
- Consumes: `assignPatch`/`unschedulePatch`/`movePatch` (Task 4); `scheduleBlocks` repo (Task 3); `ScheduleBlock`, `WorkOrder`, `Operator` (domain).
- Produces: `useScheduleBlocks()`; `useAssignSchedule()` (vars `{ order, equipmentId, day, operator, at }`); `useMoveSchedule()` (vars `{ block, equipmentId, day }`); `useUnschedule()` (vars `{ order, block, operator, at }`).

- [ ] **Step 1: Write the failing test**

Create `tests/schedule-hooks.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import { useWorkOrders, useScheduleBlocks, useAssignSchedule, useUnschedule, useOperators } from "@/lib/query/hooks";

// Assign the seeded received order wo-48231 to a furnace/day, then unschedule it.
function AssignProbe() {
  const orders = useWorkOrders();
  const blocks = useScheduleBlocks();
  const ops = useOperators();
  const assign = useAssignSchedule();
  const unschedule = useUnschedule();
  const order = orders.data?.find((o) => o.id === "wo-48231");
  const operator = ops.data?.find((o) => o.id === "op-dana");
  const planned = blocks.data?.filter((b) => b.workOrderId === "wo-48231" && b.state === "planned") ?? [];
  return (
    <div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <div data-testid="planned">{planned.length}</div>
      <button disabled={!order || !operator} onClick={() => order && operator &&
        assign.mutate({ order, equipmentId: "eq-iq-1", day: "2026-06-29T00:00:00.000Z", operator, at: "2026-06-30T12:00:00.000Z" })}>Assign</button>
      <button disabled={!order || !operator || planned.length === 0} onClick={() => {
        const b = planned[0];
        if (order && operator && b) unschedule.mutate({ order, block: b, operator, at: "2026-06-30T12:00:00.000Z" });
      }}>Unschedule</button>
    </div>
  );
}

describe("schedule mutation hooks", () => {
  it("assign drives received→scheduled and creates a planned block; unschedule reverts", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssignProbe />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("received"));

    await user.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("scheduled"));
    await waitFor(() => expect(screen.getByTestId("planned").textContent).toBe("1"));

    await user.click(screen.getByRole("button", { name: "Unschedule" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("received"));
    await waitFor(() => expect(screen.getByTestId("planned").textContent).toBe("0"));
  });
});
```
*(This test depends on the seeded received order `wo-48231`, which lands in Task 6. Until then it will fail at the `received` assertion — that is expected; it goes green after Task 6. To keep the gate green at the end of THIS task, the hooks themselves are verified by `tsc`/`eslint` and the existing suite; re-run this file after Task 6.)*

> Note for the executor: run this file's assertions after Task 6. In Task 5, confirm the hooks compile and the rest of the suite stays green; the new test's data prerequisite arrives in Task 6.

- [ ] **Step 2: Add the query key**

In `lib/query/keys.ts`, add inside `queryKeys`:
```ts
  scheduleBlocks: ["scheduleBlocks"] as const,
```

- [ ] **Step 3: Add hooks to `lib/query/hooks.ts`**

Extend the domain import (line 3) to include `ScheduleBlock`:
```ts
import type { Part, Quote, Operator, WorkOrder, OrderStatus, Certification, Invoice, Customer, ScheduleBlock } from "@/lib/domain";
```
Add the schedule-logic import (near the other `@/lib/logic/*` imports):
```ts
import { assignPatch, unschedulePatch, movePatch } from "@/lib/logic/schedule";
```
Append the hooks at the end of the file:
```ts
export function useScheduleBlocks() {
  const r = useRepositories();
  return useQuery({ queryKey: queryKeys.scheduleBlocks, queryFn: () => r.scheduleBlocks.list() });
}

export function useAssignSchedule() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; equipmentId: string; day: string; operator: Operator; at: string }) => {
      const patch = assignPatch(vars.order, vars.equipmentId, vars.day, vars.operator.name, vars.at);
      // Version-check the WO update FIRST — a stale order throws before any orphan block is created.
      const updated = await r.workOrders.update(vars.order.id, patch.workOrder, vars.order.version);
      await r.scheduleBlocks.create(patch.block);
      return updated;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.scheduleBlocks });
    },
  });
}

export function useMoveSchedule() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { block: ScheduleBlock; equipmentId: string; day: string }) =>
      r.scheduleBlocks.update(vars.block.id, movePatch(vars.equipmentId, vars.day), vars.block.version),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.scheduleBlocks }); },
  });
}

export function useUnschedule() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; block: ScheduleBlock; operator: Operator; at: string }) => {
      const patch = unschedulePatch(vars.order, vars.operator.name, vars.at);
      await r.scheduleBlocks.update(vars.block.id, patch.block, vars.block.version);
      const updated = await r.workOrders.update(vars.order.id, patch.workOrder, vars.order.version);
      return updated;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.scheduleBlocks });
    },
  });
}
```

- [ ] **Step 4: Verify compile + existing suite**

Run: `npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.
Run: `npx vitest run` → existing suite green (the new `schedule-hooks.test.tsx` will not pass until Task 6 seeds `wo-48231`; if it blocks the run, temporarily `describe.skip` it and remove the skip in Task 6 — note this in the commit).

- [ ] **Step 5: Commit**

```bash
git add lib/query/keys.ts lib/query/hooks.ts tests/schedule-hooks.test.tsx
git commit -m "feat(schedule): useScheduleBlocks + assign/move/unschedule mutation hooks"
```

---

### Task 6: Seed — received + scheduled orders + a planned block

**Files:**
- Modify: `lib/data/seed/index.ts` (add 2 work orders to `workOrders`; fill `scheduleBlocks` with `sb-1`)
- Modify: `lib/logic/dashboard.test.ts:17,19,65,67,91` (open-order counts)
- Modify: `tests/nav-badges.test.tsx:14` (orders badge)
- Un-skip: `tests/schedule-hooks.test.tsx` (if skipped in Task 5)

**Interfaces:**
- Consumes: `liveSteps` helper (existing, in `buildSeed`), `orderProgressPct` (imported in seed).
- Produces: seed rows `wo-48230` (status `scheduled`, cust-apex), `wo-48231` (status `received`, cust-apex), block `sb-1` (`wo-48230` → `eq-iq-2`, day `2026-07-01T00:00:00.000Z`, `planned`).

- [ ] **Step 1: Add the two work orders**

In `lib/data/seed/index.ts`, inside the `workOrders` array (append after the last existing order, before the closing `];` at ~829):
```ts
    {
      ...meta,
      id: "wo-48230",
      number: "WO-48230",
      customerId: "cust-apex",
      customerPO: "7742-A",
      quoteId: null,
      processSummary: "Carburize + Temper",
      processMasterId: "pm-carb58",
      status: "scheduled",
      orderedDate: "2026-06-29T00:00:00.000Z",
      due: "2026-07-02T00:00:00.000Z",
      certifyRequired: false,
      certSpecId: null,
      orderValueCents: 320000,
      progressPct: orderProgressPct(liveSteps("pm-carb58", [])),
      lines: [{ id: "ol-48230-1", partId: "part-ts4471", description: "Turbine shaft, 4140 steel", quantity: 200, spec: "Rc 58-62" }],
      pricing: [{ process: "Carburize", detail: "200 lb", amountCents: 320000 }],
      steps: liveSteps("pm-carb58", []),
      activity: [
        { at: "2026-06-29T00:00:00.000Z", actor: "System", message: "Order received" },
        { at: "2026-06-29T00:00:00.000Z", actor: "Dana Mercer", message: "Scheduled — Batch IQ #2 · Wed 7/1" },
      ],
    },
    {
      ...meta,
      id: "wo-48231",
      number: "WO-48231",
      customerId: "cust-apex",
      customerPO: "7742-B",
      quoteId: null,
      processSummary: "Carburize + Temper",
      processMasterId: "pm-carb58",
      status: "received",
      orderedDate: "2026-06-30T00:00:00.000Z",
      due: "2026-07-03T00:00:00.000Z",
      certifyRequired: false,
      certSpecId: null,
      orderValueCents: 180000,
      progressPct: orderProgressPct(liveSteps("pm-carb58", [])),
      lines: [{ id: "ol-48231-1", partId: "part-sp119", description: "Spacer ring, 8620", quantity: 120, spec: "Rc 58-62" }],
      pricing: [{ process: "Carburize", detail: "120 lb", amountCents: 180000 }],
      steps: liveSteps("pm-carb58", []),
      activity: [{ at: "2026-06-30T00:00:00.000Z", actor: "System", message: "Order received" }],
    },
```
*(`liveSteps("pm-carb58", [])` yields all-`pending` steps → `progressPct` 0. Both due dates are ≥ `DEMO_NOW` (2026-06-30) so neither is LATE. Both use Apex-owned parts `part-ts4471` / `part-sp119`.)*

- [ ] **Step 2: Add the planned block**

Replace the empty `scheduleBlocks` array from Task 3 with:
```ts
  const scheduleBlocks: ScheduleBlock[] = [
    { ...meta, id: "sb-1", workOrderId: "wo-48230", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned" },
  ];
```

- [ ] **Step 3: Run the suite to see the count failures**

Run: `npx vitest run`
Expected failures (from +2 open orders): `lib/logic/dashboard.test.ts` (open 7→9, on-time 57.1→66.7, KPI strings) and `tests/nav-badges.test.tsx` (o7→o9).

- [ ] **Step 4: Update the affected count assertions**

In `lib/logic/dashboard.test.ts`:
- line 17: `expect(openOrders(s.workOrders).length).toBe(7);` → `toBe(9)`
- line 18: `lateOrders(...).length).toBe(3)` — **unchanged** (new orders are not late)
- line 19: `expect(onSchedulePct(s.workOrders, asOf)).toBe(57.1);` → `toBe(66.7)`  *(6 on-time / 9 open)*
- line 65: `expect(t["Open Orders"]).toBe("7");` → `toBe("9")`
- line 66: `expect(t["Late Orders"]).toBe("3");` — **unchanged**
- line 67: `expect(t["On-Time %"]).toBe("57.1");` → `toBe("66.7")`
- line 91: `quotes: 3, orders: 7, certifications: 2,` → `orders: 9`

In `tests/nav-badges.test.tsx` line 14:
- `screen.findByText("q3-o7-c2")` → `screen.findByText("q3-o9-c2")`

If Task 5's `tests/schedule-hooks.test.tsx` was `describe.skip`-ed, remove the skip now.

- [ ] **Step 5: Re-run the full suite + gate**

Run: `npx vitest run` → all green (including `tests/schedule-hooks.test.tsx` now that `wo-48231` exists).
Run: `npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.

*(Sanity: the new orders have all-`pending` steps, so `equipmentLoads`/shop-floor tests are unaffected. They appear in the Tracking board's Received lane; if any tracking-board component test asserts an exact Received count, update it to include `WO-48230`/`WO-48231` — run the suite to confirm.)*

- [ ] **Step 6: Commit**

```bash
git add lib/data/seed/index.ts lib/logic/dashboard.test.ts tests/nav-badges.test.tsx tests/schedule-hooks.test.tsx
git commit -m "feat(schedule): seed a received + scheduled order and a planned block; fix count assertions"
```

---

### Task 7: Leaf components — ScheduleCellCard, UnscheduledQueue, AssignDialog

**Files:**
- Create: `components/schedule/schedule-cell.tsx`
- Create: `components/schedule/unscheduled-queue.tsx`
- Create: `components/schedule/assign-dialog.tsx`
- Create: `components/schedule/assign-dialog.test.tsx`
- Create: `components/schedule/unscheduled-queue.test.tsx`

**Interfaces:**
- Consumes: `ScheduleCell`, `WeekDay` (Task 4); `orderStatusMeta`, `EQUIPMENT`, `equipmentKindMeta` (enums); `MonoId`/`StatusPill`/`EmptyState` (patterns); `Button` (ui); `Dialog*` (ui); `formatDate` (utils).
- Produces:
  - `ScheduleCellCard({ cell, customerName, canSchedule, busy, onMove, onUnassign })`
  - `UnscheduledQueue({ orders, customers, canSchedule, busy, onAssign })`
  - `AssignDialog({ open, onOpenChange, mode, workOrderNumber, days, initialEquipmentId?, initialDay?, busy, onConfirm })` — `mode: "assign" | "move"`, `onConfirm(equipmentId, day)`.

- [ ] **Step 1: Write the failing tests**

Create `components/schedule/assign-dialog.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssignDialog } from "./assign-dialog";
import type { WeekDay } from "@/lib/logic/schedule";

const DAYS: WeekDay[] = [
  { iso: "2026-06-29T00:00:00.000Z", label: "Mon 6/29", weekdayShort: "Mon" },
  { iso: "2026-07-01T00:00:00.000Z", label: "Wed 7/1", weekdayShort: "Wed" },
];

describe("AssignDialog", () => {
  it("confirms a chosen equipment + day", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AssignDialog open mode="assign" workOrderNumber="WO-48231" days={DAYS} busy={false}
      onOpenChange={() => {}} onConfirm={onConfirm} />);

    await user.selectOptions(screen.getByLabelText("Equipment"), "eq-vac-1");
    await user.selectOptions(screen.getByLabelText("Day"), "2026-07-01T00:00:00.000Z");
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(onConfirm).toHaveBeenCalledWith("eq-vac-1", "2026-07-01T00:00:00.000Z");
  });

  it("move mode pre-fills and labels the confirm button 'Move'", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AssignDialog open mode="move" workOrderNumber="WO-48230" days={DAYS}
      initialEquipmentId="eq-iq-2" initialDay="2026-07-01T00:00:00.000Z" busy={false}
      onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(onConfirm).toHaveBeenCalledWith("eq-iq-2", "2026-07-01T00:00:00.000Z");
  });
});
```

Create `components/schedule/unscheduled-queue.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnscheduledQueue } from "./unscheduled-queue";
import type { WorkOrder, Customer } from "@/lib/domain";

const cust = [{ id: "cust-apex", name: "Apex Aerospace" } as Customer];
function order(id: string, number: string): WorkOrder {
  return { id, number, customerId: "cust-apex", due: "2026-07-03T00:00:00.000Z" } as WorkOrder;
}

describe("UnscheduledQueue", () => {
  it("renders queue cards and fires onAssign when permitted", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<UnscheduledQueue orders={[order("wo-48231", "WO-48231")]} customers={cust}
      canSchedule busy={false} onAssign={onAssign} />);
    expect(screen.getByTestId("queue-card-WO-48231")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  it("hides the Assign button without permission", () => {
    render(<UnscheduledQueue orders={[order("wo-48231", "WO-48231")]} customers={cust}
      canSchedule={false} busy={false} onAssign={() => {}} />);
    expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
  });

  it("shows an empty state when the queue is empty", () => {
    render(<UnscheduledQueue orders={[]} customers={cust} canSchedule busy={false} onAssign={() => {}} />);
    expect(screen.getByText("All received orders scheduled")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run components/schedule/assign-dialog.test.tsx components/schedule/unscheduled-queue.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `components/schedule/schedule-cell.tsx`**

```tsx
import { StatusPill, MonoId } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { orderStatusMeta } from "@/lib/domain/enums";
import type { ScheduleCell } from "@/lib/logic/schedule";

export function ScheduleCellCard({ cell, customerName, canSchedule, busy, onMove, onUnassign }: {
  cell: ScheduleCell;
  customerName: string | null;
  canSchedule: boolean;
  busy: boolean;
  onMove: (cell: ScheduleCell) => void;
  onUnassign: (cell: ScheduleCell) => void;
}) {
  const sm = orderStatusMeta[cell.status];
  return (
    <div data-testid={`schedule-cell-${cell.blockId}`} className="rounded-card border border-border bg-surface p-2">
      <div className="mb-1 flex items-center justify-between">
        <MonoId className="text-xs">{cell.workOrderNumber}</MonoId>
        {cell.late && <StatusPill tone="danger">LATE</StatusPill>}
      </div>
      <div className="text-[12px] font-medium">{customerName ?? "—"}</div>
      <div className="text-text-muted text-[11px]">{cell.op ?? "—"}</div>
      <div className="mt-1"><StatusPill tone={sm.tone}>{sm.label}</StatusPill></div>
      {cell.actionable && canSchedule && (
        <div className="mt-2 flex gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onMove(cell)}>Move</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onUnassign(cell)}>Unassign</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `components/schedule/unscheduled-queue.tsx`**

```tsx
import { MonoId, EmptyState } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { formatDate } from "@/lib/utils";
import type { WorkOrder, Customer } from "@/lib/domain";

export function UnscheduledQueue({ orders, customers, canSchedule, busy, onAssign }: {
  orders: WorkOrder[];
  customers: Customer[];
  canSchedule: boolean;
  busy: boolean;
  onAssign: (order: WorkOrder) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  return (
    <div data-testid="unscheduled-queue" className="rounded-card border border-border bg-canvas-alt p-3">
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-text-faint">Unscheduled ({orders.length})</div>
      {orders.length === 0 ? (
        <EmptyState title="All received orders scheduled" />
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} data-testid={`queue-card-${o.number}`} className="rounded-card border border-border bg-surface p-2">
              <div className="flex items-center justify-between">
                <MonoId className="text-xs">{o.number}</MonoId>
                <span className="text-text-muted text-[11px]">Due {formatDate(o.due)}</span>
              </div>
              <div className="text-[12px] font-medium">{custById.get(o.customerId)?.name ?? "—"}</div>
              {canSchedule && (
                <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => onAssign(o)}>Assign</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `components/schedule/assign-dialog.tsx`**

```tsx
"use client";
import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
import { EQUIPMENT, equipmentKindMeta } from "@/lib/domain/enums";
import type { WeekDay } from "@/lib/logic/schedule";

const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm";

export function AssignDialog({ open, onOpenChange, mode, workOrderNumber, days, initialEquipmentId, initialDay, busy, onConfirm }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "assign" | "move";
  workOrderNumber: string;
  days: WeekDay[];
  initialEquipmentId?: string;
  initialDay?: string;
  busy: boolean;
  onConfirm: (equipmentId: string, day: string) => void;
}) {
  const [equipmentId, setEquipmentId] = useState(initialEquipmentId ?? EQUIPMENT[0].id);
  const [day, setDay] = useState(initialDay ?? days[0]?.iso ?? "");
  useEffect(() => {
    if (open) {
      setEquipmentId(initialEquipmentId ?? EQUIPMENT[0].id);
      setDay(initialDay ?? days[0]?.iso ?? "");
    }
  }, [open, initialEquipmentId, initialDay, days]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{mode === "assign" ? "Schedule order" : "Move scheduled order"}</DialogTitle>
          <DialogDescription>{workOrderNumber} — choose a furnace and day.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-xs">
            <span className="text-text-muted mb-1 block">Equipment</span>
            <select aria-label="Equipment" className={selectCls} value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
              {EQUIPMENT.map((eq) => (
                <option key={eq.id} value={eq.id}>{eq.name} — {equipmentKindMeta[eq.kind].label}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-text-muted mb-1 block">Day</span>
            <select aria-label="Day" className={selectCls} value={day} onChange={(e) => setDay(e.target.value)}>
              {days.map((d) => (<option key={d.iso} value={d.iso}>{d.label}</option>))}
            </select>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !equipmentId || !day} onClick={() => onConfirm(equipmentId, day)}>
            {mode === "assign" ? "Schedule" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Run tests + gate**

Run: `npx vitest run components/schedule/assign-dialog.test.tsx components/schedule/unscheduled-queue.test.tsx` → PASS.
Run: `npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.

- [ ] **Step 7: Commit**

```bash
git add components/schedule/schedule-cell.tsx components/schedule/unscheduled-queue.tsx components/schedule/assign-dialog.tsx components/schedule/assign-dialog.test.tsx components/schedule/unscheduled-queue.test.tsx
git commit -m "feat(schedule): leaf components — cell card, unscheduled queue, assign/move dialog"
```

---

### Task 8: ScheduleBoard (grid + queue + dialog orchestration)

**Files:**
- Create: `components/schedule/schedule-board.tsx`
- Create: `components/schedule/schedule-board.test.tsx`

**Interfaces:**
- Consumes: leaf components (Task 7); `weekDays`/`scheduleCells`/`unscheduledOrders`/`scheduleSummary`/`ScheduleCell` (Task 4); `EQUIPMENT`/`equipmentKindMeta` (enums); `KpiTile`/`ConfirmDialog` (patterns).
- Produces: `ScheduleBoard({ orders, customers, blocks, asOf, canSchedule, busy, onAssign, onMove, onUnassign })` where `onAssign(order, equipmentId, day)`, `onMove(cell, equipmentId, day)`, `onUnassign(cell)`.

- [ ] **Step 1: Write the failing test**

Create `components/schedule/schedule-board.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduleBoard } from "./schedule-board";
import type { WorkOrder, Customer, ScheduleBlock } from "@/lib/domain";

const ASOF = "2026-06-30T12:00:00.000Z";
const customers = [{ id: "cust-apex", name: "Apex Aerospace" } as Customer];

function wo(over: Partial<WorkOrder>): WorkOrder {
  return {
    id: "wo-1", number: "WO-1", customerId: "cust-apex", customerPO: "", quoteId: null,
    processSummary: "Carburize", processMasterId: null, status: "received",
    orderedDate: "2026-06-01T00:00:00.000Z", due: "2026-07-03T00:00:00.000Z",
    certifyRequired: false, certSpecId: null, orderValueCents: 0, progressPct: 0,
    lines: [], pricing: [],
    steps: [{ n: 1, op: "Carburize", equip: "Batch IQ #1", instr: "", params: [], track: "track_in_out",
      areaId: "in_process", state: "pending", operatorId: null, operatorInitials: null,
      trackedInAt: null, trackedOutAt: null, inspectResult: null }],
    activity: [], createdAt: "t", updatedAt: "t", version: 0, ...over,
  };
}
const scheduledWo = wo({ id: "wo-s", number: "WO-48230", status: "scheduled" });
const receivedWo = wo({ id: "wo-r", number: "WO-48231", status: "received" });
const block: ScheduleBlock = { id: "sb-1", createdAt: "t", updatedAt: "t", version: 0,
  workOrderId: "wo-s", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned" };

function setup(canSchedule: boolean, handlers: Partial<{ onAssign: any; onMove: any; onUnassign: any }> = {}) {
  return render(<ScheduleBoard orders={[scheduledWo, receivedWo]} customers={customers} blocks={[block]}
    asOf={ASOF} canSchedule={canSchedule} busy={false}
    onAssign={handlers.onAssign ?? (() => {})} onMove={handlers.onMove ?? (() => {})} onUnassign={handlers.onUnassign ?? (() => {})} />);
}

describe("ScheduleBoard", () => {
  it("shows the KPI strip and the planned block in its cell", () => {
    setup(true);
    expect(screen.getByTestId("schedule-summary")).toBeInTheDocument();
    const cell = screen.getByTestId("schedule-cell-sb-1");
    expect(cell).toHaveTextContent("WO-48230");
    expect(cell).toHaveTextContent("Scheduled");
  });

  it("lists the received order in the unscheduled queue", () => {
    setup(true);
    expect(screen.getByTestId("queue-card-WO-48231")).toBeInTheDocument();
  });

  it("assigns from the queue via the dialog", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    setup(true, { onAssign });
    // only one received order → a single "Assign" button
    await user.click(screen.getByRole("button", { name: "Assign" }));
    await user.selectOptions(screen.getByLabelText("Equipment"), "eq-vac-1");
    await user.selectOptions(screen.getByLabelText("Day"), "2026-06-29T00:00:00.000Z");
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(onAssign).toHaveBeenCalledWith(receivedWo, "eq-vac-1", "2026-06-29T00:00:00.000Z");
  });

  it("unassigns a scheduled block after confirm", async () => {
    const user = userEvent.setup();
    const onUnassign = vi.fn();
    setup(true, { onUnassign });
    await user.click(screen.getByRole("button", { name: "Unassign" }));
    await user.click(screen.getByRole("button", { name: "Unschedule" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
  });

  it("hides all write affordances without permission", () => {
    setup(false);
    expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unassign" })).not.toBeInTheDocument();
  });
});
```
*(If `getByTestId(...).getByRole` chaining is awkward in your RTL version, use `within(screen.getByTestId("queue-card-WO-48231")).getByRole("button", { name: "Assign" })` with `import { within } from "@testing-library/react"`.)*

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run components/schedule/schedule-board.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/schedule/schedule-board.tsx`**

```tsx
"use client";
import { Fragment, useState } from "react";
import { KpiTile, ConfirmDialog } from "@/components/patterns";
import { EQUIPMENT, equipmentKindMeta } from "@/lib/domain/enums";
import { weekDays, scheduleCells, unscheduledOrders, scheduleSummary, type ScheduleCell } from "@/lib/logic/schedule";
import { ScheduleCellCard } from "./schedule-cell";
import { UnscheduledQueue } from "./unscheduled-queue";
import { AssignDialog } from "./assign-dialog";
import type { WorkOrder, Customer, ScheduleBlock } from "@/lib/domain";

export function ScheduleBoard({ orders, customers, blocks, asOf, canSchedule, busy, onAssign, onMove, onUnassign }: {
  orders: WorkOrder[];
  customers: Customer[];
  blocks: ScheduleBlock[];
  asOf: string;
  canSchedule: boolean;
  busy: boolean;
  onAssign: (order: WorkOrder, equipmentId: string, day: string) => void;
  onMove: (cell: ScheduleCell, equipmentId: string, day: string) => void;
  onUnassign: (cell: ScheduleCell) => void;
}) {
  const days = weekDays(asOf);
  const cells = scheduleCells(blocks, orders, asOf);
  const queue = unscheduledOrders(orders, blocks);
  const summary = scheduleSummary(cells, queue);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const cellAt = new Map(cells.map((c) => [`${c.equipmentId}|${c.day}`, c]));

  const [assignFor, setAssignFor] = useState<WorkOrder | null>(null);
  const [moveFor, setMoveFor] = useState<ScheduleCell | null>(null);
  const [unassignFor, setUnassignFor] = useState<ScheduleCell | null>(null);

  return (
    <div>
      <div data-testid="schedule-summary" className="mb-5 grid grid-cols-3 gap-3">
        <KpiTile label="Scheduled" value={String(summary.scheduled)} />
        <KpiTile label="Unscheduled" value={String(summary.unscheduled)} />
        <KpiTile label="Late" value={String(summary.late)} tone="danger" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[720px]"
            style={{ gridTemplateColumns: `10rem repeat(${days.length}, minmax(9rem, 1fr))` }}
          >
            <div />
            {days.map((d) => (
              <div key={d.iso} className="text-text-faint px-2 pb-2 font-mono text-[10.5px] uppercase tracking-wider">{d.label}</div>
            ))}
            {EQUIPMENT.map((eq) => (
              <Fragment key={eq.id}>
                <div className="border-border border-t px-2 py-2">
                  <div className="text-[12px] font-medium">{eq.name}</div>
                  <div className="text-text-muted text-[10.5px]">{equipmentKindMeta[eq.kind].label}</div>
                </div>
                {days.map((d) => {
                  const cell = cellAt.get(`${eq.id}|${d.iso}`);
                  return (
                    <div key={d.iso} data-testid={`grid-cell-${eq.id}-${d.iso}`} className="border-border border-t border-l p-1">
                      {cell ? (
                        <ScheduleCellCard
                          cell={cell}
                          customerName={custById.get(cell.customerId)?.name ?? null}
                          canSchedule={canSchedule}
                          busy={busy}
                          onMove={(c) => setMoveFor(c)}
                          onUnassign={(c) => setUnassignFor(c)}
                        />
                      ) : (
                        <div className="text-text-faint p-2 text-center text-xs">—</div>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        <UnscheduledQueue
          orders={queue}
          customers={customers}
          canSchedule={canSchedule}
          busy={busy}
          onAssign={(o) => setAssignFor(o)}
        />
      </div>

      <AssignDialog
        open={assignFor !== null}
        onOpenChange={(o) => { if (!o) setAssignFor(null); }}
        mode="assign"
        workOrderNumber={assignFor?.number ?? ""}
        days={days}
        busy={busy}
        onConfirm={(equipmentId, day) => { if (assignFor) { onAssign(assignFor, equipmentId, day); setAssignFor(null); } }}
      />
      <AssignDialog
        open={moveFor !== null}
        onOpenChange={(o) => { if (!o) setMoveFor(null); }}
        mode="move"
        workOrderNumber={moveFor?.workOrderNumber ?? ""}
        days={days}
        initialEquipmentId={moveFor?.equipmentId}
        initialDay={moveFor?.day}
        busy={busy}
        onConfirm={(equipmentId, day) => { if (moveFor) { onMove(moveFor, equipmentId, day); setMoveFor(null); } }}
      />
      <ConfirmDialog
        open={unassignFor !== null}
        onOpenChange={(o) => { if (!o) setUnassignFor(null); }}
        title="Unschedule order"
        description={`Return ${unassignFor?.workOrderNumber ?? ""} to Received? Its schedule block will be cancelled.`}
        confirmLabel="Unschedule"
        onConfirm={() => { if (unassignFor) { onUnassign(unassignFor); setUnassignFor(null); } }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run components/schedule/schedule-board.test.tsx` → PASS.
Run: `npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.

- [ ] **Step 5: Commit**

```bash
git add components/schedule/schedule-board.tsx components/schedule/schedule-board.test.tsx
git commit -m "feat(schedule): ScheduleBoard — roster×week grid, queue, assign/move/unassign dialogs"
```

---

### Task 9: Page — replace the placeholder

**Files:**
- Modify: `app/(app)/schedule/page.tsx` (replace `PlaceholderPage`)
- Create: `components/schedule/schedule-page.test.tsx`

**Interfaces:**
- Consumes: `useAuth`/`useCan` (auth); `useWorkOrders`/`useCustomers`/`useScheduleBlocks`/`useAssignSchedule`/`useMoveSchedule`/`useUnschedule` (hooks); `PageHeader`/`SkeletonRows`/`ErrorPanel` (patterns); `ScheduleBoard` (Task 8); `DEMO_NOW` (clock).

- [ ] **Step 0 (AGENTS.md): Read the Next docs** for App-Router client pages before editing `page.tsx`:

Run: `ls node_modules/next/dist/docs/` and read the App-Router client-component guide referenced there. Confirm the `"use client"` + hooks pattern matches the existing `app/(app)/tracking/page.tsx`.

- [ ] **Step 1: Write the failing test**

Create `components/schedule/schedule-page.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/tests/utils";
import SchedulePage from "@/app/(app)/schedule/page";

describe("SchedulePage", () => {
  it("renders the board with the seeded planned block after load", async () => {
    renderWithProviders(<SchedulePage />);
    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    // seeded block sb-1 (WO-48230 on Batch IQ #2, Wed 7/1)
    expect(await screen.findByTestId("schedule-cell-sb-1")).toHaveTextContent("WO-48230");
    // seeded received order in the queue
    expect(await screen.findByTestId("queue-card-WO-48231")).toBeInTheDocument();
  });
});
```
*(`@/tests/utils` resolves via the `@/*` path alias; if the alias doesn't include `tests`, import with a relative path `../../tests/utils`.)*

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run components/schedule/schedule-page.test.tsx`
Expected: FAIL — the placeholder renders no board (`schedule-cell-sb-1` missing).

- [ ] **Step 3: Replace `app/(app)/schedule/page.tsx`**

```tsx
"use client";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useWorkOrders, useCustomers, useScheduleBlocks,
  useAssignSchedule, useMoveSchedule, useUnschedule,
} from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ScheduleBoard } from "@/components/schedule/schedule-board";
import { DEMO_NOW } from "@/lib/clock";

export default function SchedulePage() {
  const { operator } = useAuth();
  const canSchedule = useCan("schedule_loads");
  const orders = useWorkOrders();
  const customers = useCustomers();
  const blocks = useScheduleBlocks();
  const assign = useAssignSchedule();
  const move = useMoveSchedule();
  const unschedule = useUnschedule();

  if (orders.isLoading || customers.isLoading || blocks.isLoading || !operator) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;
  if (blocks.isError) return <ErrorPanel message="Failed to load schedule." onRetry={() => blocks.refetch()} />;

  const asOf = DEMO_NOW;
  const busy = assign.isPending || move.isPending || unschedule.isPending;
  const orderList = orders.data ?? [];
  const blockList = blocks.data ?? [];
  const blockById = new Map(blockList.map((b) => [b.id, b]));

  return (
    <div>
      <PageHeader title="Schedule" subtitle="Weekly equipment load — assign orders to a furnace and day." />
      <ScheduleBoard
        orders={orderList}
        customers={customers.data ?? []}
        blocks={blockList}
        asOf={asOf}
        canSchedule={canSchedule}
        busy={busy}
        onAssign={(order, equipmentId, day) => assign.mutate({ order, equipmentId, day, operator, at: asOf })}
        onMove={(cell, equipmentId, day) => {
          const b = blockById.get(cell.blockId);
          if (b) move.mutate({ block: b, equipmentId, day });
        }}
        onUnassign={(cell) => {
          const b = blockById.get(cell.blockId);
          const order = orderList.find((o) => o.id === cell.workOrderId);
          if (b && order) unschedule.mutate({ order, block: b, operator, at: asOf });
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run components/schedule/schedule-page.test.tsx` → PASS.
Run: `npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0` → clean.
Run: `npm run build` → succeeds (route `/schedule` builds).

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/schedule/page.tsx components/schedule/schedule-page.test.tsx
git commit -m "feat(schedule): replace /schedule placeholder with the live board"
```

---

### Task 10: E2E happy path + full-gate verification

**Files:**
- Create: `tests/e2e/schedule.spec.ts`

**Interfaces:**
- Consumes: the running app (`npm run dev` via Playwright `webServer`); auto-login is `op-dana` (manager) → `canSchedule` true.

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/schedule.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("schedule board shows a planned block and schedules a received order", async ({ page }) => {
  await page.goto("/schedule");

  // Seed: block sb-1 → WO-48230 (Apex, scheduled) on Batch IQ #2, Wed 7/1.
  const seeded = page.getByTestId("schedule-cell-sb-1");
  await expect(seeded).toBeVisible();
  await expect(seeded).toContainText("WO-48230");
  await expect(seeded).toContainText("Scheduled");

  // WO-48231 (received) sits in the Unscheduled queue.
  const queueCard = page.getByTestId("queue-card-WO-48231");
  await expect(queueCard).toBeVisible();

  // Assign it to Batch IQ #1 on Monday.
  await queueCard.getByRole("button", { name: "Assign" }).click();
  await page.getByLabel("Equipment").selectOption("eq-iq-1");
  await page.getByLabel("Day").selectOption({ index: 0 });
  await page.getByRole("button", { name: "Schedule" }).click();

  // It leaves the queue and appears on the board with a Scheduled pill.
  await expect(page.getByTestId("queue-card-WO-48231")).toHaveCount(0);
  const grid = page.getByTestId("grid-cell-eq-iq-1-2026-06-29T00:00:00.000Z");
  await expect(grid).toContainText("WO-48231");
  await expect(grid).toContainText("Scheduled");
});
```

- [ ] **Step 2: Run the E2E**

Run: `npm run test:e2e`
Expected: the new spec passes; existing specs (`smoke`, `quote-to-invoice`, `tracking`, `shop-floor`) stay green.

- [ ] **Step 3: Full gate**

Run each and confirm green:
```bash
npx vitest run
npx tsc --noEmit
npx eslint . --max-warnings 0
npm run build
npm run test:e2e
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/schedule.spec.ts
git commit -m "test(schedule): e2e happy path — view planned block + schedule a received order"
```

---

## After the tasks (orchestrator)

1. **Whole-branch adversarial review** (per subagent-driven-development / requesting-code-review): spawn finders across the branch diff, verify findings adversarially, fix confirmed issues, re-green the gate.
2. **Update project memory** with the Plan-6 outcome + any new carry-forwards.
3. **Open the PR** from `heatsynq-schedule` → `main` (branch protection requires the `verify` check). Include the spec + this plan in the branch.

---

## Self-Review (checked against the spec)

**Spec coverage:**
- §2 decisions → Tasks: WO-linked block (T2/T4), ISO-date week/`DEMO_NOW` (T1/T4), soft-cancel + `scheduled→received` (T2/T4/T5), `schedule_loads` manager+office (T2/T8), action-driven native-select dialog (T7/T8), one-block-per-WO (logic in T4), write-ordering (T5). ✓
- §5 domain (states/meta/schema/permission/edge) → T2. ✓
- §6 repository → T3. ✓
- §7 pure logic (weekDays, unscheduledOrders, scheduleCells, summary, builders) → T4. ✓
- §8 hooks → T5. ✓
- §9 screen (KPI strip, grid, queue, dialogs, states) → T7/T8/T9. ✓
- §10 states/validation/errors → page guards (T9), disabled-confirm (T7). ✓
- §11 testing (unit/component/E2E) → T4/T7/T8/T9/T10. ✓
- §12 seed (received + scheduled + block; fix counts) → T6. ✓
- `DEMO_NOW` clock (§4) → T1. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code; count-fix step gives exact new values (9 / 66.7 / "q3-o9-c2"). ✓

**Type consistency:** `ScheduleBlock` fields, `ScheduleCell` fields, hook var shapes, and component props match across T2→T10. `assignPatch`/`unschedulePatch`/`movePatch` signatures identical in T4 (def), T5 (use). `AssignDialog.onConfirm(equipmentId, day)` consistent T7↔T8. Seed ids (`wo-48230`/`wo-48231`/`sb-1`) consistent T6↔T10. ✓

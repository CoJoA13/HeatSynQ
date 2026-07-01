# Shop-Floor Execution & Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HeatSynQ work-order traveler live — per-step track-in/out scans that roll up into order status + progress, an inspection step that auto-releases the cert or holds the order, a credit-hold shipment block, and a scan-driven Tracking kanban board.

**Architecture:** `OrderStep` (a `ProcessStep` plus live state + an `areaId`) is embedded on `WorkOrder.steps`; every scan is one version-checked `workOrders.update`, so no new repository or cross-aggregate transaction is introduced. Pure logic (area mapping, step state machine, status rollup, progress, board placement, ship gate) lives in `lib/logic/tracking.ts` + `lib/logic/order.ts`; TanStack Query mutations wrap it; Order Detail and a new Tracking board render it. `Area` is a static ordered config set (like the status metas), not a persisted entity.

**Tech Stack:** Next.js (App Router) + TypeScript, TanStack Query v5, Zod, Tailwind v4 + shadcn/ui, Vitest + React Testing Library, Playwright.

**Spec:** [`../specs/2026-07-01-heatsynq-shop-floor-tracking-execution-design.md`](../specs/2026-07-01-heatsynq-shop-floor-tracking-execution-design.md)

## Global Constraints

- **Money = integer cents**; format with `formatMoney` (whole-dollar display). **Dates = ISO strings**; format with `formatDate` (`timeZone: "UTC"`).
- **IBM Plex Mono** for ids/numbers/pills/timestamps (`MonoId`, `font-mono`); exact design tokens (`text-status-*`, `bg-status-*-tint`, `border-border`, `rounded-card`, etc.).
- **UI depends only on async repository interfaces via Query hooks** — never a concrete data source.
- **Every `update` is version-checked** (optimistic concurrency): pass `expectedVersion`; a mismatch throws `"Version conflict"`.
- **`any` is banned** except the two already-approved mock-plumbing signatures in `lib/data/mock/repositories.ts`. No new `any`, no new eslint-disable.
- **Pure domain logic** in `lib/logic/*`; **domain types + Zod** in `lib/domain/*`; **mock repos + seed** in `lib/data/*`; **hooks** in `lib/query/*`; **components** in `components/*`; `page.tsx` is thin glue. Next 16 dynamic routes read params via `use(params)`.
- **Permissions** follow the authenticated `operator.role` via `useCan`, never a `viewAs` preview.
- **Gate must stay green after every task:** `npx vitest run` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `npm run build` · `npm run test:e2e`.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.

---

### Task 1: Area config + OrderStep-state enum + `areaForOp` mapper

**Files:**
- Modify: `lib/domain/enums.ts` (append new consts)
- Modify: `lib/domain/enums.test.ts` (append cases)
- Create: `lib/logic/tracking.ts`
- Create: `lib/logic/tracking.test.ts`

**Interfaces:**
- Produces: `AREAS`, `AreaId`, `areaMeta`, `ORDER_STEP_STATES`, `OrderStepState`, `orderStepStateMeta` (from `lib/domain/enums`); `areaForOp(op: string): AreaId` (from `lib/logic/tracking`).

- [ ] **Step 1: Write the failing test** — append to `lib/domain/enums.test.ts`:

```ts
import { AREAS, areaMeta, ORDER_STEP_STATES, orderStepStateMeta } from "./enums";

describe("area + order-step-state metadata", () => {
  it("orders the areas received → shipped", () => {
    expect(AREAS).toEqual([
      "received", "rack", "in_process", "wash", "final_inspect", "available_to_ship", "shipped",
    ]);
  });
  it("has a label + tone for every area", () => {
    AREAS.forEach((a) => {
      expect(areaMeta[a].label.length).toBeGreaterThan(0);
      expect(["success", "info", "warn", "danger", "neutral"]).toContain(areaMeta[a].tone);
    });
  });
  it("has a label + tone for every order-step state", () => {
    ORDER_STEP_STATES.forEach((s) => {
      expect(orderStepStateMeta[s].label.length).toBeGreaterThan(0);
      expect(["success", "info", "warn", "danger", "neutral"]).toContain(orderStepStateMeta[s].tone);
    });
  });
});
```

And create `lib/logic/tracking.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { areaForOp } from "./tracking";

describe("areaForOp", () => {
  it("maps receiving, racking, wash, inspect, and ship ops", () => {
    expect(areaForOp("Receive & verify")).toBe("received");
    expect(areaForOp("Wash & rack")).toBe("rack");       // rack wins over wash
    expect(areaForOp("Final wash")).toBe("wash");
    expect(areaForOp("Final inspect")).toBe("final_inspect");
    expect(areaForOp("Certify & ship")).toBe("available_to_ship");
  });
  it("maps thermal ops to in_process (default)", () => {
    ["Carburize", "Temper", "Nitride", "Vacuum harden", "Anneal", "Carbonitride"].forEach((op) =>
      expect(areaForOp(op)).toBe("in_process"),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/domain/enums.test.ts lib/logic/tracking.test.ts`
Expected: FAIL — `AREAS` not exported / cannot find module `./tracking`.

- [ ] **Step 3: Implement** — append to `lib/domain/enums.ts` (after the existing `basisLabel`):

```ts
export const AREAS = ["received","rack","in_process","wash","final_inspect","available_to_ship","shipped"] as const;
export type AreaId = (typeof AREAS)[number];
export const areaMeta: Record<AreaId, { label: string; tone: StatusTone }> = {
  received: { label: "Received", tone: "neutral" },
  rack: { label: "Rack", tone: "neutral" },
  in_process: { label: "In Process", tone: "info" },
  wash: { label: "Wash", tone: "info" },
  final_inspect: { label: "Final Inspect", tone: "warn" },
  available_to_ship: { label: "Available to Ship", tone: "success" },
  shipped: { label: "Shipped", tone: "success" },
};

export const ORDER_STEP_STATES = ["pending","in_process","done"] as const;
export type OrderStepState = (typeof ORDER_STEP_STATES)[number];
export const orderStepStateMeta: Record<OrderStepState, { label: string; tone: StatusTone }> = {
  pending: { label: "Pending", tone: "neutral" },
  in_process: { label: "In process", tone: "info" },
  done: { label: "Done", tone: "success" },
};
```

Create `lib/logic/tracking.ts`:

```ts
import type { AreaId } from "@/lib/domain/enums";

/** Map a process-step op name to its shop area. Order matters: rack before wash. */
export function areaForOp(op: string): AreaId {
  const s = op.toLowerCase();
  if (/receiv/.test(s)) return "received";
  if (/rack/.test(s)) return "rack";
  if (/wash/.test(s)) return "wash";
  if (/inspect/.test(s)) return "final_inspect";
  if (/cert|ship/.test(s)) return "available_to_ship";
  return "in_process";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/domain/enums.test.ts lib/logic/tracking.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/enums.ts lib/domain/enums.test.ts lib/logic/tracking.ts lib/logic/tracking.test.ts
git commit -m "feat(tracking): area config, order-step-state enum, areaForOp mapper"
```

---

### Task 2: `OrderStep` domain type + `WorkOrder.steps` migration + `createOrderFromQuote`

**Files:**
- Modify: `lib/domain/entities.ts` (add `orderStepSchema`, change `workOrderSchema.steps`)
- Modify: `lib/domain/entities.test.ts` (append OrderStep parse case)
- Modify: `lib/logic/order.ts` (emit `OrderStep[]` from `createOrderFromQuote`)
- Modify: `lib/logic/order.test.ts` (assert live-state defaults)

**Interfaces:**
- Consumes: `areaForOp` (Task 1).
- Produces: `OrderStep` type + `orderStepSchema`; `WorkOrder.steps: OrderStep[]`.

- [ ] **Step 1: Write the failing test** — append to `lib/domain/entities.test.ts`:

```ts
import { orderStepSchema } from "./entities";

describe("orderStepSchema", () => {
  it("parses a live order step", () => {
    const step = {
      n: 1, op: "Carburize", equip: "Batch IQ #3", instr: "", params: ["1700°F"],
      track: "track_in_out" as const, areaId: "in_process" as const, state: "in_process" as const,
      operatorId: "op-dana", operatorInitials: "DM",
      trackedInAt: "2026-06-30T00:00:00.000Z", trackedOutAt: null, inspectResult: null,
    };
    expect(() => orderStepSchema.parse(step)).not.toThrow();
  });
});
```

And append to `lib/logic/order.test.ts` inside the existing `describe("order creation", ...)` block (after the "instantiates traveler steps" test):

```ts
  it("initializes every step to pending with an area and null stamps", () => {
    expect(order.steps[0].state).toBe("pending");
    expect(order.steps[0].areaId).toBe("received"); // "Receive & verify"
    expect(order.steps[0].trackedInAt).toBeNull();
    expect(order.steps[0].operatorId).toBeNull();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/domain/entities.test.ts lib/logic/order.test.ts`
Expected: FAIL — `orderStepSchema` not exported; `order.steps[0].state` undefined.

- [ ] **Step 3: Implement** — in `lib/domain/entities.ts`, add `orderStepSchema` right after `processStepSchema`/`ProcessStep` (lines ~66-74):

```ts
export const orderStepSchema = processStepSchema.extend({
  areaId: z.enum(AREAS),
  state: z.enum(ORDER_STEP_STATES),
  operatorId: z.string().nullable(),
  operatorInitials: z.string().nullable(),
  trackedInAt: z.string().nullable(),
  trackedOutAt: z.string().nullable(),
  inspectResult: z.enum(["pass", "fail"]).nullable(),
});
export type OrderStep = z.infer<typeof orderStepSchema>;
```

Extend the enum import at the top of `lib/domain/entities.ts` (the existing `from "./enums"` import) to also pull `AREAS` and `ORDER_STEP_STATES`:

```ts
import {
  QUOTE_STATUSES, ORDER_STATUSES, INVOICE_STATUSES, CERT_STATUSES,
  CUSTOMER_STATUSES, PRICING_BASES, ROLE_KEYS, AREAS, ORDER_STEP_STATES,
} from "./enums";
```

Change `workOrderSchema`'s `steps` field from `z.array(processStepSchema)` to:

```ts
  steps: z.array(orderStepSchema),
```

In `lib/logic/order.ts`, import `areaForOp` and `OrderStep`, then map the carried steps to live `OrderStep`s. Change the import block + the `steps` construction:

```ts
import type {
  Quote, Part, ProcessMaster, Customer, WorkOrder, OrderStatus, Certification, ActivityEntry, OrderStep,
} from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { quoteTotalCents, quoteSubtotalCents, lineAmountCents } from "./pricing";
import { areaForOp } from "./tracking";
```

Replace the existing `steps` line (currently `const steps = pmIds.flatMap(...).map((s, i) => ({ ...s, n: i + 1 }));`) with:

```ts
  const steps: OrderStep[] = pmIds
    .flatMap((id) => ctx.processMastersById[id]?.steps ?? [])
    .map((s, i) => ({
      ...s, n: i + 1, areaId: areaForOp(s.op), state: "pending",
      operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null,
    }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/domain/entities.test.ts lib/logic/order.test.ts`
Expected: PASS. (The existing multi-part `order.steps.map(s => s.op)` tests still pass — `op` and `n` are unchanged.)

- [ ] **Step 5: Verify the whole suite + types still build**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. (Seed still has `steps: []`, which is a valid empty `OrderStep[]` until Task 6 populates it.)

- [ ] **Step 6: Commit**

```bash
git add lib/domain/entities.ts lib/domain/entities.test.ts lib/logic/order.ts lib/logic/order.test.ts
git commit -m "feat(tracking): OrderStep type, migrate WorkOrder.steps, live steps from createOrderFromQuote"
```

---

### Task 3: Step state machine — `trackInStep`, `trackOutStep`, `stepActions`, `activeStep`

**Files:**
- Modify: `lib/logic/tracking.ts`
- Modify: `lib/logic/tracking.test.ts`

**Interfaces:**
- Consumes: `OrderStep` (Task 2).
- Produces:
  - `trackInStep(steps: OrderStep[], n: number, operator: { id: string; initials: string }, at: string): OrderStep[]`
  - `trackOutStep(steps: OrderStep[], n: number, operator: { id: string; initials: string }, at: string, inspectResult?: "pass" | "fail"): OrderStep[]`
  - `stepActions(step: OrderStep): { label: string; action: "in" | "out"; inspectResult?: "pass" | "fail" }[]`
  - `activeStep(steps: OrderStep[]): OrderStep | null`

- [ ] **Step 1: Write the failing test** — append to `lib/logic/tracking.test.ts`:

```ts
import { trackInStep, trackOutStep, stepActions, activeStep } from "./tracking";
import type { OrderStep } from "@/lib/domain";

function step(partial: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "track">): OrderStep {
  return {
    equip: "", instr: "", params: [], areaId: "in_process", state: "pending",
    operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null,
    ...partial,
  };
}
const op = { id: "op-dana", initials: "DM" };
const AT = "2026-07-01T00:00:00.000Z";

describe("trackInStep", () => {
  it("moves a pending step to in_process with stamps", () => {
    const s = trackInStep([step({ n: 1, op: "Carburize", track: "track_in_out" })], 1, op, AT);
    expect(s[0].state).toBe("in_process");
    expect(s[0].trackedInAt).toBe(AT);
    expect(s[0].operatorInitials).toBe("DM");
  });
  it("is a no-op on a non-pending step", () => {
    const s = trackInStep([step({ n: 1, op: "Carburize", track: "track_in_out", state: "done" })], 1, op, AT);
    expect(s[0].state).toBe("done");
  });
});

describe("trackOutStep", () => {
  it("completes an in_process step", () => {
    const s = trackOutStep([step({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process" })], 1, op, AT);
    expect(s[0].state).toBe("done");
    expect(s[0].trackedOutAt).toBe(AT);
  });
  it("completes a single-scan (pending) step directly", () => {
    const s = trackOutStep([step({ n: 1, op: "Certify & ship", track: "track_out" })], 1, op, AT);
    expect(s[0].state).toBe("done");
  });
  it("records an inspect pass as done", () => {
    const s = trackOutStep([step({ n: 1, op: "Final inspect", track: "inspect" })], 1, op, AT, "pass");
    expect(s[0].state).toBe("done");
    expect(s[0].inspectResult).toBe("pass");
  });
  it("records an inspect fail without completing the step", () => {
    const s = trackOutStep([step({ n: 1, op: "Final inspect", track: "inspect" })], 1, op, AT, "fail");
    expect(s[0].state).toBe("in_process");
    expect(s[0].inspectResult).toBe("fail");
  });
});

describe("stepActions", () => {
  it("offers Track In then Track Out for a track_in_out step", () => {
    expect(stepActions(step({ n: 1, op: "Carburize", track: "track_in_out" }))).toEqual([{ label: "Track In", action: "in" }]);
    expect(stepActions(step({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process" }))).toEqual([{ label: "Track Out", action: "out" }]);
  });
  it("offers a single scan for track_in and track_out", () => {
    expect(stepActions(step({ n: 1, op: "Receive & verify", track: "track_in" }))).toEqual([{ label: "Track In", action: "out" }]);
    expect(stepActions(step({ n: 1, op: "Certify & ship", track: "track_out" }))).toEqual([{ label: "Track Out", action: "out" }]);
  });
  it("offers Pass/Fail for an inspect step", () => {
    expect(stepActions(step({ n: 1, op: "Final inspect", track: "inspect" }))).toEqual([
      { label: "Pass", action: "out", inspectResult: "pass" },
      { label: "Fail", action: "out", inspectResult: "fail" },
    ]);
  });
  it("offers nothing for done or none steps", () => {
    expect(stepActions(step({ n: 1, op: "Carburize", track: "track_in_out", state: "done" }))).toEqual([]);
    expect(stepActions(step({ n: 1, op: "Hold", track: "none" }))).toEqual([]);
  });
});

describe("activeStep", () => {
  it("returns the first non-done trackable step", () => {
    const steps = [
      step({ n: 1, op: "Receive & verify", track: "track_in", state: "done" }),
      step({ n: 2, op: "Carburize", track: "track_in_out", state: "in_process" }),
      step({ n: 3, op: "Temper", track: "track_in_out" }),
    ];
    expect(activeStep(steps)?.n).toBe(2);
  });
  it("skips none steps and returns null when all trackable are done", () => {
    const steps = [
      step({ n: 1, op: "Carburize", track: "track_in_out", state: "done" }),
      step({ n: 2, op: "Note", track: "none" }),
    ];
    expect(activeStep(steps)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/logic/tracking.test.ts`
Expected: FAIL — `trackInStep` etc. not exported.

- [ ] **Step 3: Implement** — append to `lib/logic/tracking.ts`:

```ts
import type { OrderStep } from "@/lib/domain";

type Op = { id: string; initials: string };

export function trackInStep(steps: OrderStep[], n: number, op: Op, at: string): OrderStep[] {
  return steps.map((s) =>
    s.n === n && s.state === "pending"
      ? { ...s, state: "in_process", trackedInAt: at, operatorId: op.id, operatorInitials: op.initials }
      : s,
  );
}

export function trackOutStep(steps: OrderStep[], n: number, op: Op, at: string, inspectResult?: "pass" | "fail"): OrderStep[] {
  return steps.map((s) => {
    if (s.n !== n || s.state === "done" || s.track === "none") return s;
    const state = inspectResult === "fail" ? "in_process" : "done";
    return { ...s, state, trackedOutAt: at, operatorId: op.id, operatorInitials: op.initials, inspectResult: inspectResult ?? s.inspectResult };
  });
}

export type StepAction = { label: string; action: "in" | "out"; inspectResult?: "pass" | "fail" };

export function stepActions(step: OrderStep): StepAction[] {
  if (step.state === "done" || step.track === "none") return [];
  if (step.track === "inspect") {
    return [{ label: "Pass", action: "out", inspectResult: "pass" }, { label: "Fail", action: "out", inspectResult: "fail" }];
  }
  if (step.track === "track_in_out") {
    return step.state === "in_process" ? [{ label: "Track Out", action: "out" }] : [{ label: "Track In", action: "in" }];
  }
  if (step.track === "track_in") return [{ label: "Track In", action: "out" }];
  return [{ label: "Track Out", action: "out" }]; // track_out
}

export function activeStep(steps: OrderStep[]): OrderStep | null {
  return steps.find((s) => s.track !== "none" && s.state !== "done") ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/logic/tracking.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/tracking.ts lib/logic/tracking.test.ts
git commit -m "feat(tracking): step state machine (trackIn/trackOut/stepActions/activeStep)"
```

---

### Task 4: Status rollup, progress, board placement + resume-target transition

**Files:**
- Modify: `lib/logic/tracking.ts` (`rollUpOrderStatus`, `orderProgressPct`, `boardAreaForOrder`)
- Modify: `lib/logic/tracking.test.ts`
- Modify: `lib/logic/order.ts` (add `ready_to_ship` to `on_hold` transitions)
- Modify: `lib/logic/order.test.ts` (assert the new resume edge)

**Interfaces:**
- Consumes: `OrderStep`, `OrderStatus`, `WorkOrder`, `AreaId`, `activeStep`.
- Produces:
  - `rollUpOrderStatus(steps: OrderStep[], current: OrderStatus): OrderStatus`
  - `orderProgressPct(steps: OrderStep[]): number`
  - `boardAreaForOrder(order: WorkOrder): AreaId`

- [ ] **Step 1: Write the failing test** — append to `lib/logic/tracking.test.ts`:

```ts
import { rollUpOrderStatus, orderProgressPct, boardAreaForOrder } from "./tracking";
import type { WorkOrder } from "@/lib/domain";

const trackable = (state: OrderStep["state"], n: number, op = "Carburize", track: OrderStep["track"] = "track_in_out") =>
  step({ n, op, track, state, areaId: areaForOpArea(op) });
function areaForOpArea(op: string) { return areaForOp(op); }

describe("rollUpOrderStatus", () => {
  it("moves received → in_process on the first scan", () => {
    const steps = [trackable("in_process", 1), trackable("pending", 2)];
    expect(rollUpOrderStatus(steps, "received")).toBe("in_process");
  });
  it("moves to ready_to_ship when all trackable steps are done", () => {
    const steps = [trackable("done", 1), trackable("done", 2)];
    expect(rollUpOrderStatus(steps, "in_process")).toBe("ready_to_ship");
  });
  it("ignores none steps in the all-done check", () => {
    const steps = [trackable("done", 1), step({ n: 2, op: "Note", track: "none" })];
    expect(rollUpOrderStatus(steps, "in_process")).toBe("ready_to_ship");
  });
  it("never overrides on_hold or shipped", () => {
    const steps = [trackable("done", 1)];
    expect(rollUpOrderStatus(steps, "on_hold")).toBe("on_hold");
    expect(rollUpOrderStatus(steps, "shipped")).toBe("shipped");
  });
  it("stays received when nothing has started", () => {
    expect(rollUpOrderStatus([trackable("pending", 1)], "received")).toBe("received");
  });
});

describe("orderProgressPct", () => {
  it("counts done trackable steps only", () => {
    const steps = [trackable("done", 1), trackable("in_process", 2), step({ n: 3, op: "Note", track: "none" })];
    expect(orderProgressPct(steps)).toBe(50); // 1 of 2 trackable
  });
  it("is 0 with no trackable steps", () => {
    expect(orderProgressPct([step({ n: 1, op: "Note", track: "none" })])).toBe(0);
  });
});

describe("boardAreaForOrder", () => {
  const base = { status: "in_process" } as WorkOrder;
  it("places a shipped order in the shipped column", () => {
    expect(boardAreaForOrder({ ...base, status: "shipped", steps: [] } as WorkOrder)).toBe("shipped");
  });
  it("places an all-done order in available_to_ship", () => {
    expect(boardAreaForOrder({ ...base, steps: [trackable("done", 1, "Carburize")] } as WorkOrder)).toBe("available_to_ship");
  });
  it("places an active order in its active step's area", () => {
    const steps = [trackable("done", 1, "Receive & verify", "track_in"), trackable("in_process", 2, "Carburize")];
    expect(boardAreaForOrder({ ...base, steps } as WorkOrder)).toBe("in_process");
  });
  it("places a not-started order in received", () => {
    expect(boardAreaForOrder({ ...base, status: "received", steps: [] } as WorkOrder)).toBe("received");
  });
});
```

And append to `lib/logic/order.test.ts` inside `describe("order transitions", ...)`:

```ts
  it("permits on_hold -> ready_to_ship (resume when all steps done)", () => {
    expect(canTransitionOrder("on_hold", "ready_to_ship")).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/logic/tracking.test.ts lib/logic/order.test.ts`
Expected: FAIL — `rollUpOrderStatus` not exported; `on_hold -> ready_to_ship` returns false.

- [ ] **Step 3: Implement** — append to `lib/logic/tracking.ts`:

```ts
import type { OrderStatus, WorkOrder } from "@/lib/domain";

const trackableSteps = (steps: OrderStep[]) => steps.filter((s) => s.track !== "none");

export function rollUpOrderStatus(steps: OrderStep[], current: OrderStatus): OrderStatus {
  if (current === "on_hold" || current === "shipped") return current;
  const t = trackableSteps(steps);
  if (t.length > 0 && t.every((s) => s.state === "done")) return "ready_to_ship";
  if (t.some((s) => s.state !== "pending") && (current === "received" || current === "scheduled")) return "in_process";
  return current;
}

export function orderProgressPct(steps: OrderStep[]): number {
  const t = trackableSteps(steps);
  if (t.length === 0) return 0;
  return Math.round((t.filter((s) => s.state === "done").length / t.length) * 100);
}

export function boardAreaForOrder(order: WorkOrder): AreaId {
  if (order.status === "shipped") return "shipped";
  const active = activeStep(order.steps);
  if (!active) {
    return trackableSteps(order.steps).length > 0 ? "available_to_ship" : "received";
  }
  return active.areaId;
}
```

In `lib/logic/order.ts`, change the `on_hold` line of `ORDER_TRANSITIONS`:

```ts
  on_hold: ["received", "scheduled", "in_process", "ready_to_ship"],
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/logic/tracking.test.ts lib/logic/order.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/tracking.ts lib/logic/tracking.test.ts lib/logic/order.ts lib/logic/order.test.ts
git commit -m "feat(tracking): status rollup, progress, board placement; on_hold resume edge"
```

---

### Task 5: Credit-hold ship gate

**Files:**
- Modify: `lib/logic/order.ts` (`canShipOrder` gains an optional `customer`)
- Modify: `lib/logic/order.test.ts`

**Interfaces:**
- Consumes: `WorkOrder`, `Certification`, `Customer`.
- Produces: `canShipOrder(order: WorkOrder, cert: Certification | null, customer?: Customer | null): { ok: boolean; reason?: string }` — **`customer` is optional** so the existing 2-arg callers/tests keep passing.

- [ ] **Step 1: Write the failing test** — append to `lib/logic/order.test.ts` inside `describe("ship gate", ...)`:

```ts
  it("blocks ship when the customer is on credit hold", () => {
    const o = { certifyRequired: false } as WorkOrder;
    const held = { status: "hold" } as Customer;
    const gate = canShipOrder(o, null, held);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/credit hold/i);
  });
  it("allows ship for an active customer with no cert required", () => {
    const o = { certifyRequired: false } as WorkOrder;
    expect(canShipOrder(o, null, { status: "active" } as Customer).ok).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/logic/order.test.ts -t "credit hold"`
Expected: FAIL — hold customer still returns `ok: true` (customer ignored).

- [ ] **Step 3: Implement** — replace `canShipOrder` in `lib/logic/order.ts`:

```ts
export function canShipOrder(order: WorkOrder, cert: Certification | null, customer?: Customer | null): { ok: boolean; reason?: string } {
  if (customer?.status === "hold") return { ok: false, reason: "Customer on credit hold — shipment blocked" };
  if (!order.certifyRequired) return { ok: true };
  if (cert?.status === "released") return { ok: true };
  return { ok: false, reason: "Certification must be released before ship" };
}
```

- [ ] **Step 4: Run to verify it passes (and the whole logic suite is green)**

Run: `npx vitest run lib/logic && npx tsc --noEmit`
Expected: PASS — the existing 2-arg ship-gate tests still pass (`customer` is optional).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/order.ts lib/logic/order.test.ts
git commit -m "feat(tracking): credit-hold ship gate in canShipOrder"
```

---

### Task 6: Seed live traveler steps + a credit-hold ready-to-ship order

**Files:**
- Modify: `lib/data/seed/index.ts`

**Interfaces:**
- Consumes: `areaForOp` (Task 1), `orderProgressPct` (Task 4).
- Produces: every seed `WorkOrder.steps` is a populated `OrderStep[]`; the Vulcan order `wo-48098` is `ready_to_ship` (all steps done) for the credit-hold demo.

- [ ] **Step 1: Write the failing test** — append to `lib/data/seed/seed.test.ts` inside `describe("seed", ...)`:

```ts
  it("populates live traveler steps on every work order", () => {
    s.workOrders.forEach((w) => {
      expect(w.steps.length).toBeGreaterThan(0);
      w.steps.forEach((st) => {
        expect(["pending", "in_process", "done"]).toContain(st.state);
        expect(st.areaId).toBeTruthy();
      });
    });
  });
  it("has a credit-hold order that is ready to ship (Vulcan)", () => {
    const held = s.workOrders.find((w) => w.customerId === "cust-vulcan" && w.status === "ready_to_ship");
    expect(held).toBeTruthy();
    expect(held!.steps.every((st) => st.state === "done")).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/data/seed/seed.test.ts`
Expected: FAIL — seed orders have `steps: []`; no Vulcan ready-to-ship order.

- [ ] **Step 3: Implement** — in `lib/data/seed/index.ts`, add imports at the top (after the domain type imports):

```ts
import { areaForOp, orderProgressPct } from "@/lib/logic/tracking";
import type { OrderStep } from "@/lib/domain";
```

Add this helper inside `buildSeed()`, immediately before `const workOrders: WorkOrder[] = [` (it reads the already-declared `processMasters` const):

```ts
  // Build live OrderStep[] for a work order from its process master's steps + a per-step state list.
  function liveSteps(pmId: string, states: OrderStep["state"][]): OrderStep[] {
    const pmSteps = processMasters.find((m) => m.id === pmId)?.steps ?? [];
    return pmSteps.map((s, i) => {
      const state = states[i] ?? "pending";
      const acted = state !== "pending";
      return {
        ...s, areaId: areaForOp(s.op), state,
        operatorId: acted ? "op-dana" : null,
        operatorInitials: acted ? "DM" : null,
        trackedInAt: acted ? "2026-06-30T00:00:00.000Z" : null,
        trackedOutAt: state === "done" ? "2026-06-30T00:00:00.000Z" : null,
        inspectResult: null,
      };
    });
  }
```

Now set `steps` (and matching `progressPct`) on each work order. Replace each order's `steps: [],` and its `progressPct` value as follows (leave all other fields untouched):

- `wo-48211` (pm-carb58, 6 steps) — `steps: liveSteps("pm-carb58", ["done","in_process","pending","pending","pending","pending"]),` and `progressPct: orderProgressPct(liveSteps("pm-carb58", ["done","in_process","pending","pending","pending","pending"])),`
- `wo-48205` (pm-vac44, 4 steps) — `steps: liveSteps("pm-vac44", ["done","done","pending","pending"]),` and `progressPct: orderProgressPct(liveSteps("pm-vac44", ["done","done","pending","pending"])),`
- `wo-48190` (pm-nit09, 3 steps) — `steps: liveSteps("pm-nit09", ["done","in_process","pending"]),` and `progressPct: orderProgressPct(liveSteps("pm-nit09", ["done","in_process","pending"])),`
- `wo-48177` (pm-cn21, 3 steps) — `steps: liveSteps("pm-cn21", ["done","done","pending"]),` and `progressPct: orderProgressPct(liveSteps("pm-cn21", ["done","done","pending"])),`
- `wo-48142` (pm-nh15, 4 steps, on_hold) — `steps: liveSteps("pm-nh15", ["done","in_process","pending","pending"]),` and `progressPct: orderProgressPct(liveSteps("pm-nh15", ["done","in_process","pending","pending"])),`
- `wo-48120` (pm-nh15, 4 steps, ready_to_ship) — `steps: liveSteps("pm-nh15", ["done","done","done","done"]),` and `progressPct: 100,`
- `wo-48098` (pm-ann03, 3 steps) — change `status: "received"` to `status: "ready_to_ship"`, set `steps: liveSteps("pm-ann03", ["done","done","done"]),` and `progressPct: 100,`. Also update its activity to reflect completion:

```ts
      activity: [
        { at: "2026-06-28T00:00:00.000Z", actor: "System", message: "Order received" },
        { at: "2026-06-30T00:00:00.000Z", actor: "System", message: "Ready to ship" },
      ],
```

> Note: to avoid repeating the `liveSteps(...)` call twice per order, you may hoist it to a local `const` per order (e.g. `const s48211 = liveSteps("pm-carb58", [...]);` then `steps: s48211, progressPct: orderProgressPct(s48211),`). Either form is fine; keep it readable.

- [ ] **Step 4: Run to verify it passes (seed + schema validation + full suite)**

Run: `npx vitest run lib/data && npx vitest run && npx tsc --noEmit`
Expected: PASS. (The `workOrderSchema.parse` seed test now validates the populated `OrderStep[]`. The existing `useShipOrder`/idempotency mutation tests still pass — `wo-48120` remains `ready_to_ship` with its existing `inv-summit-48120`.)

- [ ] **Step 5: Commit**

```bash
git add lib/data/seed/index.ts lib/data/seed/seed.test.ts
git commit -m "feat(tracking): seed live traveler steps + Vulcan credit-hold ready-to-ship order"
```

---

### Task 7: Track mutations + credit-hold guards

**Files:**
- Modify: `lib/query/hooks.ts`
- Modify: `tests/mutation-hooks.test.tsx`

**Interfaces:**
- Consumes: `trackInStep`, `trackOutStep`, `rollUpOrderStatus`, `orderProgressPct`, `activeStep` (Tasks 3-4); `canShipOrder` (Task 5); `activityEntry` (existing).
- Produces:
  - `useTrackInStep()` → `mutate({ order: WorkOrder; stepN: number; operator: Operator })`
  - `useTrackOutStep()` → `mutate({ order: WorkOrder; stepN: number; operator: Operator; cert: Certification | null; inspectResult?: "pass" | "fail" })`
  - `useShipOrder()` and `useWinQuote()` gain the credit-hold block (`useShipOrder` vars gain optional `customer`).

- [ ] **Step 1: Write the failing test** — append to `tests/mutation-hooks.test.tsx`. Add the new hooks to the import on line 7 (`useTrackInStep, useTrackOutStep`) and `useOperators` for the actor, then append these probes + tests at the end of the file:

```ts
// ---------------------------------------------------------------------------
// Probe G: useTrackInStep / useTrackOutStep drive status + progress
// wo-48098 (Vulcan) is ready_to_ship in seed; use wo-48211 (Apex, in_process) which
// starts with step 1 done, step 2 in_process (Wash & rack), rest pending.
// ---------------------------------------------------------------------------
function TrackProbe() {
  const orders = useWorkOrders();
  const ops = useOperators();
  const trackOut = useTrackOutStep();
  const order = orders.data?.find((o) => o.id === "wo-48211");
  const operator = ops.data?.find((o) => o.id === "op-dana");
  return (
    <div>
      <div data-testid="progress">{order?.progressPct ?? "loading"}</div>
      <div data-testid="step2">{order?.steps.find((s) => s.n === 2)?.state ?? "loading"}</div>
      <button
        disabled={!order || !operator}
        onClick={() => order && operator && trackOut.mutate({ order, stepN: 2, operator, cert: null })}
      >TrackOut2</button>
    </div>
  );
}

// Probe H: inspect pass auto-releases the pending cert.
// wo-48211 has cert-9921 (pending). Track out its Final inspect (step 5) with pass.
function InspectPassProbe() {
  const orders = useWorkOrders();
  const certs = useCertifications();
  const ops = useOperators();
  const trackOut = useTrackOutStep();
  const order = orders.data?.find((o) => o.id === "wo-48211");
  const operator = ops.data?.find((o) => o.id === "op-dana");
  const cert = certs.data?.find((c) => c.workOrderId === "wo-48211") ?? null;
  return (
    <div>
      <div data-testid="cert-status">{cert?.status ?? "loading"}</div>
      <button
        disabled={!order || !operator}
        onClick={() => order && operator && trackOut.mutate({ order, stepN: 5, operator, cert, inspectResult: "pass" })}
      >InspectPass</button>
    </div>
  );
}

// Probe I: shipping a credit-hold customer's order is blocked.
function ShipHeldProbe() {
  const orders = useWorkOrders();
  const customers = useCustomers();
  const ship = useShipOrder();
  const order = orders.data?.find((o) => o.id === "wo-48098"); // Vulcan, ready_to_ship
  const customer = customers.data?.find((c) => c.id === "cust-vulcan") ?? null;
  return (
    <div>
      <div data-testid="ship-error">{ship.isError ? "error" : "ok"}</div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <button
        disabled={!order}
        onClick={() => order && ship.mutate({ order, cert: null, customer, actor: "Test", at: "2026-07-01T00:00:00.000Z" })}
      >ShipHeld</button>
    </div>
  );
}

describe("tracking mutations", () => {
  it("useTrackOutStep: completes a step and advances progress", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackProbe />);
    await waitFor(() => expect(screen.getByTestId("step2").textContent).toBe("in_process"));
    await user.click(screen.getByRole("button", { name: "TrackOut2" }));
    await waitFor(() => expect(screen.getByTestId("step2").textContent).toBe("done"));
    await waitFor(() => expect(Number(screen.getByTestId("progress").textContent)).toBe(33)); // 2 of 6 trackable
  });

  it("useTrackOutStep: inspect pass auto-releases the pending cert", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InspectPassProbe />);
    await waitFor(() => expect(screen.getByTestId("cert-status").textContent).toBe("pending"));
    await user.click(screen.getByRole("button", { name: "InspectPass" }));
    await waitFor(() => expect(screen.getByTestId("cert-status").textContent).toBe("released"));
  });

  it("useShipOrder: a credit-hold customer's order cannot ship", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipHeldProbe />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready_to_ship"));
    await user.click(screen.getByRole("button", { name: "ShipHeld" }));
    await waitFor(() => expect(screen.getByTestId("ship-error").textContent).toBe("error"));
    expect(screen.getByTestId("status").textContent).toBe("ready_to_ship"); // not shipped
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mutation-hooks.test.tsx`
Expected: FAIL — `useTrackInStep`/`useTrackOutStep` not exported; ship-held not blocked.

- [ ] **Step 3: Implement** — in `lib/query/hooks.ts`:

Extend the domain-type import (line 3) to include `Customer` and `OrderStep`, and the logic import (line 10) to include the tracking functions:

```ts
import type { Part, Quote, Operator, WorkOrder, OrderStatus, Certification, Invoice, Customer } from "@/lib/domain";
```

```ts
import { createOrderFromQuote, createCertForOrder, canTransitionOrder, canShipOrder, activityEntry } from "@/lib/logic/order";
import { trackInStep, trackOutStep, rollUpOrderStatus, orderProgressPct } from "@/lib/logic/tracking";
```

Add the two new mutations (place them just after `useShipOrder`):

```ts
export function useTrackInStep() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { order: WorkOrder; stepN: number; operator: Operator }) => {
      const at = new Date().toISOString();
      const step = vars.order.steps.find((s) => s.n === vars.stepN);
      const steps = trackInStep(vars.order.steps, vars.stepN, { id: vars.operator.id, initials: vars.operator.initials }, at);
      const status = rollUpOrderStatus(steps, vars.order.status);
      const activity = [...vars.order.activity, activityEntry(vars.operator.name, `Tracked in ${step?.op ?? "step"} · ${step?.equip ?? ""}`.trim(), at)];
      return r.workOrders.update(vars.order.id, { steps, status, progressPct: orderProgressPct(steps), activity }, vars.order.version);
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
    },
  });
}

export function useTrackOutStep() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; stepN: number; operator: Operator; cert: Certification | null; inspectResult?: "pass" | "fail" }) => {
      const at = new Date().toISOString();
      const step = vars.order.steps.find((s) => s.n === vars.stepN);
      const steps = trackOutStep(vars.order.steps, vars.stepN, { id: vars.operator.id, initials: vars.operator.initials }, at, vars.inspectResult);
      const failed = vars.inspectResult === "fail";
      const status = failed ? "on_hold" : rollUpOrderStatus(steps, vars.order.status);
      const message = failed
        ? `Final inspect failed — order on hold`
        : vars.inspectResult === "pass"
          ? `Final inspect passed`
          : `Tracked out ${step?.op ?? "step"}`;
      const activity = [...vars.order.activity, activityEntry(vars.operator.name, message, at)];
      // Version-check the order update FIRST; a stale order throws before the cert write.
      const updated = await r.workOrders.update(vars.order.id, { steps, status, progressPct: orderProgressPct(steps), activity }, vars.order.version);
      // Inspect pass auto-releases a required pending cert (dependent write, WO-first ordering).
      if (vars.inspectResult === "pass" && vars.cert && vars.cert.status === "pending") {
        await r.certifications.update(vars.cert.id, { status: "released" }, vars.cert.version);
      }
      return updated;
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.certifications });
    },
  });
}
```

Add the credit-hold block to `useShipOrder` — change its `mutationFn` vars to include an optional `customer`, and pass it to `canShipOrder`:

```ts
    mutationFn: async (vars: { order: WorkOrder; cert: Certification | null; actor: string; at: string; customer?: Customer | null }) => {
      const gate = canShipOrder(vars.order, vars.cert, vars.customer);
      if (!gate.ok) throw new Error(gate.reason ?? "Cannot ship");
```

(Leave the rest of `useShipOrder` unchanged.)

Add the credit-hold block to `useWinQuote` — right after the `if (!customer) throw ...` line, insert:

```ts
      if (customer.status === "hold") throw new Error("Customer on credit hold — cannot create order");
```

- [ ] **Step 4: Run to verify it passes (and the existing mutation tests still pass)**

Run: `npx vitest run tests/mutation-hooks.test.tsx`
Expected: PASS — including the pre-existing `useShipOrder` idempotency/stale tests (they pass no `customer`, so the hold check is skipped) and `useWinQuote` (Midwest is active).

- [ ] **Step 5: Commit**

```bash
git add lib/query/hooks.ts tests/mutation-hooks.test.tsx
git commit -m "feat(tracking): track-in/out mutations, inspect auto-release, credit-hold guards"
```

---

### Task 8: Order Detail live traveler (replace manual forward buttons)

**Files:**
- Modify: `components/orders/order-detail.tsx`
- Modify: `components/orders/order-detail.test.tsx`
- Modify: `app/(app)/orders/[id]/page.tsx`

**Interfaces:**
- Consumes: `stepActions`, `activeStep`, `rollUpOrderStatus` (tracking); `canShipOrder`, `ORDER_TRANSITIONS` (order); `orderStepStateMeta`, `areaMeta` (enums); `useTrackInStep`, `useTrackOutStep` (hooks).
- Produces: `OrderDetail` with new props `onTrackIn(stepN: number)`, `onTrackOut(stepN: number, inspectResult?: "pass" | "fail")`, `onHold()`, `onResume()`, and `customer` used for the hold gate. Removes the manual forward-status buttons.

- [ ] **Step 1: Write the failing test** — replace `components/orders/order-detail.test.tsx` with:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderDetail } from "./order-detail";
import type { WorkOrder, Customer, ProcessMaster, Certification, OrderStep } from "@/lib/domain";

function ostep(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "track" | "state">): OrderStep {
  return {
    equip: "Batch IQ #3", instr: "", params: [], areaId: "in_process",
    operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p,
  };
}

const cust: Customer = {
  id: "c1", createdAt: "", updatedAt: "", version: 1, customerNumber: "1042", name: "Apex Aerospace",
  initials: "AA", city: "", billingAddress: "", phone: "", terms: "Net 30", status: "active",
  priceKeyId: null, taxExempt: false, defaultCertSpecId: "spec-1", defaultCertCopies: 1, ytdSalesCents: 0,
};
const heldCust: Customer = { ...cust, status: "hold" };

const baseOrder: WorkOrder = {
  id: "wo-1", createdAt: "", updatedAt: "", version: 1, number: "WO-48211", customerId: "c1",
  customerPO: "PO-999", quoteId: "q1", processSummary: "Carburize + Temper", processMasterId: "pm-1",
  status: "in_process", orderedDate: "2026-06-01T00:00:00.000Z", due: "2026-07-01T00:00:00.000Z",
  certifyRequired: true, certSpecId: "spec-1", orderValueCents: 320000, progressPct: 0,
  lines: [], pricing: [{ process: "Carburize", detail: "600 lb", amountCents: 320000 }],
  steps: [
    ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "done" }),
    ostep({ n: 2, op: "Temper", track: "track_in_out", state: "pending" }),
  ],
  activity: [{ at: "2026-06-01T00:00:00.000Z", actor: "System", message: "Order received" }],
};

const pm: ProcessMaster = {
  id: "pm-1", createdAt: "", updatedAt: "", version: 1, code: "PM-CARB-58", name: "Carburize & Temper",
  description: "", rev: "A", status: "active",
  steps: [{ n: 1, op: "Carburize", equip: "Furnace A", instr: "", params: [], track: "track_in_out" }],
  surfaceHardness: "62 HRC", caseDepth: "0.030\"", hardnessScale: "HRC",
};

const pendingCert: Certification = {
  id: "cert-1", createdAt: "", updatedAt: "", version: 1, number: "C-9921", customerId: "c1",
  workOrderId: "wo-1", specificationId: "spec-1", type: "Carburize + Temper", status: "pending", copies: 1,
};
const releasedCert: Certification = { ...pendingCert, status: "released" };

const readyOrder: WorkOrder = {
  ...baseOrder, status: "ready_to_ship",
  steps: [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "done" })],
};

function noop() {}
const handlers = { onRelease: noop, onShip: noop, onTrackIn: noop, onTrackOut: noop, onHold: noop, onResume: noop };

describe("OrderDetail traveler", () => {
  it("shows the Track Out action on the active step and fires onTrackOut", async () => {
    const onTrackOut = vi.fn();
    render(<OrderDetail order={{ ...baseOrder, steps: [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process" })] }}
      customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} onTrackOut={onTrackOut} />);
    const row = screen.getByTestId("traveler-step-1");
    await userEvent.click(within(row).getByRole("button", { name: "Track Out" }));
    expect(onTrackOut).toHaveBeenCalledWith(1, undefined);
  });

  it("offers Pass/Fail on an inspect step and passes the result", async () => {
    const onTrackOut = vi.fn();
    render(<OrderDetail order={{ ...baseOrder, steps: [ostep({ n: 1, op: "Final inspect", track: "inspect", state: "pending", areaId: "final_inspect" })] }}
      customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} onTrackOut={onTrackOut} />);
    const row = screen.getByTestId("traveler-step-1");
    await userEvent.click(within(row).getByRole("button", { name: "Pass" }));
    expect(onTrackOut).toHaveBeenCalledWith(1, "pass");
  });

  it("does NOT render manual forward-status buttons", () => {
    render(<OrderDetail order={baseOrder} customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} />);
    expect(screen.queryByRole("button", { name: "Ready to ship" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scheduled" })).not.toBeInTheDocument();
  });

  it("blocks ship for a credit-hold customer with a reason", () => {
    render(<OrderDetail order={readyOrder} customer={heldCust} processMaster={pm} cert={releasedCert} canRelease={false} busy={false} {...handlers} />);
    expect(screen.getByRole("button", { name: /^ship$/i })).toBeDisabled();
    expect(screen.getByText(/credit hold/i)).toBeInTheDocument();
  });

  it("allows ship when cert released + customer active and fires onShip", async () => {
    const onShip = vi.fn();
    render(<OrderDetail order={readyOrder} customer={cust} processMaster={pm} cert={releasedCert} canRelease={false} busy={false} {...handlers} onShip={onShip} />);
    await userEvent.click(screen.getByRole("button", { name: /^ship$/i }));
    expect(onShip).toHaveBeenCalled();
  });

  it("shows Release for a pending cert when canRelease", () => {
    render(<OrderDetail order={readyOrder} customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} />);
    expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run components/orders/order-detail.test.tsx`
Expected: FAIL — new props/testids/behavior not implemented.

- [ ] **Step 3: Implement** — replace `components/orders/order-detail.tsx` with:

```tsx
import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { orderStatusMeta, certStatusMeta, orderStepStateMeta, areaMeta } from "@/lib/domain/enums";
import { canShipOrder } from "@/lib/logic/order";
import { stepActions, activeStep, rollUpOrderStatus } from "@/lib/logic/tracking";
import { formatMoney, formatDate } from "@/lib/utils";
import type { WorkOrder, Customer, ProcessMaster, Certification } from "@/lib/domain";

export function OrderDetail({
  order, customer, processMaster, cert, canRelease, busy,
  onRelease, onShip, onTrackIn, onTrackOut, onHold, onResume,
}: {
  order: WorkOrder; customer: Customer | null; processMaster: ProcessMaster | null; cert: Certification | null;
  canRelease: boolean; busy: boolean;
  onRelease: () => void; onShip: () => void;
  onTrackIn: (stepN: number) => void; onTrackOut: (stepN: number, inspectResult?: "pass" | "fail") => void;
  onHold: () => void; onResume: () => void;
}) {
  const meta = orderStatusMeta[order.status];
  const gate = canShipOrder(order, cert, customer);
  const active = activeStep(order.steps);
  const canHold = order.status !== "shipped" && order.status !== "on_hold";
  const actions = (
    <>
      {order.status === "on_hold" && <Button size="sm" variant="outline" disabled={busy} onClick={onResume}>Resume</Button>}
      {canHold && <Button size="sm" variant="outline" disabled={busy} onClick={onHold}>On Hold</Button>}
      {order.status === "ready_to_ship" && <Button size="sm" disabled={busy || !gate.ok} onClick={onShip}>Ship</Button>}
    </>
  );

  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/orders" backLabel="Orders" title={<MonoId>{order.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · PO ${order.customerPO || "—"} · ${order.processSummary}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>} actions={actions} />

        {order.status === "ready_to_ship" && !gate.ok && (
          <p className="mb-4 rounded-card border border-status-warn-tint bg-status-warn-tint px-3 py-2 text-xs text-status-warn">{gate.reason}</p>
        )}

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">Progress</span>
            <span className="font-mono text-xs text-text-muted" data-testid="order-progress">{order.progressPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-canvas-alt">
            <div className="h-2 rounded-full bg-primary" style={{ width: `${order.progressPct}%` }} />
          </div>
        </div>

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Pricing</div>
          <table className="w-full text-[13px]">
            <tbody>
              {order.pricing.map((l, i) => (
                <tr key={i} className="border-t border-border-faint first:border-0">
                  <td className="py-1">{l.process}{l.detail ? ` · ${l.detail}` : ""}</td>
                  <td className="text-right font-mono">{formatMoney(l.amountCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-border"><td className="py-1 font-semibold">Total</td>
                <td className="text-right font-mono font-semibold">{formatMoney(order.orderValueCents)}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Traveler {processMaster && <span className="font-mono text-xs text-text-muted">· {processMaster.code} rev {processMaster.rev}</span>}</div>
          {order.steps.length > 0 ? (
            <ol className="space-y-2 text-[13px]">
              {order.steps.map((s) => {
                const sm = orderStepStateMeta[s.state];
                const isActive = active?.n === s.n;
                return (
                  <li key={s.n} data-testid={`traveler-step-${s.n}`} className="flex items-start justify-between gap-3 border-t border-border-faint pt-2 first:border-0 first:pt-0">
                    <div className="flex gap-3">
                      <span className="font-mono text-text-muted">{s.n}</span>
                      <div>
                        <div className="font-medium">{s.op} <span className="text-text-muted">· {s.equip}</span></div>
                        <div className="text-xs text-text-muted">
                          {areaMeta[s.areaId].label}
                          {s.operatorInitials && <span className="font-mono"> · {s.operatorInitials}</span>}
                          {s.trackedOutAt && <span className="font-mono"> · {formatDate(s.trackedOutAt)}</span>}
                        </div>
                        {s.params.length > 0 && <div className="font-mono text-xs text-text-muted">{s.params.join(" · ")}</div>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
                      {isActive && stepActions(s).map((a) => (
                        <Button key={a.label} size="sm" variant="outline" disabled={busy}
                          onClick={() => (a.action === "in" ? onTrackIn(s.n) : onTrackOut(s.n, a.inspectResult))}>
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-text-muted text-xs">No traveler steps.</p>}
        </div>

        <div className="rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Activity</div>
          <ul className="space-y-2 text-[13px]">
            {order.activity.map((a, i) => (
              <li key={i} className="flex justify-between border-t border-border-faint pt-2 first:border-0 first:pt-0">
                <span>{a.message} <span className="text-text-muted">· {a.actor}</span></span>
                <span className="font-mono text-text-muted">{formatDate(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <SummaryRail title="Order">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Ordered</dt><dd className="font-mono">{formatDate(order.orderedDate)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Due</dt><dd className="font-mono">{formatDate(order.due)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Value</dt><dd className="font-mono">{formatMoney(order.orderValueCents)}</dd></div>
        </dl>
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 font-semibold">Certification</div>
          {order.certifyRequired && cert ? (
            <div className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <MonoId>{cert.number}</MonoId>
                <StatusPill tone={certStatusMeta[cert.status].tone}>{certStatusMeta[cert.status].label}</StatusPill>
              </div>
              {cert.status === "pending" && canRelease && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onRelease}>Release</Button>
              )}
            </div>
          ) : order.certifyRequired ? (
            <p className="text-text-muted text-xs">Cert pending generation.</p>
          ) : (
            <p className="text-text-muted text-xs">No certification required.</p>
          )}
        </div>
      </SummaryRail>
    </div>
  );
}

export { rollUpOrderStatus }; // re-exported for the page glue's resume target
```

> `rollUpOrderStatus` is imported here for possible use; the page computes the resume target (Step 3 below). Remove the trailing re-export if your linter flags it as unused — the page imports `rollUpOrderStatus` directly from `@/lib/logic/tracking`. (Prefer removing it.)

Now wire `app/(app)/orders/[id]/page.tsx` — replace it with:

```tsx
"use client";
import { use } from "react";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useWorkOrder, useCustomer, useProcessMaster, useCertifications,
  useReleaseCertification, useTransitionOrder, useShipOrder, useTrackInStep, useTrackOutStep,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OrderDetail } from "@/components/orders/order-detail";
import { rollUpOrderStatus } from "@/lib/logic/tracking";

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { operator } = useAuth();
  const canRelease = useCan("release_cert");
  const order = useWorkOrder(id);
  const customer = useCustomer(order.data?.customerId ?? "");
  const pm = useProcessMaster(order.data?.processMasterId ?? "");
  const certs = useCertifications();
  const release = useReleaseCertification();
  const transition = useTransitionOrder();
  const ship = useShipOrder();
  const trackIn = useTrackInStep();
  const trackOut = useTrackOutStep();

  if (order.isLoading || !operator) return <SkeletonRows />;
  if (order.isError) return <ErrorPanel message="Failed to load order." onRetry={() => order.refetch()} />;
  if (!order.data) return <EmptyState title="Order not found" />;
  const o = order.data;

  if (o.certifyRequired && certs.isLoading) return <SkeletonRows />;
  if (o.certifyRequired && certs.isError)
    return <ErrorPanel message="Failed to load certification." onRetry={() => { order.refetch(); certs.refetch(); }} />;

  const cert = (certs.data ?? []).find((c) => c.workOrderId === o.id) ?? null;
  const now = () => new Date().toISOString();
  const actor = operator.name;
  const busy = release.isPending || transition.isPending || ship.isPending || trackIn.isPending || trackOut.isPending;

  return (
    <OrderDetail
      order={o} customer={customer.data ?? null} processMaster={pm.data ?? null} cert={cert}
      canRelease={canRelease} busy={busy}
      onRelease={() => cert && release.mutate({ id: cert.id, version: cert.version })}
      onShip={() => ship.mutate({ order: o, cert, actor, at: now(), customer: customer.data ?? null })}
      onTrackIn={(stepN) => trackIn.mutate({ order: o, stepN, operator })}
      onTrackOut={(stepN, inspectResult) => trackOut.mutate({ order: o, stepN, operator, cert, inspectResult })}
      onHold={() => transition.mutate({ order: o, to: "on_hold", actor, at: now() })}
      onResume={() => transition.mutate({ order: o, to: rollUpOrderStatus(o.steps, "received"), actor, at: now() })}
    />
  );
}
```

> Also delete the now-dead re-export line at the bottom of `order-detail.tsx` (`export { rollUpOrderStatus };`) so eslint's no-unused/import rules stay green — the page imports it from the logic module directly.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run components/orders/order-detail.test.tsx && npx tsc --noEmit && npx eslint app/\(app\)/orders/\[id\]/page.tsx components/orders/order-detail.tsx --max-warnings 0`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/orders/order-detail.tsx components/orders/order-detail.test.tsx "app/(app)/orders/[id]/page.tsx"
git commit -m "feat(tracking): live Order Detail traveler with track actions, hold/resume, credit-hold gate"
```

---

### Task 9: Tracking board (kanban) + route

**Files:**
- Create: `components/tracking/tracking-board.tsx`
- Create: `components/tracking/tracking-board.test.tsx`
- Modify: `app/(app)/tracking/page.tsx` (replace the placeholder)

**Interfaces:**
- Consumes: `boardAreaForOrder`, `activeStep`, `stepActions` (tracking); `AREAS`, `areaMeta`, `orderStatusMeta` (enums); `isLate` (dashboard); `WorkOrder`, `Customer`, `Operator`.
- Produces: `TrackingBoard` component:

```ts
TrackingBoard(props: {
  orders: WorkOrder[]; customers: Customer[]; asOf: string; busy: boolean;
  onTrackIn: (order: WorkOrder, stepN: number) => void;
  onTrackOut: (order: WorkOrder, stepN: number, inspectResult?: "pass" | "fail") => void;
})
```

- [ ] **Step 1: Write the failing test** — create `components/tracking/tracking-board.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackingBoard } from "./tracking-board";
import type { WorkOrder, Customer, OrderStep } from "@/lib/domain";

function ostep(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "track" | "state" | "areaId">): OrderStep {
  return { equip: "", instr: "", params: [], operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p };
}
const cust: Customer = {
  id: "c1", createdAt: "", updatedAt: "", version: 1, customerNumber: "1", name: "Apex Aerospace",
  initials: "AA", city: "", billingAddress: "", phone: "", terms: "Net 30", status: "active",
  priceKeyId: null, taxExempt: false, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0,
};
function order(id: string, steps: OrderStep[], status: WorkOrder["status"] = "in_process", due = "2026-08-01T00:00:00.000Z"): WorkOrder {
  return {
    id, createdAt: "", updatedAt: "", version: 1, number: id.toUpperCase(), customerId: "c1", customerPO: "",
    quoteId: null, processSummary: "Carburize", processMasterId: null, status, orderedDate: "2026-06-01T00:00:00.000Z",
    due, certifyRequired: false, certSpecId: null, orderValueCents: 1000, progressPct: 0, lines: [], pricing: [],
    steps, activity: [],
  };
}
const AS_OF = "2026-07-01T00:00:00.000Z";
const handlers = { onTrackIn: () => {}, onTrackOut: () => {} };

describe("TrackingBoard", () => {
  it("places a card in its active step's area column", () => {
    const o = order("wo-a", [
      ostep({ n: 1, op: "Wash & rack", track: "track_in_out", state: "done", areaId: "rack" }),
      ostep({ n: 2, op: "Carburize", track: "track_in_out", state: "in_process", areaId: "in_process" }),
    ]);
    render(<TrackingBoard orders={[o]} customers={[cust]} asOf={AS_OF} busy={false} {...handlers} />);
    const col = screen.getByTestId("area-col-in_process");
    expect(within(col).getByTestId("board-card-WO-A")).toBeInTheDocument();
  });

  it("flags a late, unshipped order", () => {
    const o = order("wo-late", [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process", areaId: "in_process" })], "in_process", "2026-06-01T00:00:00.000Z");
    render(<TrackingBoard orders={[o]} customers={[cust]} asOf={AS_OF} busy={false} {...handlers} />);
    expect(within(screen.getByTestId("board-card-WO-LATE")).getByText(/late/i)).toBeInTheDocument();
  });

  it("fires onTrackOut from the card quick action", async () => {
    const onTrackOut = vi.fn();
    const o = order("wo-b", [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process", areaId: "in_process" })]);
    render(<TrackingBoard orders={[o]} customers={[cust]} asOf={AS_OF} busy={false} onTrackIn={() => {}} onTrackOut={onTrackOut} />);
    const card = screen.getByTestId("board-card-WO-B");
    await userEvent.click(within(card).getByRole("button", { name: "Track Out" }));
    expect(onTrackOut).toHaveBeenCalledWith(o, 1, undefined);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run components/tracking/tracking-board.test.tsx`
Expected: FAIL — cannot find module `./tracking-board`.

- [ ] **Step 3: Implement** — create `components/tracking/tracking-board.tsx`:

```tsx
import { MonoId, StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { AREAS, areaMeta, orderStatusMeta } from "@/lib/domain/enums";
import { boardAreaForOrder, activeStep, stepActions } from "@/lib/logic/tracking";
import { isLate } from "@/lib/logic/dashboard";
import type { WorkOrder, Customer, AreaId } from "@/lib/domain";

export function TrackingBoard({ orders, customers, asOf, busy, onTrackIn, onTrackOut }: {
  orders: WorkOrder[]; customers: Customer[]; asOf: string; busy: boolean;
  onTrackIn: (order: WorkOrder, stepN: number) => void;
  onTrackOut: (order: WorkOrder, stepN: number, inspectResult?: "pass" | "fail") => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const byArea = new Map<AreaId, WorkOrder[]>(AREAS.map((a) => [a, []]));
  for (const o of orders) byArea.get(boardAreaForOrder(o))!.push(o);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {AREAS.map((area) => {
        const col = byArea.get(area)!;
        return (
          <div key={area} data-testid={`area-col-${area}`} className="w-64 shrink-0 rounded-card border border-border bg-canvas-alt p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-faint">{areaMeta[area].label}</span>
              <span className="font-mono text-xs text-text-muted">{col.length}</span>
            </div>
            <div className="space-y-2">
              {col.map((o) => {
                const active = activeStep(o.steps);
                const late = isLate(o, asOf);
                const sm = orderStatusMeta[o.status];
                return (
                  <div key={o.id} data-testid={`board-card-WO-${o.number.replace(/^WO-/, "")}`} className="rounded-card border border-border bg-surface p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <MonoId>{o.number}</MonoId>
                      {late && <StatusPill tone="danger">LATE</StatusPill>}
                    </div>
                    <div className="text-[13px] font-medium">{custById.get(o.customerId)?.name ?? "—"}</div>
                    <div className="text-xs text-text-muted">{o.processSummary}</div>
                    <div className="mt-1 flex items-center justify-between">
                      <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
                      <span className="text-xs text-text-muted">{active ? active.op : "—"}</span>
                    </div>
                    {active && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {stepActions(active).map((a) => (
                          <Button key={a.label} size="sm" variant="outline" disabled={busy}
                            onClick={() => (a.action === "in" ? onTrackIn(o, active.n) : onTrackOut(o, active.n, a.inspectResult))}>
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

> The board card's `data-testid` uses `WO-${number-without-prefix}` so a number like `WO-48211` yields `board-card-WO-48211` (matches the test's `WO-A`/`WO-LATE`/`WO-B` for the synthetic ids too, since those `number`s are already `WO-A` etc. → `.replace(/^WO-/, "")` gives `A`, prefixed back to `WO-A`).

Replace `app/(app)/tracking/page.tsx` with:

```tsx
"use client";
import { useAuth } from "@/lib/auth/provider";
import { useWorkOrders, useCustomers, useTrackInStep, useTrackOutStep, useCertifications } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { TrackingBoard } from "@/components/tracking/tracking-board";
import { openOrders } from "@/lib/logic/dashboard";

export default function TrackingPage() {
  const { operator } = useAuth();
  const orders = useWorkOrders();
  const customers = useCustomers();
  const certs = useCertifications();
  const trackIn = useTrackInStep();
  const trackOut = useTrackOutStep();

  if (orders.isLoading || customers.isLoading || !operator) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;

  const open = openOrders(orders.data ?? []);
  const busy = trackIn.isPending || trackOut.isPending;
  const now = new Date().toISOString();

  return (
    <div>
      <PageHeader title="Tracking" subtitle="Live shop-floor status by area — scan orders through their traveler." />
      {open.length === 0 ? (
        <EmptyState title="No open orders" />
      ) : (
        <TrackingBoard
          orders={open} customers={customers.data ?? []} asOf={now} busy={busy}
          onTrackIn={(o, stepN) => trackIn.mutate({ order: o, stepN, operator })}
          onTrackOut={(o, stepN, inspectResult) => {
            const cert = (certs.data ?? []).find((c) => c.workOrderId === o.id) ?? null;
            trackOut.mutate({ order: o, stepN, operator, cert, inspectResult });
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes + full gate**

Run: `npx vitest run components/tracking/tracking-board.test.tsx && npx tsc --noEmit && npx eslint . --max-warnings 0 && npm run build`
Expected: PASS. (Confirm the `PageHeader` prop names by checking `components/patterns/page-header.tsx`; it exposes `title` + `subtitle`.)

- [ ] **Step 5: Commit**

```bash
git add components/tracking "app/(app)/tracking/page.tsx"
git commit -m "feat(tracking): scan-driven Tracking kanban board + route"
```

---

### Task 10: E2E — traveler-driven ship + tracking board

**Files:**
- Modify: `tests/e2e/quote-to-invoice.spec.ts`
- Create: `tests/e2e/tracking.spec.ts`

**Interfaces:**
- Consumes: the running app (Order Detail traveler + Tracking board from Tasks 8-9). The E2E store resets on full page reload, so navigate **in-app only**.

- [ ] **Step 1: Update the Q→O→I happy path** — replace lines 48-71 of `tests/e2e/quote-to-invoice.spec.ts` (the block from the `// Navigate to Orders...` comment through the ship assertion) with the traveler-driven sequence. The new order `WO-48212` carries PM-CARB-58's 6 steps (both parts share pm-carb58, deduped):

```ts
  // Navigate to Orders via sidebar link, then open the new order WO-48212
  await page.getByRole("link", { name: "Orders" }).click();
  await page.getByText("WO-48212").click();

  // Drive the traveler. Only the active step exposes its buttons; complete each in order.
  // 1 Receive & verify (track_in) — single Track In completes it
  await page.getByTestId("traveler-step-1").getByRole("button", { name: "Track In" }).click();
  await expect(page.getByTestId("traveler-step-1")).toContainText("Done");
  // 2 Wash & rack (track_in_out)
  await page.getByTestId("traveler-step-2").getByRole("button", { name: "Track In" }).click();
  await expect(page.getByTestId("traveler-step-2")).toContainText("In process");
  await page.getByTestId("traveler-step-2").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-2")).toContainText("Done");
  // 3 Carburize (track_in_out)
  await page.getByTestId("traveler-step-3").getByRole("button", { name: "Track In" }).click();
  await page.getByTestId("traveler-step-3").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-3")).toContainText("Done");
  // 4 Temper (track_in_out)
  await page.getByTestId("traveler-step-4").getByRole("button", { name: "Track In" }).click();
  await page.getByTestId("traveler-step-4").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-4")).toContainText("Done");
  // 5 Final inspect (inspect) — Pass auto-releases the cert
  await page.getByTestId("traveler-step-5").getByRole("button", { name: "Pass" }).click();
  await expect(page.getByTestId("traveler-step-5")).toContainText("Done");
  await expect(page.getByText("Released")).toBeVisible();
  // 6 Certify & ship (track_out) — completes → Ready to ship
  await page.getByTestId("traveler-step-6").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-6")).toContainText("Done");

  // Now Ready to ship, cert Released, Apex is active → Ship is enabled
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeEnabled();
  await page.getByRole("button", { name: /^Ship$/ }).click();
  await expect(page.getByText("Shipped", { exact: true }).first()).toBeVisible();
```

(Leave the quote-building, send, won, and the Invoicing/A-R tail — lines 1-47 and 72-85 — unchanged.)

- [ ] **Step 2: Create the tracking board E2E** — create `tests/e2e/tracking.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("a card advances across Tracking board columns via a quick track-out", async ({ page }) => {
  await page.goto("/tracking");

  // Seed: WO-48211 (Apex) has step 1 done, step 2 (Wash & rack) in_process → sits in the Rack column.
  const rackCol = page.getByTestId("area-col-rack");
  const card = rackCol.getByTestId("board-card-WO-48211");
  await expect(card).toBeVisible();

  // Track out the active step (Wash & rack) → its next step (Carburize) is in the In Process area.
  await card.getByRole("button", { name: "Track Out" }).click();

  // The card leaves Rack and appears in the In Process column.
  await expect(page.getByTestId("area-col-in_process").getByTestId("board-card-WO-48211")).toBeVisible();
  await expect(rackCol.getByTestId("board-card-WO-48211")).toHaveCount(0);
});
```

- [ ] **Step 3: Run the E2E suite**

Run: `npm run test:e2e`
Expected: PASS — both `quote-to-invoice.spec.ts` and `tracking.spec.ts` green (plus the existing `smoke.spec.ts`).

> If a track action races (button momentarily detached between refetches), add `await expect(page.getByTestId("traveler-step-N")).toContainText("In process")` before the paired Track Out, as already done for step 2. The default 250 ms mock latency means Playwright's auto-wait handles most timing.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/quote-to-invoice.spec.ts tests/e2e/tracking.spec.ts
git commit -m "test(e2e): traveler-driven ship path + tracking board card advance"
```

---

### Task 11: Full-gate verification

**Files:** none (verification only).

- [ ] **Step 1: Run the complete gate**

Run:
```bash
npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0 && npm run build && npm run test:e2e
```
Expected: ALL PASS — unit/component tests, types, lint (zero warnings), production build, and both E2E specs.

- [ ] **Step 2: Confirm no stray `any` or eslint-disable was added**

Run: `git diff main --stat && grep -rn "eslint-disable\|: any\| any>" lib components app --include=*.ts --include=*.tsx | grep -v "mock/repositories.ts"`
Expected: the only `any`/eslint-disable hits are the two pre-approved lines in `lib/data/mock/repositories.ts`.

- [ ] **Step 3: Commit any final fixes (if the gate surfaced anything)**

```bash
git add -A
git commit -m "chore(tracking): final gate fixes"
```

---

## Self-Review

**1. Spec coverage:**
- OrderStep embedded on WorkOrder + area config → Tasks 1-2. ✓
- Step state machine (trackIn/out, single-scan, inspect) → Task 3. ✓
- Status rollup + progress (trackable-only) → Task 4. ✓
- Credit-hold ship gate + win block → Tasks 5, 7. ✓
- Inspect pass→cert release / fail→hold → Task 7. ✓
- Seed live steps + hold demo order → Task 6. ✓
- Order Detail live traveler, manual forward buttons removed, hold/resume kept → Task 8. ✓
- Tracking kanban board + route → Task 9. ✓
- E2E updated + new tracking spec → Task 10. ✓
- Full gate green → Task 11. ✓
- Deferred (Shop Floor, Schedule, partials, Equipment/ScheduleBlock/typed TrackingEvent, backend atomicity, superseded QuoteStatus) → intentionally untouched. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**3. Type consistency:** `OrderStep` (Task 2) reused everywhere; `trackInStep`/`trackOutStep`/`stepActions`/`activeStep` signatures (Task 3) match hook + component usage (Tasks 7-9); `canShipOrder(order, cert, customer?)` (Task 5) matches the 3-arg calls in `useShipOrder` and `OrderDetail`; `rollUpOrderStatus(steps, current)` matches the resume glue; board `data-testid` scheme is consistent between component and both tests. ✓

**Refinement noted vs spec:** the spec §5.1 mentioned `ProcessStep` gaining `areaId`; the plan keeps `ProcessStep` unchanged and puts `areaId` on `OrderStep` only, deriving it via `areaForOp` (less churn, `ProcessMaster`/process-master screens untouched). `rollUpOrderStatus`/`orderProgressPct` live in `lib/logic/tracking.ts` (cohesive with the other tracking pure fns) rather than `order.ts`. Behavior is identical to the spec.

# Shop Floor (Equipment Monitor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/shop-floor` placeholder with a live equipment tile grid whose furnace/oven status is derived purely from current `in_process` OrderStep loads over WorkOrders.

**Architecture:** Equipment is a **static config roster** in `lib/domain/enums.ts` (no repo, like `AREAS`). A pure module `lib/logic/shop-floor.ts` maps each step's free-text `equip` string to a roster id (`equipmentForStep`) and projects `WorkOrder[]` into per-equipment live state (`equipmentLoads`) plus a summary. The screen (`components/shop-floor/*`) is presentational; the page composes existing `useWorkOrders()` + `useCustomers()` queries and wires drill-in via `router.push('/orders/{id}')` — the exact pattern `app/(app)/orders/page.tsx` already uses. No new repository, mutation, or persisted entity.

**Tech Stack:** Next.js 16 (App Router) + React 19 + TypeScript; Tailwind v4 + shadcn/ui; TanStack Query v5; Zod 4; Vitest + React Testing Library; Playwright.

## Global Constraints

Every task's requirements implicitly include this section.

- **Read `node_modules/next/dist/docs/` before writing any Next-specific code** (`AGENTS.md`: this is a breaking-changes Next; APIs may differ from training data).
- UI depends only on async repository interfaces via Query hooks. This plan adds **no repo, no mutation, no persisted entity** — Shop Floor is a pure read projection.
- Money = integer cents; dates = ISO. Clock times shown on tiles are formatted **UTC-deterministically** (no `Date.now()` inside `lib/logic/*`; `asOf` is always passed in).
- IBM Plex Mono for ids/numbers/pills (`MonoId`, `StatusPill`); exact design tokens only (`rounded-card`, `border-border`, `bg-surface`, `bg-canvas-alt`, `bg-primary`, `text-text-muted`, `text-status-*`, `bg-status-*-tint`).
- **No new `any` and no new `eslint-disable`.** The only approved `any` spots are the two mock-plumbing signatures in `lib/data/mock/repositories.ts`.
- Presentational components are pure (props in, no data fetching); `page.tsx` is thin glue; permissions via authenticated `operator.role`/`useCan` (not needed here — Shop Floor is unrestricted read).
- **Gate must stay green after every task:** `npx vitest run` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `npm run build` · `npm run test:e2e`.
- **Every commit message ends with the trailer** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (shown via a second `-m` in each commit step).
- Work on branch `heatsynq-shop-floor-equipment` (already created; the design spec is committed there as `b64facc`).

---

### Task 1: Equipment roster config (domain)

**Files:**
- Modify: `lib/domain/enums.ts` (append at end; `lib/domain/index.ts` already re-exports `./enums`, so new symbols are reachable from `@/lib/domain`)
- Test: `lib/domain/equipment.test.ts`

**Interfaces:**
- Consumes: `StatusTone` (already exported from `lib/domain/enums.ts`).
- Produces:
  - `EQUIPMENT_KINDS`, `EquipmentKind`, `equipmentKindMeta: Record<EquipmentKind, { label: string }>`
  - `EQUIPMENT` (readonly roster), `EquipmentDef = (typeof EQUIPMENT)[number]`, `EquipmentId = EquipmentDef["id"]`
  - `EQUIPMENT_STATES`, `EquipmentState`, `equipmentStateMeta: Record<EquipmentState, { label: string; tone: StatusTone }>`

- [ ] **Step 1: Write the failing test**

Create `lib/domain/equipment.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  EQUIPMENT, EQUIPMENT_KINDS, EQUIPMENT_STATES,
  equipmentKindMeta, equipmentStateMeta,
} from "@/lib/domain/enums";

describe("equipment config", () => {
  it("has a non-empty roster with unique ids and names", () => {
    expect(EQUIPMENT.length).toBeGreaterThan(0);
    const ids = EQUIPMENT.map((e) => e.id);
    const names = EQUIPMENT.map((e) => e.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every roster kind has kind metadata", () => {
    for (const e of EQUIPMENT) {
      expect(EQUIPMENT_KINDS).toContain(e.kind);
      expect(equipmentKindMeta[e.kind].label.length).toBeGreaterThan(0);
    }
  });

  it("every state has state metadata with a tone", () => {
    for (const s of EQUIPMENT_STATES) {
      expect(equipmentStateMeta[s].label.length).toBeGreaterThan(0);
      expect(equipmentStateMeta[s].tone).toBeTruthy();
    }
  });

  it("includes the furnace kinds the shop runs", () => {
    const kinds = new Set(EQUIPMENT.map((e) => e.kind));
    expect(kinds.has("batch_iq")).toBe(true);
    expect(kinds.has("temper")).toBe(true);
    expect(kinds.has("wash")).toBe(true);
    expect(kinds.has("inspect")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/equipment.test.ts`
Expected: FAIL — `EQUIPMENT`/`EQUIPMENT_KINDS`/etc. are not exported.

- [ ] **Step 3: Append the config to `lib/domain/enums.ts`**

Append at the end of `lib/domain/enums.ts`:

```ts
export const EQUIPMENT_KINDS = ["batch_iq","temper","vacuum","pit","continuous","wash","inspect"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export const equipmentKindMeta: Record<EquipmentKind, { label: string }> = {
  batch_iq:   { label: "Batch IQ furnace" },
  temper:     { label: "Temper oven" },
  vacuum:     { label: "Vacuum furnace" },
  pit:        { label: "Pit furnace" },
  continuous: { label: "Continuous belt" },
  wash:       { label: "Wash station" },
  inspect:    { label: "Inspection / Lab" },
};

export const EQUIPMENT = [
  { id: "eq-iq-1",      name: "Batch IQ #1",        kind: "batch_iq" },
  { id: "eq-iq-2",      name: "Batch IQ #2",        kind: "batch_iq" },
  { id: "eq-iq-3",      name: "Batch IQ #3",        kind: "batch_iq" },
  { id: "eq-temper-1",  name: "Temper Oven #1",     kind: "temper" },
  { id: "eq-temper-2",  name: "Temper Oven #2",     kind: "temper" },
  { id: "eq-vac-1",     name: "Vacuum Furnace #1",  kind: "vacuum" },
  { id: "eq-pit-1",     name: "Pit Furnace #1",     kind: "pit" },
  { id: "eq-belt-1",    name: "Continuous Belt #1", kind: "continuous" },
  { id: "eq-wash-1",    name: "Wash Station",       kind: "wash" },
  { id: "eq-inspect-1", name: "Inspection",         kind: "inspect" },
] as const satisfies readonly { id: string; name: string; kind: EquipmentKind }[];
export type EquipmentDef = (typeof EQUIPMENT)[number];
export type EquipmentId = EquipmentDef["id"];

export const EQUIPMENT_STATES = ["running","idle","on_hold"] as const;
export type EquipmentState = (typeof EQUIPMENT_STATES)[number];
export const equipmentStateMeta: Record<EquipmentState, { label: string; tone: StatusTone }> = {
  running: { label: "Running", tone: "success" },
  idle:    { label: "Idle",    tone: "neutral" },
  on_hold: { label: "On hold", tone: "warn" },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/domain/equipment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (the `as const satisfies` gives a literal-id union for `EquipmentId`).

- [ ] **Step 6: Commit**

```bash
git add lib/domain/enums.ts lib/domain/equipment.test.ts
git commit -m "feat(shop-floor): add Equipment roster + kind/state config" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Setpoint & duration parsers (pure logic)

**Files:**
- Create: `lib/logic/shop-floor.ts`
- Test: `lib/logic/shop-floor.test.ts`

**Interfaces:**
- Produces:
  - `parseSetpoint(params: string[]): string | null` — first temperature-looking param (e.g. `"1700°F"`), whitespace-stripped; else `null`.
  - `parseDurationMinutes(params: string[]): number | null` — first duration param (`hr`/`h`/`min`/`m`) as minutes; else `null`.

- [ ] **Step 1: Write the failing test**

Create `lib/logic/shop-floor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSetpoint, parseDurationMinutes } from "./shop-floor";

describe("parseSetpoint", () => {
  it("returns the first Fahrenheit setpoint", () => {
    expect(parseSetpoint(["1700°F", "8.0 hr", "0.90% C", "Oil quench"])).toBe("1700°F");
    expect(parseSetpoint(["350°F", "2.0 hr"])).toBe("350°F");
  });
  it("returns null when no temperature is present", () => {
    expect(parseSetpoint([])).toBeNull();
    expect(parseSetpoint(["Oil quench", "Furnace cool"])).toBeNull();
  });
});

describe("parseDurationMinutes", () => {
  it("parses hours to minutes", () => {
    expect(parseDurationMinutes(["1700°F", "8.0 hr"])).toBe(480);
    expect(parseDurationMinutes(["400°F", "2.0 hr"])).toBe(120);
  });
  it("parses minutes", () => {
    expect(parseDurationMinutes(["90 min"])).toBe(90);
  });
  it("returns null when no duration is present", () => {
    expect(parseDurationMinutes(["975°F", "Gas quench"])).toBeNull();
    expect(parseDurationMinutes([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/logic/shop-floor.test.ts`
Expected: FAIL — module `./shop-floor` does not exist.

- [ ] **Step 3: Create `lib/logic/shop-floor.ts` with the parsers**

```ts
/** Parse the first Fahrenheit setpoint from step params (e.g. "1700°F"). Whitespace-stripped. */
export function parseSetpoint(params: string[]): string | null {
  for (const p of params) {
    const m = p.match(/\d+(?:\.\d+)?\s*°?\s*F\b/i);
    if (m) return m[0].replace(/\s+/g, "");
  }
  return null;
}

/** Parse the first duration param (hr/h/min/m) to whole minutes; null when none. */
export function parseDurationMinutes(params: string[]): number | null {
  for (const p of params) {
    const m = p.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|mins|min|m)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const isHour = unit === "h" || unit.startsWith("hr") || unit.startsWith("hour");
      return Math.round(isHour ? n * 60 : n);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/shop-floor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/shop-floor.ts lib/logic/shop-floor.test.ts
git commit -m "feat(shop-floor): add setpoint + duration param parsers" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `equipmentForStep` mapper (pure logic)

**Files:**
- Modify: `lib/logic/shop-floor.ts`
- Test: `lib/logic/shop-floor.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `EQUIPMENT`, `EquipmentId` from `@/lib/domain/enums`.
- Produces: `equipmentForStep(step: { equip: string; op: string }): EquipmentId` — exact name match → that unit; else keyword heuristic → the kind's default unit; else `"eq-iq-1"`.

- [ ] **Step 1: Write the failing test**

Append to `lib/logic/shop-floor.test.ts`:

```ts
import { equipmentForStep } from "./shop-floor";

describe("equipmentForStep", () => {
  it("matches an exact roster name (case-insensitive)", () => {
    expect(equipmentForStep({ equip: "Batch IQ #3", op: "Carburize" })).toBe("eq-iq-3");
    expect(equipmentForStep({ equip: "Pit Furnace #1", op: "Nitride" })).toBe("eq-pit-1");
    expect(equipmentForStep({ equip: "wash station", op: "Wash & rack" })).toBe("eq-wash-1");
    expect(equipmentForStep({ equip: "Inspection", op: "Final inspect" })).toBe("eq-inspect-1");
  });

  it("falls back to a kind default via keyword when the name is not in the roster", () => {
    expect(equipmentForStep({ equip: "Temper Oven #4", op: "Temper" })).toBe("eq-temper-1");
    expect(equipmentForStep({ equip: "Vacuum #1", op: "Vacuum harden" })).toBe("eq-vac-1");
    expect(equipmentForStep({ equip: "Continuous Belt #2", op: "Carbonitride" })).toBe("eq-belt-1");
  });

  it("falls back to eq-iq-1 for unmapped stations", () => {
    expect(equipmentForStep({ equip: "Receiving", op: "Receive & verify" })).toBe("eq-iq-1");
    expect(equipmentForStep({ equip: "Shipping", op: "Certify & ship" })).toBe("eq-iq-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/logic/shop-floor.test.ts`
Expected: FAIL — `equipmentForStep` is not exported.

- [ ] **Step 3: Add `equipmentForStep` to `lib/logic/shop-floor.ts`**

Add the import at the top of the file and the function below the parsers:

```ts
import { EQUIPMENT, type EquipmentId } from "@/lib/domain/enums";

/** Resolve a step's free-text equip label to a roster equipment id. */
export function equipmentForStep(step: { equip: string; op: string }): EquipmentId {
  const raw = step.equip.trim().toLowerCase();
  const exact = EQUIPMENT.find((e) => e.name.toLowerCase() === raw);
  if (exact) return exact.id;
  const s = `${step.equip} ${step.op}`.toLowerCase();
  if (/vacuum/.test(s)) return "eq-vac-1";
  if (/\bpit\b|nitrid/.test(s)) return "eq-pit-1";
  if (/belt|continuous|carbonitr/.test(s)) return "eq-belt-1";
  if (/wash/.test(s)) return "eq-wash-1";
  if (/inspect|lab/.test(s)) return "eq-inspect-1";
  if (/temper/.test(s)) return "eq-temper-1";
  if (/iq|batch|carbur|harden|anneal/.test(s)) return "eq-iq-1";
  return "eq-iq-1";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/shop-floor.test.ts`
Expected: PASS (all `describe` blocks).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/shop-floor.ts lib/logic/shop-floor.test.ts
git commit -m "feat(shop-floor): map free-text equip strings to roster ids" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `equipmentLoads` projection + `shopFloorSummary` (pure logic)

**Files:**
- Modify: `lib/logic/shop-floor.ts`
- Test: `lib/logic/shop-floor.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `isLate` from `@/lib/logic/dashboard`; `WorkOrder`, `OrderStep` from `@/lib/domain`; `EQUIPMENT`, `EquipmentId`, `EquipmentState` from `@/lib/domain/enums`; `parseSetpoint`, `parseDurationMinutes`, `equipmentForStep` (this module).
- Produces:
  - `type EquipmentLoad` (see code below).
  - `equipmentLoads(orders: WorkOrder[], asOf: string): EquipmentLoad[]` — one entry per roster unit, **in roster order**.
  - `shopFloorSummary(loads: EquipmentLoad[]): { running: number; idle: number; onHold: number; late: number }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/logic/shop-floor.test.ts`:

```ts
import { equipmentLoads, shopFloorSummary } from "./shop-floor";
import type { WorkOrder, OrderStep } from "@/lib/domain";

const AS_OF = "2026-07-01T00:00:00.000Z";

function step(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "equip" | "state">): OrderStep {
  return {
    track: "track_in_out", areaId: "in_process", instr: "", params: [],
    operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p,
  };
}
function wo(p: Partial<WorkOrder> & Pick<WorkOrder, "id" | "number" | "status" | "steps">): WorkOrder {
  return {
    createdAt: "", updatedAt: "", version: 1, customerId: "c1", customerPO: "", quoteId: null,
    processSummary: "", processMasterId: null, orderedDate: "2026-06-01T00:00:00.000Z",
    due: "2026-08-01T00:00:00.000Z", certifyRequired: false, certSpecId: null, orderValueCents: 0,
    progressPct: 50, lines: [], pricing: [], activity: [], ...p,
  };
}
function find(loads: ReturnType<typeof equipmentLoads>, id: string) {
  return loads.find((l) => l.equipmentId === id)!;
}

describe("equipmentLoads", () => {
  it("returns one entry per roster unit, all idle when no in_process steps", () => {
    const loads = equipmentLoads([], AS_OF);
    expect(loads).toHaveLength(10);
    expect(loads.every((l) => l.state === "idle" && l.load === null)).toBe(true);
  });

  it("marks a unit running with its in_process load, setpoint and est finish", () => {
    const o = wo({
      id: "wo-1", number: "WO-1", status: "in_process", progressPct: 40,
      steps: [step({
        n: 3, op: "Carburize", equip: "Batch IQ #3", state: "in_process",
        params: ["1700°F", "8.0 hr", "Oil quench"], operatorInitials: "DM",
        trackedInAt: "2026-07-01T06:00:00.000Z",
      })],
    });
    const iq3 = find(equipmentLoads([o], AS_OF), "eq-iq-3");
    expect(iq3.state).toBe("running");
    expect(iq3.load?.workOrderNumber).toBe("WO-1");
    expect(iq3.load?.op).toBe("Carburize");
    expect(iq3.load?.progressPct).toBe(40);
    expect(iq3.load?.operatorInitials).toBe("DM");
    expect(iq3.load?.setpoint).toBe("1700°F");
    expect(iq3.load?.estFinishIso).toBe("2026-07-01T14:00:00.000Z"); // +8h
    expect(iq3.load?.late).toBe(false);
  });

  it("marks a unit on_hold when the holding order is on_hold", () => {
    const o = wo({
      id: "wo-h", number: "WO-H", status: "on_hold",
      steps: [step({ n: 2, op: "Neutral harden", equip: "Batch IQ #3", state: "in_process" })],
    });
    expect(find(equipmentLoads([o], AS_OF), "eq-iq-3").state).toBe("on_hold");
  });

  it("flags a late running load", () => {
    const o = wo({
      id: "wo-late", number: "WO-LATE", status: "in_process", due: "2026-06-20T00:00:00.000Z",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process" })],
    });
    expect(find(equipmentLoads([o], AS_OF), "eq-pit-1").load?.late).toBe(true);
  });

  it("on contention keeps the earliest trackedInAt as the current load and counts the rest queued", () => {
    const older = wo({
      id: "wo-old", number: "WO-OLD", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T01:00:00.000Z" })],
    });
    const newer = wo({
      id: "wo-new", number: "WO-NEW", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T05:00:00.000Z" })],
    });
    const pit = find(equipmentLoads([newer, older], AS_OF), "eq-pit-1");
    expect(pit.load?.workOrderNumber).toBe("WO-OLD");
    expect(pit.queued).toBe(1);
  });

  it("ignores steps that are not in_process", () => {
    const o = wo({
      id: "wo-p", number: "WO-P", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "pending" })],
    });
    expect(find(equipmentLoads([o], AS_OF), "eq-pit-1").state).toBe("idle");
  });
});

describe("shopFloorSummary", () => {
  it("counts running / idle / on_hold / late", () => {
    const running = wo({ id: "r", number: "R", status: "in_process",
      steps: [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process", trackedInAt: "2026-07-01T01:00:00.000Z" })] });
    const held = wo({ id: "h", number: "H", status: "on_hold",
      steps: [step({ n: 2, op: "Neutral harden", equip: "Batch IQ #3", state: "in_process" })] });
    const s = shopFloorSummary(equipmentLoads([running, held], AS_OF));
    expect(s.running).toBe(1);
    expect(s.onHold).toBe(1);
    expect(s.idle).toBe(8);
    expect(s.late).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/logic/shop-floor.test.ts`
Expected: FAIL — `equipmentLoads`/`shopFloorSummary` not exported.

- [ ] **Step 3: Add the projection to `lib/logic/shop-floor.ts`**

Extend the imports and append the type + functions:

```ts
import { EQUIPMENT, type EquipmentId, type EquipmentState } from "@/lib/domain/enums";
import { isLate } from "@/lib/logic/dashboard";
import type { WorkOrder, OrderStep } from "@/lib/domain";

export type EquipmentLoad = {
  equipmentId: EquipmentId;
  state: EquipmentState;
  load: {
    workOrderId: string;
    workOrderNumber: string;
    customerId: string;
    op: string;
    progressPct: number;
    operatorInitials: string | null;
    setpoint: string | null;
    estFinishIso: string | null;
    late: boolean;
    trackedInAt: string | null;
  } | null;
  queued: number;
};

type Candidate = { order: WorkOrder; step: OrderStep };

function byTrackedInThenNumber(a: Candidate, b: Candidate): number {
  const ta = a.step.trackedInAt, tb = b.step.trackedInAt;
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return a.order.number < b.order.number ? -1 : a.order.number > b.order.number ? 1 : 0;
}

/** Project open work orders onto the equipment roster. One entry per unit, in roster order. */
export function equipmentLoads(orders: WorkOrder[], asOf: string): EquipmentLoad[] {
  const byEquip = new Map<EquipmentId, Candidate[]>(EQUIPMENT.map((e) => [e.id, []]));
  for (const order of orders) {
    for (const s of order.steps) {
      if (s.state !== "in_process") continue;
      byEquip.get(equipmentForStep(s))!.push({ order, step: s });
    }
  }
  return EQUIPMENT.map((e): EquipmentLoad => {
    const cands = byEquip.get(e.id)!;
    if (cands.length === 0) return { equipmentId: e.id, state: "idle", load: null, queued: 0 };
    const cur = [...cands].sort(byTrackedInThenNumber)[0];
    const state: EquipmentState = cur.order.status === "on_hold" ? "on_hold" : "running";
    const mins = parseDurationMinutes(cur.step.params);
    const estFinishIso = cur.step.trackedInAt && mins != null
      ? new Date(new Date(cur.step.trackedInAt).getTime() + mins * 60_000).toISOString()
      : null;
    return {
      equipmentId: e.id, state, queued: cands.length - 1,
      load: {
        workOrderId: cur.order.id, workOrderNumber: cur.order.number, customerId: cur.order.customerId,
        op: cur.step.op, progressPct: cur.order.progressPct, operatorInitials: cur.step.operatorInitials,
        setpoint: parseSetpoint(cur.step.params), estFinishIso,
        late: isLate(cur.order, asOf), trackedInAt: cur.step.trackedInAt,
      },
    };
  });
}

export function shopFloorSummary(loads: EquipmentLoad[]): { running: number; idle: number; onHold: number; late: number } {
  return {
    running: loads.filter((l) => l.state === "running").length,
    idle: loads.filter((l) => l.state === "idle").length,
    onHold: loads.filter((l) => l.state === "on_hold").length,
    late: loads.filter((l) => l.load?.late).length,
  };
}
```

> Note: the two `import` lines above for `EQUIPMENT`/`EquipmentId` extend the import added in Task 3 — merge them into a single `import { EQUIPMENT, type EquipmentId, type EquipmentState } from "@/lib/domain/enums";` rather than duplicating.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/shop-floor.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Typecheck + full unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; whole suite green (no existing test touched).

- [ ] **Step 6: Commit**

```bash
git add lib/logic/shop-floor.ts lib/logic/shop-floor.test.ts
git commit -m "feat(shop-floor): project work orders into per-equipment live loads + summary" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `EquipmentTile` component

**Files:**
- Create: `components/shop-floor/equipment-tile.tsx`
- Test: `components/shop-floor/equipment-tile.test.tsx`

**Interfaces:**
- Consumes: `EquipmentLoad` from `@/lib/logic/shop-floor`; `EquipmentDef`, `equipmentStateMeta`, `equipmentKindMeta` from `@/lib/domain/enums`; `StatusPill`, `MonoId` from `@/components/patterns`.
- Produces: `EquipmentTile({ equipment, entry, customerName, onSelect })`. Loaded tile is a `<button>` calling `onSelect(workOrderId)`; idle tile is a non-interactive `<div>`. Both carry `data-testid={`equipment-tile-${equipment.id}`}`.

- [ ] **Step 1: Write the failing test**

Create `components/shop-floor/equipment-tile.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EquipmentTile } from "./equipment-tile";
import { EQUIPMENT, type EquipmentDef } from "@/lib/domain/enums";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

const iq3 = EQUIPMENT.find((e) => e.id === "eq-iq-3")! as EquipmentDef;

function loaded(over: Partial<NonNullable<EquipmentLoad["load"]>> = {}): EquipmentLoad {
  return {
    equipmentId: "eq-iq-3", state: "running", queued: 0,
    load: {
      workOrderId: "wo-1", workOrderNumber: "WO-1", customerId: "c1", op: "Carburize",
      progressPct: 40, operatorInitials: "DM", setpoint: "1700°F",
      estFinishIso: "2026-07-01T14:00:00.000Z", late: false, trackedInAt: "2026-07-01T06:00:00.000Z", ...over,
    },
  };
}

describe("EquipmentTile", () => {
  it("shows the load and drills in on click", async () => {
    const onSelect = vi.fn();
    render(<EquipmentTile equipment={iq3} entry={loaded()} customerName="Apex Aerospace" onSelect={onSelect} />);
    expect(screen.getByText("WO-1")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("Carburize")).toBeInTheDocument();
    expect(screen.getByText(/Setpoint 1700°F/)).toBeInTheDocument();
    expect(screen.getByText(/Est\. finish/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("equipment-tile-eq-iq-3"));
    expect(onSelect).toHaveBeenCalledWith("wo-1");
  });

  it("shows a LATE pill and queued count", () => {
    render(<EquipmentTile equipment={iq3} entry={{ ...loaded({ late: true }), queued: 2 }} customerName="Apex Aerospace" onSelect={() => {}} />);
    expect(screen.getByText(/late/i)).toBeInTheDocument();
    expect(screen.getByText(/\+2 queued/)).toBeInTheDocument();
  });

  it("renders an idle tile that is not a button", () => {
    render(<EquipmentTile equipment={iq3} entry={{ equipmentId: "eq-iq-3", state: "idle", load: null, queued: 0 }} customerName={null} onSelect={() => {}} />);
    expect(screen.getByText(/no load · available/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the on-hold state pill", () => {
    render(<EquipmentTile equipment={iq3} entry={{ ...loaded(), state: "on_hold" }} customerName="Apex Aerospace" onSelect={() => {}} />);
    expect(screen.getByText("On hold")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/shop-floor/equipment-tile.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create `components/shop-floor/equipment-tile.tsx`**

```tsx
import { StatusPill, MonoId } from "@/components/patterns";
import { equipmentStateMeta, equipmentKindMeta, type EquipmentDef } from "@/lib/domain/enums";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

/** Format an ISO instant as a UTC h:mm AM/PM clock (deterministic — no local timezone). */
function clockUtc(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours();
  const hh = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "AM" : "PM";
  return `${hh}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap}`;
}

export function EquipmentTile({ equipment, entry, customerName, onSelect }: {
  equipment: EquipmentDef;
  entry: EquipmentLoad;
  customerName: string | null;
  onSelect?: (workOrderId: string) => void;
}) {
  const sm = equipmentStateMeta[entry.state];
  const testId = `equipment-tile-${equipment.id}`;
  const header = (
    <div className="flex items-start justify-between">
      <div>
        <div className="text-[13px] font-medium">{equipment.name}</div>
        <div className="text-text-muted text-[11px]">{equipmentKindMeta[equipment.kind].label}</div>
      </div>
      <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
    </div>
  );

  if (!entry.load) {
    return (
      <div data-testid={testId} className="rounded-card border border-border bg-surface p-4 opacity-60">
        {header}
        <div className="text-text-muted mt-3 text-xs">No load · available</div>
      </div>
    );
  }

  const l = entry.load;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => onSelect?.(l.workOrderId)}
      className="w-full rounded-card border border-border bg-surface p-4 text-left"
    >
      {header}
      <div className="mt-3 flex items-center justify-between">
        <MonoId>{l.workOrderNumber}</MonoId>
        {l.late && <StatusPill tone="danger">LATE</StatusPill>}
      </div>
      <div className="text-[13px] font-medium">{customerName ?? "—"}</div>
      <div className="text-text-muted text-xs">{l.op}</div>
      <div className="mt-2 h-2 w-full rounded-full bg-canvas-alt">
        <div className="h-2 rounded-full bg-primary" style={{ width: `${l.progressPct}%` }} />
      </div>
      <div className="text-text-muted mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
        {l.operatorInitials && <span>{l.operatorInitials}</span>}
        {l.setpoint && <span>Setpoint {l.setpoint}</span>}
        {l.estFinishIso && <span>Est. finish {clockUtc(l.estFinishIso)}</span>}
        {entry.queued > 0 && <span>+{entry.queued} queued</span>}
      </div>
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/shop-floor/equipment-tile.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add components/shop-floor/equipment-tile.tsx components/shop-floor/equipment-tile.test.tsx
git commit -m "feat(shop-floor): add EquipmentTile (running/idle/on-hold, drill-in)" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `ShopFloorGrid` component (status strip + tile grid)

**Files:**
- Create: `components/shop-floor/shop-floor-grid.tsx`
- Test: `components/shop-floor/shop-floor-grid.test.tsx`

**Interfaces:**
- Consumes: `equipmentLoads`, `shopFloorSummary` from `@/lib/logic/shop-floor`; `EQUIPMENT` from `@/lib/domain/enums`; `KpiTile` from `@/components/patterns`; `EquipmentTile` (Task 5); `WorkOrder`, `Customer` from `@/lib/domain`.
- Produces: `ShopFloorGrid({ orders, customers, asOf, onSelect })` — a `data-testid="shopfloor-summary"` KPI strip (Running/Idle/On hold/Late) + a grid of one `EquipmentTile` per roster unit in roster order.

- [ ] **Step 1: Write the failing test**

Create `components/shop-floor/shop-floor-grid.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShopFloorGrid } from "./shop-floor-grid";
import { EQUIPMENT } from "@/lib/domain/enums";
import type { WorkOrder, OrderStep, Customer } from "@/lib/domain";

const AS_OF = "2026-07-01T00:00:00.000Z";
const cust: Customer = {
  id: "c1", createdAt: "", updatedAt: "", version: 1, customerNumber: "1", name: "Apex Aerospace",
  initials: "AA", city: "", billingAddress: "", phone: "", terms: "Net 30", status: "active",
  priceKeyId: null, taxExempt: false, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0,
};
function step(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "equip" | "state">): OrderStep {
  return { track: "track_in_out", areaId: "in_process", instr: "", params: [], operatorId: null,
    operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p };
}
function wo(id: string, steps: OrderStep[], status: WorkOrder["status"] = "in_process"): WorkOrder {
  return { id, number: id.toUpperCase(), createdAt: "", updatedAt: "", version: 1, customerId: "c1",
    customerPO: "", quoteId: null, processSummary: "", processMasterId: null, status,
    orderedDate: "2026-06-01T00:00:00.000Z", due: "2026-08-01T00:00:00.000Z", certifyRequired: false,
    certSpecId: null, orderValueCents: 0, progressPct: 50, lines: [], pricing: [], steps, activity: [] };
}

describe("ShopFloorGrid", () => {
  it("renders one tile per roster unit with a summary strip", () => {
    render(<ShopFloorGrid orders={[]} customers={[cust]} asOf={AS_OF} onSelect={() => {}} />);
    for (const e of EQUIPMENT) expect(screen.getByTestId(`equipment-tile-${e.id}`)).toBeInTheDocument();
    const summary = screen.getByTestId("shopfloor-summary");
    expect(within(summary).getByText("Idle").parentElement).toHaveTextContent("10");
  });

  it("shows a running load on the right unit and drills in", async () => {
    const onSelect = vi.fn();
    const o = wo("wo-1", [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process" })]);
    render(<ShopFloorGrid orders={[o]} customers={[cust]} asOf={AS_OF} onSelect={onSelect} />);
    const tile = screen.getByTestId("equipment-tile-eq-pit-1");
    expect(within(tile).getByText("WO-1")).toBeInTheDocument();
    expect(within(tile).getByText("Apex Aerospace")).toBeInTheDocument();
    await userEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith("wo-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/shop-floor/shop-floor-grid.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create `components/shop-floor/shop-floor-grid.tsx`**

```tsx
import { KpiTile } from "@/components/patterns";
import { EQUIPMENT } from "@/lib/domain/enums";
import { equipmentLoads, shopFloorSummary } from "@/lib/logic/shop-floor";
import { EquipmentTile } from "./equipment-tile";
import type { WorkOrder, Customer } from "@/lib/domain";

export function ShopFloorGrid({ orders, customers, asOf, onSelect }: {
  orders: WorkOrder[];
  customers: Customer[];
  asOf: string;
  onSelect?: (workOrderId: string) => void;
}) {
  const loads = equipmentLoads(orders, asOf);
  const summary = shopFloorSummary(loads);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const equipById = new Map(EQUIPMENT.map((e) => [e.id, e]));

  return (
    <div>
      <div data-testid="shopfloor-summary" className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Running" value={String(summary.running)} />
        <KpiTile label="Idle" value={String(summary.idle)} />
        <KpiTile label="On hold" value={String(summary.onHold)} tone="warn" />
        <KpiTile label="Late" value={String(summary.late)} tone="danger" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loads.map((entry) => {
          const equipment = equipById.get(entry.equipmentId)!;
          const name = entry.load ? (custById.get(entry.load.customerId)?.name ?? null) : null;
          return (
            <EquipmentTile key={entry.equipmentId} equipment={equipment} entry={entry} customerName={name} onSelect={onSelect} />
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/shop-floor/shop-floor-grid.test.tsx`
Expected: PASS (2 tests).

> If the `Idle`-count assertion is brittle against `KpiTile`'s DOM (label and value are sibling `div`s inside the tile), adjust it to read the tile by proximity — e.g. assert `within(summary).getByText("10")` is present alongside a `getByText("Idle")`. Do not change `KpiTile`.

- [ ] **Step 5: Commit**

```bash
git add components/shop-floor/shop-floor-grid.tsx components/shop-floor/shop-floor-grid.test.tsx
git commit -m "feat(shop-floor): add ShopFloorGrid summary strip + tile grid" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Wire the Shop Floor page + E2E happy path

**Files:**
- Modify (replace body): `app/(app)/shop-floor/page.tsx`
- Create: `tests/e2e/shop-floor.spec.ts`

**Interfaces:**
- Consumes: `useWorkOrders`, `useCustomers` from `@/lib/query/hooks`; `PageHeader`, `SkeletonRows`, `ErrorPanel` from `@/components/patterns`; `ShopFloorGrid` (Task 6); `useRouter` from `next/navigation`.

- [ ] **Step 1: Read the Next docs for App-Router client pages**

Run: `ls node_modules/next/dist/docs/01-app` and read the relevant page/routing guide.
Confirm the `"use client"` + `useRouter().push` pattern matches `app/(app)/orders/page.tsx` (it does). Note any deprecation before editing.

- [ ] **Step 2: Write the failing E2E test**

Create `tests/e2e/shop-floor.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("shop floor shows a running furnace and drills into its order", async ({ page }) => {
  await page.goto("/shop-floor");

  // Seed: WO-48211 (Apex) step 2 "Wash & rack" is in_process → Wash Station is Running.
  const tile = page.getByTestId("equipment-tile-eq-wash-1");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("WO-48211")).toBeVisible();

  await tile.click();

  await expect(page).toHaveURL(/\/orders\/wo-48211$/);
  await expect(page.getByTestId("order-progress")).toBeVisible();
});
```

- [ ] **Step 3: Run the E2E to verify it fails**

Run: `npm run test:e2e -- shop-floor`
Expected: FAIL — the placeholder page renders no `equipment-tile-eq-wash-1`.

- [ ] **Step 4: Replace `app/(app)/shop-floor/page.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useWorkOrders, useCustomers } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ShopFloorGrid } from "@/components/shop-floor/shop-floor-grid";
import { openOrders } from "@/lib/logic/dashboard";

export default function ShopFloorPage() {
  const router = useRouter();
  const orders = useWorkOrders();
  const customers = useCustomers();

  if (orders.isLoading || customers.isLoading) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;

  const now = new Date().toISOString();
  return (
    <div>
      <PageHeader title="Shop Floor" subtitle="Live furnace & oven status — derived from orders in process." />
      <ShopFloorGrid
        orders={openOrders(orders.data ?? [])}
        customers={customers.data ?? []}
        asOf={now}
        onSelect={(id) => router.push(`/orders/${id}`)}
      />
    </div>
  );
}
```

> `openOrders` drops shipped orders (they hold no live load) — mirrors the Tracking page. Idle furnaces still render because the grid iterates the full `EQUIPMENT` roster regardless of `orders`.

- [ ] **Step 5: Run the E2E to verify it passes**

Run: `npm run test:e2e -- shop-floor`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run:
```bash
npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0 && npm run build && npm run test:e2e
```
Expected: all green (vitest incl. new suites; build lists the `/shop-floor` route as a real page; all E2E specs pass, including the untouched `tracking.spec.ts` and `quote-to-invoice.spec.ts`).

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/shop-floor/page.tsx" tests/e2e/shop-floor.spec.ts
git commit -m "feat(shop-floor): replace placeholder with live equipment grid + E2E" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch adversarial review, fixes, and PR

**Files:** none by default (fixes as findings dictate).

- [ ] **Step 1: Confirm the full gate is green** (from Task 7 Step 6). Re-run if anything changed.

- [ ] **Step 2: Whole-branch adversarial review.** Per `superpowers:subagent-driven-development`, run the whole-branch review over the diff `main..heatsynq-shop-floor-equipment`: multiple independent finder subagents (correctness, honesty-of-derived-data, token/design-consistency, test-coverage) → refute-by-default skeptics. Focus areas specific to this slice:
  - `equipmentForStep` never returns an id outside the roster (fallback covered).
  - `equipmentLoads` counts **only** `in_process` steps; contention tie-break is deterministic; `late` uses `isLate` (already false for shipped, and shipped orders are filtered by the page).
  - No fabricated telemetry — setpoint/est-finish come only from real params + `trackedInAt`.
  - `asOf` is the sole time input to logic; no `Date.now()` inside `lib/logic/*`.
  - Idle tiles are non-interactive; loaded tiles navigate to the correct WO.
  - No new `any`/`eslint-disable`; tokens all exist.

- [ ] **Step 3: Apply confirmed fixes** (fresh subagent per fix, TDD), re-running the affected tests and then the full gate. Refuted findings: record and skip.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin heatsynq-shop-floor-equipment
gh pr create --base main --title "Plan 5 — Shop Floor (equipment monitor: live furnace grid)" --body "$(cat <<'EOF'
## Summary
Replaces the `/shop-floor` placeholder with a live equipment tile grid. Furnace/oven status is a **pure projection** over current `in_process` OrderStep loads — no new repo, mutation, or persisted entity.

- Equipment = static roster config (`lib/domain/enums.ts`).
- Pure logic (`lib/logic/shop-floor.ts`): `equipmentForStep`, `equipmentLoads`, `shopFloorSummary`, setpoint/duration parsers.
- Screen: status strip (`KpiTile`) + responsive tile grid; loaded tiles drill into Order Detail.
- Derived-only honest telemetry (setpoint + est-finish from real step params); no fabricated sensor data.
- `scheduled` status and Schedule/`ScheduleBlock` remain deferred to Plan 6.

## Testing
`npx vitest run` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `npm run build` · `npm run test:e2e` — all green. New: `lib/domain/equipment.test.ts`, `lib/logic/shop-floor.test.ts`, `components/shop-floor/*.test.tsx`, `tests/e2e/shop-floor.spec.ts`.

Spec: `docs/superpowers/specs/2026-07-01-heatsynq-shop-floor-equipment-design.md`
Plan: `docs/superpowers/plans/2026-07-01-heatsynq-shop-floor-equipment.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Confirm branch protection's `verify` check passes on the PR** before requesting merge.

---

## Notes & deliberate deviations from the spec

- **No seed data changes.** The spec (§11) allowed normalizing `equip` strings. It is unnecessary: `equipmentForStep` resolves the existing free-text `equip` labels (exact → heuristic → fallback), which is more faithful to the "mapper resolves free-text" design (mirrors `areaForOp`). Existing seed already demonstrates every state at the nominal date `2026-07-01`: **Running** = Wash Station (WO-48211, `Wash & rack` in_process) + Pit Furnace #1 (WO-48190, `Nitride` in_process); **On hold** = Batch IQ #3 (WO-48142, `Neutral harden` in_process, order on_hold); **Idle** = the remaining units; **LATE** = Batch IQ #3 (WO-48142 due 2026-06-28 < asOf). Zero seed churn ⇒ no risk to existing dashboard/seed/tracking tests.
- **`equipmentLoads` returns an array (roster order), not `Record<EquipmentId,…>`** as sketched in spec §6.3 — cleaner to build and the grid renders in roster order directly. Each entry still carries `equipmentId`.
- **Drill-in uses `router.push` via an `onSelect` callback** (matching `app/(app)/orders/page.tsx`), not a Next `<Link href>`. Same destination; consistent with the codebase's established list→detail navigation.
- **LATE in the live app is `asOf`-relative** (as everywhere in the app, e.g. the dashboard). It is verified deterministically in the unit + component tests with an explicit `asOf`; the E2E deliberately asserts only clock-independent facts (running state + drill-in).

## Self-review

- **Spec coverage:** §5 roster/kinds/states → Task 1. §6.1 `equipmentForStep` → Task 3. §6.2 parsers → Task 2. §6.3 `equipmentLoads` (idle/running/on-hold/late/contention) → Task 4. §6.4 `shopFloorSummary` → Task 4. §7 data flow (compose existing queries, no new hooks) → Task 7. §8 screen (status strip, tile grid, idle dimmed, drill-in, loading/error) → Tasks 5–7. §10 states/errors → Task 7 (guards on both queries). §11 seed → deliberately no-op (see Notes). §12 build sequence → Tasks 1–8. E2E (§10) → Task 7. Gate (§10) → every task + Task 7 Step 6.
- **Placeholder scan:** none — every code step contains complete code; no "TBD"/"handle edge cases"/"similar to Task N".
- **Type consistency:** `EquipmentId`, `EquipmentDef`, `EquipmentState`, `EquipmentLoad` used identically across Tasks 1/4/5/6; `equipmentForStep(step:{equip,op})`, `equipmentLoads(orders,asOf):EquipmentLoad[]`, `shopFloorSummary(loads)` signatures match every call site; `EquipmentTile({equipment,entry,customerName,onSelect})` and `ShopFloorGrid({orders,customers,asOf,onSelect})` props match their tests and the page.

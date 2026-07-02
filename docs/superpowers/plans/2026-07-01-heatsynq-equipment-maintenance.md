# HeatSynQ Plan 8 — Equipment & Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the static `EQUIPMENT` config to a seeded `WriteRepo` entity with a persisted `availability` field, and add the AMS-2750 pyrometry `Maintenance` entity (TUS/SAT schedule rows, derived due/overdue, single-write mark-complete), surfaced through a new `/shop-floor/[equipmentId]` detail page and availability-aware Schedule dialogs.

**Architecture:** Roster rows move from `lib/domain/enums.ts` to the seed; two new WriteRepos (`equipment`, `maintenance`); pure derivation functions take `equipment: Equipment[]` as a parameter instead of importing a const; availability wins the displayed state but running/idle/on_hold stay derived from WorkOrder steps; due/overdue is derived at read (`nextDueAt <= asOf`, Plan-7 `isReviewDue` semantics).

**Tech Stack:** Next 16 (app router — **read `node_modules/next/dist/docs/` before any Next-specific code**, per AGENTS.md), React 19, TanStack Query, zod, Tailwind tokens, vitest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-01-heatsynq-equipment-maintenance-design.md` — read it before starting any task.

## Global Constraints

- UI depends only on async repo interfaces via Query hooks — components never import seed or mock directly.
- Dates: ISO strings; day-precision fields are midnight-UTC (`"2026-06-30T00:00:00.000Z"`). Frozen clock `DEMO_NOW = "2026-06-30T12:00:00.000Z"` from `lib/clock.ts` — never `Date.now()`/`new Date().toISOString()` in new logic; `/shop-floor` pages use `DEMO_NOW` as `asOf` and mutation `at`.
- Money: integer cents (no money fields in this plan).
- IBM Plex Mono via `MonoId` / `font-mono` for ids, numbers, dates-in-tables, pills; exact design tokens (`text-text-muted`, `rounded-card`, `border-border`, `bg-surface`, `StatusTone` values).
- `any` only in the two approved mock-plumbing signatures in `lib/data/mock/repositories.ts` — this plan adds **zero** new `any`/`eslint-disable`.
- Every update is optimistic-concurrency: `update(id, patch, expectedVersion)`; version conflict throws (silent no-op in UI — accepted convention).
- Permissions via authenticated `operator.role` + `useCan` — never `viewAs`. New permission: `maintain_equipment: ["manager", "office"]`.
- Gate stays green after every task: `npm test`, `npx tsc --noEmit`, `npm run lint -- --max-warnings 0`, `npm run build`, `npm run test:e2e` (e2e at least at Tasks 8–9).
- Honest telemetry: NO fabricated live temps/countdowns/alarms anywhere.
- Commit after every task (small, descriptive; no Claude attribution lines beyond repo convention).

---

### Task 1: Domain vocabulary + entity schemas

**Files:**
- Modify: `lib/domain/enums.ts` (lines 110–116 region; add new blocks after `equipmentKindMeta`)
- Modify: `lib/domain/entities.ts` (append after `standardSchema`, ~line 236; extend the `./enums` import)
- Test: `lib/domain/equipment-maintenance.test.ts` (create)

**Interfaces:**
- Consumes: existing `baseEntitySchema`, `StatusTone`, `EQUIPMENT_KINDS`.
- Produces (later tasks rely on these exact names):
  - `EQUIPMENT_AVAILABILITY`, `type EquipmentAvailability`, `equipmentAvailabilityMeta`
  - `EQUIPMENT_STATES` (now 5 values), `equipmentStateMeta` (5 entries)
  - `MAINTENANCE_TYPES`, `type MaintenanceType`, `maintenanceTypeMeta`
  - `equipmentSchema`, `type Equipment = { id; createdAt; updatedAt; version; name; kind; availability; note }`
  - `maintenanceSchema`, `type Maintenance = { id; createdAt; updatedAt; version; equipmentId; type; specificationId; intervalDays; lastDoneAt; nextDueAt }`
- Do NOT touch `EQUIPMENT`/`EquipmentDef`/`EquipmentId` yet — they are deleted in Task 6.

- [ ] **Step 1: Write the failing test**

`lib/domain/equipment-maintenance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  EQUIPMENT_AVAILABILITY, equipmentAvailabilityMeta,
  EQUIPMENT_STATES, equipmentStateMeta,
  MAINTENANCE_TYPES, maintenanceTypeMeta,
} from "@/lib/domain/enums";
import { equipmentSchema, maintenanceSchema } from "@/lib/domain";

const base = { id: "x", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0 };

describe("equipment availability vocab", () => {
  it("has the three availability values with metas", () => {
    expect([...EQUIPMENT_AVAILABILITY]).toEqual(["available", "down", "maintenance"]);
    expect(equipmentAvailabilityMeta.down).toEqual({ label: "Down", tone: "danger" });
    expect(equipmentAvailabilityMeta.maintenance).toEqual({ label: "Maintenance", tone: "warn" });
    expect(equipmentAvailabilityMeta.available.tone).toBe("neutral");
  });
  it("extends display states with down and maintenance", () => {
    expect([...EQUIPMENT_STATES]).toEqual(["running", "idle", "on_hold", "down", "maintenance"]);
    expect(equipmentStateMeta.down).toEqual({ label: "Down", tone: "danger" });
    expect(equipmentStateMeta.maintenance).toEqual({ label: "Maintenance", tone: "warn" });
  });
  it("has maintenance types with labels", () => {
    expect([...MAINTENANCE_TYPES]).toEqual(["tus", "sat"]);
    expect(maintenanceTypeMeta.tus.label).toBe("TUS");
    expect(maintenanceTypeMeta.sat.label).toBe("SAT");
  });
});

describe("equipmentSchema", () => {
  it("parses a valid unit and rejects a bad availability", () => {
    const ok = { ...base, id: "eq-iq-1", name: "Batch IQ #1", kind: "batch_iq", availability: "available", note: null };
    expect(() => equipmentSchema.parse(ok)).not.toThrow();
    expect(() => equipmentSchema.parse({ ...ok, availability: "broken" })).toThrow();
    expect(() => equipmentSchema.parse({ ...ok, kind: "smelter" })).toThrow();
  });
  it("accepts a note string when down", () => {
    const down = { ...base, id: "eq-temper-2", name: "Temper Oven #2", kind: "temper", availability: "down", note: "Control board fault" };
    expect(equipmentSchema.parse(down).note).toBe("Control board fault");
  });
});

describe("maintenanceSchema", () => {
  const ok = {
    ...base, id: "mnt-iq-1-tus", equipmentId: "eq-iq-1", type: "tus",
    specificationId: "spec-ams2750", intervalDays: 90,
    lastDoneAt: "2026-05-17T00:00:00.000Z", nextDueAt: "2026-08-15T00:00:00.000Z",
  };
  it("parses a valid row", () => { expect(() => maintenanceSchema.parse(ok)).not.toThrow(); });
  it("rejects a bad type and a non-positive interval", () => {
    expect(() => maintenanceSchema.parse({ ...ok, type: "oil_change" })).toThrow();
    expect(() => maintenanceSchema.parse({ ...ok, intervalDays: 0 })).toThrow();
    expect(() => maintenanceSchema.parse({ ...ok, intervalDays: 1.5 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/equipment-maintenance.test.ts`
Expected: FAIL — `EQUIPMENT_AVAILABILITY` etc. not exported.

- [ ] **Step 3: Implement**

`lib/domain/enums.ts` — replace the `EQUIPMENT_STATES` block (currently lines 110–116) with, and add the two new vocab blocks directly after `equipmentKindMeta` (keep `EQUIPMENT` const untouched for now):

```ts
export const EQUIPMENT_AVAILABILITY = ["available", "down", "maintenance"] as const;
export type EquipmentAvailability = (typeof EQUIPMENT_AVAILABILITY)[number];
export const equipmentAvailabilityMeta: Record<EquipmentAvailability, { label: string; tone: StatusTone }> = {
  available:   { label: "Available",   tone: "neutral" },
  down:        { label: "Down",        tone: "danger" },
  maintenance: { label: "Maintenance", tone: "warn" },
};

export const MAINTENANCE_TYPES = ["tus", "sat"] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];
export const maintenanceTypeMeta: Record<MaintenanceType, { label: string }> = {
  tus: { label: "TUS" },
  sat: { label: "SAT" },
};

export const EQUIPMENT_STATES = ["running", "idle", "on_hold", "down", "maintenance"] as const;
export type EquipmentState = (typeof EQUIPMENT_STATES)[number];
export const equipmentStateMeta: Record<EquipmentState, { label: string; tone: StatusTone }> = {
  running:     { label: "Running",     tone: "success" },
  idle:        { label: "Idle",        tone: "neutral" },
  on_hold:     { label: "On hold",     tone: "warn" },
  down:        { label: "Down",        tone: "danger" },
  maintenance: { label: "Maintenance", tone: "warn" },
};
```

`lib/domain/entities.ts` — add `EQUIPMENT_KINDS, EQUIPMENT_AVAILABILITY, MAINTENANCE_TYPES` to the existing `./enums` import, then append after `standardSchema`:

```ts
export const equipmentSchema = baseEntitySchema.extend({
  name: z.string(),
  kind: z.enum(EQUIPMENT_KINDS),
  availability: z.enum(EQUIPMENT_AVAILABILITY),
  note: z.string().nullable(),      // why down/maintenance; null when available
});
export type Equipment = z.infer<typeof equipmentSchema>;

export const maintenanceSchema = baseEntitySchema.extend({
  equipmentId: z.string(),          // FK equipment (foreign keys are z.string(), like customerId)
  type: z.enum(MAINTENANCE_TYPES),
  specificationId: z.string(),      // FK specification — AMS 2750 pyrometry
  intervalDays: z.number().int().positive(),
  lastDoneAt: z.string(),           // ISO midnight-UTC — last completed survey
  nextDueAt: z.string(),            // ISO midnight-UTC — next survey due
});
export type Maintenance = z.infer<typeof maintenanceSchema>;
```

- [ ] **Step 4: Run tests to verify pass + no fallout**

Run: `npx vitest run lib/domain/equipment-maintenance.test.ts` → PASS.
Run: `npm test` → the pre-existing `lib/domain/equipment.test.ts` "every state has state metadata" test still passes (it iterates `EQUIPMENT_STATES`, now 5). All green.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/enums.ts lib/domain/entities.ts lib/domain/equipment-maintenance.test.ts
git commit -m "feat(domain): equipment availability + maintenance vocab and schemas"
```

---

### Task 2: Maintenance pure logic

**Files:**
- Create: `lib/logic/maintenance.ts`
- Test: `lib/logic/maintenance.test.ts` (create)

**Interfaces:**
- Consumes: `Maintenance` type (Task 1).
- Produces (exact signatures):
  - `isMaintenanceDue(task: Maintenance, asOf: string): boolean` — `nextDueAt <= asOf` boundary-inclusive
  - `dueMaintenance(tasks: Maintenance[], asOf: string): Maintenance[]` — due only, sorted `nextDueAt` asc
  - `maintenanceForEquipment(tasks: Maintenance[], equipmentId: string): Maintenance[]` — sorted `nextDueAt` asc
  - `completePatch(task: Maintenance, atIso: string): { lastDoneAt: string; nextDueAt: string }`

- [ ] **Step 1: Write the failing test**

`lib/logic/maintenance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isMaintenanceDue, dueMaintenance, maintenanceForEquipment, completePatch } from "./maintenance";
import type { Maintenance } from "@/lib/domain";

function task(p: Partial<Maintenance> & Pick<Maintenance, "id" | "nextDueAt">): Maintenance {
  return {
    createdAt: "", updatedAt: "", version: 0, equipmentId: "eq-iq-1", type: "tus",
    specificationId: "spec-ams2750", intervalDays: 90, lastDoneAt: "2026-03-01T00:00:00.000Z", ...p,
  };
}

describe("isMaintenanceDue", () => {
  const t = task({ id: "m1", nextDueAt: "2026-06-30T00:00:00.000Z" });
  it("is due before and exactly on the boundary instant", () => {
    expect(isMaintenanceDue(t, "2026-06-30T00:00:00.000Z")).toBe(true);  // boundary counts
    expect(isMaintenanceDue(t, "2026-06-30T12:00:00.000Z")).toBe(true);
    expect(isMaintenanceDue(t, "2026-07-01T00:00:00.000Z")).toBe(true);
  });
  it("is not due when nextDueAt is in the future", () => {
    expect(isMaintenanceDue(t, "2026-06-29T23:59:59.000Z")).toBe(false);
  });
});

describe("dueMaintenance", () => {
  it("filters to due rows sorted by nextDueAt ascending", () => {
    const a = task({ id: "a", nextDueAt: "2026-06-25T00:00:00.000Z" });
    const b = task({ id: "b", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const c = task({ id: "c", nextDueAt: "2026-08-01T00:00:00.000Z" });
    expect(dueMaintenance([c, b, a], "2026-06-30T12:00:00.000Z").map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("maintenanceForEquipment", () => {
  it("filters by equipment and sorts by nextDueAt", () => {
    const a = task({ id: "a", equipmentId: "eq-vac-1", nextDueAt: "2026-08-25T00:00:00.000Z" });
    const b = task({ id: "b", equipmentId: "eq-vac-1", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const other = task({ id: "x", equipmentId: "eq-iq-1", nextDueAt: "2026-01-01T00:00:00.000Z" });
    expect(maintenanceForEquipment([a, other, b], "eq-vac-1").map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("completePatch", () => {
  it("floors the completion instant to midnight-UTC and rolls nextDueAt forward by intervalDays", () => {
    const t = task({ id: "m", intervalDays: 30, nextDueAt: "2026-06-30T00:00:00.000Z" });
    expect(completePatch(t, "2026-06-30T12:00:00.000Z")).toEqual({
      lastDoneAt: "2026-06-30T00:00:00.000Z",
      nextDueAt: "2026-07-30T00:00:00.000Z",
    });
  });
  it("crosses month/year boundaries in UTC", () => {
    const t = task({ id: "m", intervalDays: 90, nextDueAt: "x" });
    expect(completePatch(t, "2026-12-15T08:30:00.000Z")).toEqual({
      lastDoneAt: "2026-12-15T00:00:00.000Z",
      nextDueAt: "2027-03-15T00:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/logic/maintenance.test.ts`
Expected: FAIL — cannot resolve `./maintenance`.

- [ ] **Step 3: Implement**

`lib/logic/maintenance.ts`:

```ts
import type { Maintenance } from "@/lib/domain";

const DAY_MS = 86_400_000;

/** Survey is due on or before `asOf` — the boundary instant counts as due (Plan-7 isReviewDue semantics). */
export function isMaintenanceDue(task: Maintenance, asOf: string): boolean {
  return new Date(task.nextDueAt).getTime() <= new Date(asOf).getTime();
}

export function dueMaintenance(tasks: Maintenance[], asOf: string): Maintenance[] {
  return tasks.filter((t) => isMaintenanceDue(t, asOf)).sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

export function maintenanceForEquipment(tasks: Maintenance[], equipmentId: string): Maintenance[] {
  return tasks.filter((t) => t.equipmentId === equipmentId).sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

/** Mark-complete patch: completion day (midnight-UTC) becomes lastDoneAt; nextDueAt rolls forward by intervalDays. */
export function completePatch(task: Maintenance, atIso: string): { lastDoneAt: string; nextDueAt: string } {
  const d = new Date(atIso);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    lastDoneAt: new Date(day).toISOString(),
    nextDueAt: new Date(day + task.intervalDays * DAY_MS).toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run lib/logic/maintenance.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/maintenance.ts lib/logic/maintenance.test.ts
git commit -m "feat(logic): maintenance due/complete pure functions"
```

---

### Task 3: Seed data, repositories, mock wiring

**Files:**
- Modify: `lib/data/seed/index.ts` (add `equipment`/`maintenance` arrays before `counters` ~line 905; extend the return object and the file's `@/lib/domain` type import)
- Modify: `lib/data/repositories/index.ts` (add both repos to `Repositories` + type import)
- Modify: `lib/data/mock/repositories.ts` (two `cols` entries + two wiring lines)
- Modify: `lib/data/seed/seed.test.ts` (schema lines, FK swap, story tests)
- Modify: `lib/domain/equipment.test.ts` (drop `EQUIPMENT` import — vocab-only invariants)

**Interfaces:**
- Consumes: `Equipment`, `Maintenance`, schemas (Task 1); `isMaintenanceDue` (Task 2).
- Produces: `buildSeed()` returns `equipment: Equipment[]` (10 rows, display order) and `maintenance: Maintenance[]` (16 rows); `Repositories.equipment: WriteRepo<Equipment>`, `Repositories.maintenance: WriteRepo<Maintenance>`. Seed ids: `eq-*` (unchanged 10), `mnt-<unit-suffix>-<type>` (e.g. `mnt-iq-3-tus`, `mnt-vac-1-sat`).

- [ ] **Step 1: Write the failing tests**

In `lib/data/seed/seed.test.ts`:
1. Extend the `@/lib/domain` import with `equipmentSchema, maintenanceSchema`.
2. Replace `import { EQUIPMENT } from "@/lib/domain/enums";` with `import { isMaintenanceDue } from "@/lib/logic/maintenance";` (keep the `isReviewDue`/`DEMO_NOW` imports).
3. Add to the schema-validation test body:

```ts
    s.equipment.forEach((r) => expect(() => equipmentSchema.parse(r)).not.toThrow());
    s.maintenance.forEach((r) => expect(() => maintenanceSchema.parse(r)).not.toThrow());
```

4. In the FK test, replace the scheduleBlocks block with, and append the maintenance block:

```ts
    // scheduleBlocks -> workOrder / equipment
    s.scheduleBlocks.forEach((b) => {
      expect(has(s.workOrders, b.workOrderId)).toBe(true);
      expect(has(s.equipment, b.equipmentId)).toBe(true);
    });
    // maintenance -> equipment / specification
    s.maintenance.forEach((m) => {
      expect(has(s.equipment, m.equipmentId)).toBe(true);
      expect(has(s.specifications, m.specificationId)).toBe(true);
    });
```

5. Add three story tests inside `describe("seed")`:

```ts
  it("seeds the equipment roster: 10 units, temper-2 down, vac-1 in maintenance", () => {
    expect(s.equipment).toHaveLength(10);
    const ids = s.equipment.map((e) => e.id);
    expect(new Set(ids).size).toBe(10);
    expect(new Set(s.equipment.map((e) => e.name)).size).toBe(10);
    expect(s.equipment.filter((e) => e.availability === "down").map((e) => e.id)).toEqual(["eq-temper-2"]);
    expect(s.equipment.filter((e) => e.availability === "maintenance").map((e) => e.id)).toEqual(["eq-vac-1"]);
    s.equipment.forEach((e) => { if (e.availability === "available") expect(e.note).toBeNull(); else expect(e.note).toBeTruthy(); });
  });

  it("keeps every shop-floor heuristic fallback id resolvable in the seeded roster", () => {
    for (const id of ["eq-vac-1", "eq-belt-1", "eq-pit-1", "eq-wash-1", "eq-inspect-1", "eq-temper-1", "eq-iq-1"]) {
      expect(s.equipment.some((e) => e.id === id)).toBe(true);
    }
  });

  it("seeds pyrometry TUS/SAT for the 8 thermal units with exactly two due rows", () => {
    expect(s.maintenance).toHaveLength(16);
    const thermal = ["eq-iq-1", "eq-iq-2", "eq-iq-3", "eq-temper-1", "eq-temper-2", "eq-vac-1", "eq-pit-1", "eq-belt-1"];
    for (const id of thermal) {
      expect(s.maintenance.filter((m) => m.equipmentId === id).map((m) => m.type).sort()).toEqual(["sat", "tus"]);
    }
    expect(s.maintenance.some((m) => m.equipmentId === "eq-wash-1" || m.equipmentId === "eq-inspect-1")).toBe(false);
    const due = s.maintenance.filter((m) => isMaintenanceDue(m, DEMO_NOW)).map((m) => m.id).sort();
    expect(due).toEqual(["mnt-iq-3-tus", "mnt-vac-1-sat"]);
    s.maintenance.forEach((m) => expect(m.specificationId).toBe("spec-ams2750"));
  });
```

In `lib/domain/equipment.test.ts`: delete the two roster tests ("has a non-empty roster…", "includes the furnace kinds…") and the first roster loop test; keep only vocab invariants. Final content:

```ts
import { describe, it, expect } from "vitest";
import {
  EQUIPMENT_KINDS, EQUIPMENT_STATES, EQUIPMENT_AVAILABILITY,
  equipmentKindMeta, equipmentStateMeta, equipmentAvailabilityMeta,
} from "@/lib/domain/enums";

describe("equipment vocab", () => {
  it("every kind has kind metadata", () => {
    for (const k of EQUIPMENT_KINDS) expect(equipmentKindMeta[k].label.length).toBeGreaterThan(0);
  });
  it("every display state has state metadata with a tone", () => {
    for (const s of EQUIPMENT_STATES) {
      expect(equipmentStateMeta[s].label.length).toBeGreaterThan(0);
      expect(equipmentStateMeta[s].tone).toBeTruthy();
    }
  });
  it("every availability has metadata with a tone", () => {
    for (const a of EQUIPMENT_AVAILABILITY) {
      expect(equipmentAvailabilityMeta[a].label.length).toBeGreaterThan(0);
      expect(equipmentAvailabilityMeta[a].tone).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/data/seed/seed.test.ts lib/domain/equipment.test.ts`
Expected: seed.test FAILS (`s.equipment` undefined); equipment.test PASSES already (vocab exists since Task 1) — that's fine, it's a migration not a new behavior.

- [ ] **Step 3: Implement seed + repos + mock**

`lib/data/seed/index.ts` — extend the `@/lib/domain` type import with `Equipment, Maintenance`. Insert before the `counters` line (~905):

```ts
  const equipment: Equipment[] = [
    { ...meta, id: "eq-iq-1",      name: "Batch IQ #1",        kind: "batch_iq",   availability: "available",   note: null },
    { ...meta, id: "eq-iq-2",      name: "Batch IQ #2",        kind: "batch_iq",   availability: "available",   note: null },
    { ...meta, id: "eq-iq-3",      name: "Batch IQ #3",        kind: "batch_iq",   availability: "available",   note: null },
    { ...meta, id: "eq-temper-1",  name: "Temper Oven #1",     kind: "temper",     availability: "available",   note: null },
    { ...meta, id: "eq-temper-2",  name: "Temper Oven #2",     kind: "temper",     availability: "down",        note: "Setpoint deviation +18°F — control board fault" },
    { ...meta, id: "eq-vac-1",     name: "Vacuum Furnace #1",  kind: "vacuum",     availability: "maintenance", note: "SAT in progress — system accuracy test" },
    { ...meta, id: "eq-pit-1",     name: "Pit Furnace #1",     kind: "pit",        availability: "available",   note: null },
    { ...meta, id: "eq-belt-1",    name: "Continuous Belt #1", kind: "continuous", availability: "available",   note: null },
    { ...meta, id: "eq-wash-1",    name: "Wash Station",       kind: "wash",       availability: "available",   note: null },
    { ...meta, id: "eq-inspect-1", name: "Inspection",         kind: "inspect",    availability: "available",   note: null },
  ];

  // AMS-2750 pyrometry schedule: TUS every 90 days, SAT every 30 (demo values — real
  // intervals vary by furnace class/instrumentation, which the app does not model).
  const DAY = 86_400_000;
  function mnt(equipmentId: string, type: Maintenance["type"], intervalDays: number, nextDueAt: string): Maintenance {
    return {
      ...meta, id: `mnt-${equipmentId.replace(/^eq-/, "")}-${type}`, equipmentId, type,
      specificationId: "spec-ams2750", intervalDays,
      lastDoneAt: new Date(new Date(nextDueAt).getTime() - intervalDays * DAY).toISOString(),
      nextDueAt,
    };
  }
  const maintenance: Maintenance[] = [
    mnt("eq-iq-1",     "tus", 90, "2026-08-15T00:00:00.000Z"),
    mnt("eq-iq-1",     "sat", 30, "2026-07-08T00:00:00.000Z"),
    mnt("eq-iq-2",     "tus", 90, "2026-07-20T00:00:00.000Z"),
    mnt("eq-iq-2",     "sat", 30, "2026-07-12T00:00:00.000Z"),
    mnt("eq-iq-3",     "tus", 90, "2026-06-25T00:00:00.000Z"), // OVERDUE vs DEMO_NOW — loaded furnace, compliance red flag
    mnt("eq-iq-3",     "sat", 30, "2026-07-05T00:00:00.000Z"),
    mnt("eq-temper-1", "tus", 90, "2026-09-01T00:00:00.000Z"),
    mnt("eq-temper-1", "sat", 30, "2026-07-15T00:00:00.000Z"),
    mnt("eq-temper-2", "tus", 90, "2026-08-05T00:00:00.000Z"),
    mnt("eq-temper-2", "sat", 30, "2026-07-18T00:00:00.000Z"),
    mnt("eq-vac-1",    "tus", 90, "2026-08-25T00:00:00.000Z"),
    mnt("eq-vac-1",    "sat", 30, "2026-06-30T00:00:00.000Z"), // DUE TODAY (boundary) — the unit under maintenance
    mnt("eq-pit-1",    "tus", 90, "2026-07-30T00:00:00.000Z"),
    mnt("eq-pit-1",    "sat", 30, "2026-07-22T00:00:00.000Z"),
    mnt("eq-belt-1",   "tus", 90, "2026-09-10T00:00:00.000Z"),
    mnt("eq-belt-1",   "sat", 30, "2026-07-25T00:00:00.000Z"),
  ];
```

Add `equipment,` and `maintenance,` to the returned object (after `scheduleBlocks,`).

`lib/data/repositories/index.ts` — extend the type import with `Equipment, Maintenance`; add to `Repositories` after `scheduleBlocks`:

```ts
  equipment: WriteRepo<Equipment>;
  maintenance: WriteRepo<Maintenance>;
```

`lib/data/mock/repositories.ts` — add to `cols`:

```ts
    equipment: new Collection(seed.equipment),
    maintenance: new Collection(seed.maintenance),
```

and to the returned map (after `scheduleBlocks: write(cols.scheduleBlocks),`):

```ts
    equipment: write(cols.equipment),
    maintenance: write(cols.maintenance),
```

(un-keyed `write` → no auto-numbering; seeded ids survive updates.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run lib/data/seed/seed.test.ts lib/domain/equipment.test.ts` → PASS.
Run: `npm test && npx tsc --noEmit` → all green (nothing consumes the new repos yet).

- [ ] **Step 5: Commit**

```bash
git add lib/data/seed/index.ts lib/data/repositories/index.ts lib/data/mock/repositories.ts lib/data/seed/seed.test.ts lib/domain/equipment.test.ts
git commit -m "feat(data): seed equipment roster + pyrometry schedule, wire WriteRepos"
```

---

### Task 4: Query keys, read hooks, permission

**Files:**
- Modify: `lib/query/keys.ts`
- Modify: `lib/query/hooks.ts` (read-hook one-liners + type import)
- Modify: `lib/auth/permissions.ts`
- Test: `lib/auth/permissions.test.ts` (create)

**Interfaces:**
- Produces:
  - `queryKeys.equipment = ["equipment"]`, `queryKeys.equipmentUnit = (id) => ["equipment", id]`, `queryKeys.maintenance = ["maintenance"]`
  - `useEquipment()`, `useEquipmentUnit(id: string)`, `useMaintenance()` — thin `useQuery` wrappers
  - `Permission` union gains `"maintain_equipment"`; `can(role, "maintain_equipment")` true for manager/office only

- [ ] **Step 1: Write the failing test**

`lib/auth/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { can } from "./permissions";

describe("maintain_equipment", () => {
  it("grants manager and office, denies sales", () => {
    expect(can("manager", "maintain_equipment")).toBe(true);
    expect(can("office", "maintain_equipment")).toBe(true);
    expect(can("sales", "maintain_equipment")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/auth/permissions.test.ts`
Expected: FAIL — TS error / `maintain_equipment` not a `Permission`.

- [ ] **Step 3: Implement**

`lib/auth/permissions.ts` — extend the union and matrix:

```ts
export type Permission = "approve_over_limit" | "apply_discount" | "release_cert" | "close_period" | "edit_setup" | "schedule_loads" | "maintain_equipment";
```

and in `MATRIX`: `maintain_equipment: ["manager", "office"],`

`lib/query/keys.ts` — append inside `queryKeys`:

```ts
  equipment: ["equipment"] as const,
  equipmentUnit: (id: string) => ["equipment", id] as const,
  maintenance: ["maintenance"] as const,
```

`lib/query/hooks.ts` — extend the `@/lib/domain` type import with `Equipment, Maintenance` (types used by Task 7 mutations; harmless now), and add after `useScheduleBlocks`:

```ts
export function useEquipment() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.equipment, queryFn: () => r.equipment.list() }); }
export function useEquipmentUnit(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.equipmentUnit(id), queryFn: () => r.equipment.get(id) }); }
export function useMaintenance() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.maintenance, queryFn: () => r.maintenance.list() }); }
```

(If `Equipment`/`Maintenance` are unused until Task 7, omit them from the import until then — `--max-warnings 0` fails on unused imports.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run lib/auth/permissions.test.ts` → PASS. `npm test && npx tsc --noEmit && npm run lint -- --max-warnings 0` → green.

- [ ] **Step 5: Commit**

```bash
git add lib/query/keys.ts lib/query/hooks.ts lib/auth/permissions.ts lib/auth/permissions.test.ts
git commit -m "feat(query,auth): equipment/maintenance read hooks + maintain_equipment permission"
```

---

### Task 5: Shop-floor derivation migration + grid/tile/page

**Files:**
- Modify: `lib/logic/shop-floor.ts`
- Modify: `components/shop-floor/shop-floor-grid.tsx`
- Modify: `components/shop-floor/equipment-tile.tsx`
- Modify: `app/(app)/shop-floor/page.tsx`
- Test: `lib/logic/shop-floor.test.ts`, `components/shop-floor/shop-floor-grid.test.tsx`, `components/shop-floor/equipment-tile.test.tsx`, `app/(app)/shop-floor/shop-floor-page.test.tsx` (all modify)

**Interfaces:**
- Consumes: `Equipment` (Task 1), `useEquipment`/`useMaintenance` (Task 4), `dueMaintenance` (Task 2), `DEMO_NOW` from `@/lib/clock`.
- Produces (later tasks rely on):
  - `equipmentForStep(step: { equip: string; op: string }, equipment: Equipment[]): string`
  - `equipmentLoads(orders: WorkOrder[], equipment: Equipment[], asOf: string): EquipmentLoad[]` — `EquipmentLoad.equipmentId: string`; availability precedence
  - `shopFloorSummary(loads): { running; idle; onHold; late; outOfService }`
  - `ShopFloorGrid` props: `{ orders, customers, equipment, maintenance, asOf, onSelect?: (workOrderId: string) => void }` (onSelect retargeted to equipment ids in Task 8)
  - `EquipmentTile` props: `{ equipment: Equipment; entry: EquipmentLoad; customerName; onSelect? }`
- Tile click behavior UNCHANGED in this task (loaded tile → order). Task 8 retargets it.

- [ ] **Step 1: Update tests to the new signatures + add availability cases**

`lib/logic/shop-floor.test.ts`:
1. Add imports: `import type { Equipment } from "@/lib/domain";`
2. Add fixtures after the `wo()` helper:

```ts
function equip(p: Partial<Equipment> & Pick<Equipment, "id" | "name" | "kind">): Equipment {
  return { createdAt: "", updatedAt: "", version: 0, availability: "available", note: null, ...p };
}
const ROSTER: Equipment[] = [
  equip({ id: "eq-iq-1", name: "Batch IQ #1", kind: "batch_iq" }),
  equip({ id: "eq-iq-2", name: "Batch IQ #2", kind: "batch_iq" }),
  equip({ id: "eq-iq-3", name: "Batch IQ #3", kind: "batch_iq" }),
  equip({ id: "eq-temper-1", name: "Temper Oven #1", kind: "temper" }),
  equip({ id: "eq-temper-2", name: "Temper Oven #2", kind: "temper" }),
  equip({ id: "eq-vac-1", name: "Vacuum Furnace #1", kind: "vacuum" }),
  equip({ id: "eq-pit-1", name: "Pit Furnace #1", kind: "pit" }),
  equip({ id: "eq-belt-1", name: "Continuous Belt #1", kind: "continuous" }),
  equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" }),
  equip({ id: "eq-inspect-1", name: "Inspection", kind: "inspect" }),
];
```

3. Mechanically update every call: `equipmentForStep(step)` → `equipmentForStep(step, ROSTER)`; `equipmentLoads(orders, AS_OF)` → `equipmentLoads(orders, ROSTER, AS_OF)`.
4. Add availability tests:

```ts
  it("availability wins the displayed state but the tracked-in load still shows (honest)", () => {
    const roster = ROSTER.map((e) => e.id === "eq-iq-3" ? { ...e, availability: "down" as const, note: "Broken" } : e);
    const o = wo({
      id: "wo-1", number: "WO-1", status: "in_process",
      steps: [step({ n: 3, op: "Carburize", equip: "Batch IQ #3", state: "in_process",
        params: ["1700°F", "8.0 hr"], trackedInAt: "2026-07-01T06:00:00.000Z" })],
    });
    const iq3 = find(equipmentLoads([o], roster, AS_OF), "eq-iq-3");
    expect(iq3.state).toBe("down");
    expect(iq3.load?.workOrderNumber).toBe("WO-1");
    expect(iq3.load?.estFinishIso).toBeNull(); // no forecast unless running
  });

  it("an unloaded unit under maintenance reports state maintenance, not idle", () => {
    const roster = ROSTER.map((e) => e.id === "eq-vac-1" ? { ...e, availability: "maintenance" as const, note: "SAT" } : e);
    expect(find(equipmentLoads([], roster, AS_OF), "eq-vac-1").state).toBe("maintenance");
  });

  it("summary counts out-of-service units", () => {
    const roster = ROSTER.map((e) =>
      e.id === "eq-vac-1" ? { ...e, availability: "maintenance" as const } :
      e.id === "eq-temper-2" ? { ...e, availability: "down" as const } : e);
    const s = shopFloorSummary(equipmentLoads([], roster, AS_OF));
    expect(s.outOfService).toBe(2);
    expect(s.idle).toBe(8);
  });
```

`components/shop-floor/equipment-tile.test.tsx`: replace the `EQUIPMENT`/`EquipmentDef` import with the local fixture `equip()` (same helper as above, imported type `Equipment` from `@/lib/domain`); construct `iq3 = equip({ id: "eq-iq-3", name: "Batch IQ #3", kind: "batch_iq" })`. Add:

```ts
  it("shows the availability note when the unit is down", () => {
    const downUnit = equip({ id: "eq-temper-2", name: "Temper Oven #2", kind: "temper", availability: "down", note: "Control board fault" });
    render(<EquipmentTile equipment={downUnit} entry={{ equipmentId: "eq-temper-2", state: "down", load: null, queued: 0 }} customerName={null} />);
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(screen.getByText("Control board fault")).toBeInTheDocument();
    expect(screen.queryByText("No load · available")).not.toBeInTheDocument();
  });
```

`components/shop-floor/shop-floor-grid.test.tsx`: pass `equipment={ROSTER}` (same fixture) and `maintenance={[]}` props; the "tile for every unit" loop iterates `ROSTER`; the Idle KPI assertion stays "10" with an all-available fixture. Add a KPI test: with `eq-temper-2` down in the fixture and one `maintenance` task due (`nextDueAt: "2026-06-01T00:00:00.000Z"` vs `asOf` `2026-07-01`), "Out of service" shows "1" and "Pyrometry due" shows "1".

`app/(app)/shop-floor/shop-floor-page.test.tsx`: extend the `vi.mock("@/lib/query/hooks")` factory with `useEquipment: () => mockEquipment()` and `useMaintenance: () => mockMaintenance()`; add loading/error branches for each (mirror the existing customers cases — expect "Failed to load equipment." / "Failed to load maintenance.").

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/shop-floor.test.ts components/shop-floor app/\(app\)/shop-floor`
Expected: FAIL — signature mismatches (`equipmentLoads` arity), missing props.

- [ ] **Step 3: Implement**

`lib/logic/shop-floor.ts` — full replacement of the import line, `equipmentForStep`, `EquipmentLoad`, `equipmentLoads`, `shopFloorSummary` (parse helpers and `byTrackedInThenNumber` unchanged):

```ts
import type { EquipmentState } from "@/lib/domain/enums";
import { isLate } from "@/lib/logic/dashboard";
import type { WorkOrder, OrderStep, Equipment } from "@/lib/domain";
```

```ts
/** Resolve a step's free-text equip label to a roster equipment id. */
export function equipmentForStep(step: { equip: string; op: string }, equipment: Equipment[]): string {
  const raw = step.equip.trim().toLowerCase();
  const exact = equipment.find((e) => e.name.toLowerCase() === raw);
  if (exact) return exact.id;
  const s = `${step.equip} ${step.op}`.toLowerCase();
  if (/vacuum/.test(s)) return "eq-vac-1";
  if (/belt|continuous|carbonitr/.test(s)) return "eq-belt-1";
  if (/\bpit\b|nitrid/.test(s)) return "eq-pit-1";
  if (/wash/.test(s)) return "eq-wash-1";
  if (/inspect|lab/.test(s)) return "eq-inspect-1";
  if (/temper/.test(s)) return "eq-temper-1";
  if (/iq|batch|carbur|harden|anneal/.test(s)) return "eq-iq-1";
  return "eq-iq-1";
}

export type EquipmentLoad = {
  equipmentId: string;
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
```

```ts
/** Project open work orders onto the equipment roster. One entry per unit, in roster order.
 *  Persisted availability (down/maintenance) wins the displayed state; the load, if any,
 *  still renders — work physically in the furnace is never hidden. */
export function equipmentLoads(orders: WorkOrder[], equipment: Equipment[], asOf: string): EquipmentLoad[] {
  const byEquip = new Map<string, Candidate[]>(equipment.map((e) => [e.id, []]));
  for (const order of orders) {
    for (const s of order.steps) {
      if (s.state !== "in_process") continue;
      byEquip.get(equipmentForStep(s, equipment))?.push({ order, step: s });
    }
  }
  return equipment.map((e): EquipmentLoad => {
    const cands = byEquip.get(e.id)!;
    if (cands.length === 0) {
      const state: EquipmentState = e.availability === "available" ? "idle" : e.availability;
      return { equipmentId: e.id, state, load: null, queued: 0 };
    }
    const cur = [...cands].sort(byTrackedInThenNumber)[0];
    const state: EquipmentState = e.availability !== "available"
      ? e.availability
      : cur.order.status === "on_hold" ? "on_hold" : "running";
    const mins = parseDurationMinutes(cur.step.params);
    const estFinishIso = state === "running" && cur.step.trackedInAt && mins != null
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

export function shopFloorSummary(loads: EquipmentLoad[]): { running: number; idle: number; onHold: number; late: number; outOfService: number } {
  return {
    running: loads.filter((l) => l.state === "running").length,
    idle: loads.filter((l) => l.state === "idle").length,
    onHold: loads.filter((l) => l.state === "on_hold").length,
    late: loads.filter((l) => l.load?.late).length,
    outOfService: loads.filter((l) => l.state === "down" || l.state === "maintenance").length,
  };
}
```

`components/shop-floor/equipment-tile.tsx` — prop swap + note/no-load branch:

```tsx
import { StatusPill, MonoId } from "@/components/patterns";
import { equipmentStateMeta, equipmentKindMeta } from "@/lib/domain/enums";
import type { Equipment } from "@/lib/domain";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";
```

Prop type: `equipment: Equipment;` (rest unchanged). Add under the header in BOTH branches (out-of-service note):

```tsx
      {(entry.state === "down" || entry.state === "maintenance") && equipment.note && (
        <div className="text-text-muted mt-3 text-xs">{equipment.note}</div>
      )}
```

and in the no-load branch replace the fixed copy with:

```tsx
        {entry.state === "idle" && <div className="text-text-muted mt-3 text-xs">No load · available</div>}
```

(keep the `opacity-60` div for the no-load branch; the loaded branch keeps its `<button>` → order for now).

`components/shop-floor/shop-floor-grid.tsx` — full replacement:

```tsx
import { KpiTile } from "@/components/patterns";
import { equipmentLoads, shopFloorSummary } from "@/lib/logic/shop-floor";
import { dueMaintenance } from "@/lib/logic/maintenance";
import { EquipmentTile } from "./equipment-tile";
import type { WorkOrder, Customer, Equipment, Maintenance } from "@/lib/domain";

export function ShopFloorGrid({ orders, customers, equipment, maintenance, asOf, onSelect }: {
  orders: WorkOrder[];
  customers: Customer[];
  equipment: Equipment[];
  maintenance: Maintenance[];
  asOf: string;
  onSelect?: (workOrderId: string) => void;
}) {
  const loads = equipmentLoads(orders, equipment, asOf);
  const summary = shopFloorSummary(loads);
  const pyroDue = dueMaintenance(maintenance, asOf).length;
  const custById = new Map(customers.map((c) => [c.id, c]));
  const equipById = new Map(equipment.map((e) => [e.id, e]));

  return (
    <div>
      <div data-testid="shopfloor-summary" className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Running" value={String(summary.running)} />
        <KpiTile label="Idle" value={String(summary.idle)} />
        <KpiTile label="On hold" value={String(summary.onHold)} tone="warn" />
        <KpiTile label="Late" value={String(summary.late)} tone="danger" />
        <KpiTile label="Out of service" value={String(summary.outOfService)} tone="warn" />
        <KpiTile label="Pyrometry due" value={String(pyroDue)} tone={pyroDue > 0 ? "danger" : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loads.map((entry) => {
          const unit = equipById.get(entry.equipmentId)!;
          const name = entry.load ? (custById.get(entry.load.customerId)?.name ?? null) : null;
          return (
            <EquipmentTile key={entry.equipmentId} equipment={unit} entry={entry} customerName={name} onSelect={onSelect} />
          );
        })}
      </div>
    </div>
  );
}
```

`app/(app)/shop-floor/page.tsx` — full replacement:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useWorkOrders, useCustomers, useEquipment, useMaintenance } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ShopFloorGrid } from "@/components/shop-floor/shop-floor-grid";
import { openOrders } from "@/lib/logic/dashboard";
import { DEMO_NOW } from "@/lib/clock";

export default function ShopFloorPage() {
  const router = useRouter();
  const orders = useWorkOrders();
  const customers = useCustomers();
  const equipment = useEquipment();
  const maintenance = useMaintenance();

  if (orders.isLoading || customers.isLoading || equipment.isLoading || maintenance.isLoading) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;
  if (equipment.isError) return <ErrorPanel message="Failed to load equipment." onRetry={() => equipment.refetch()} />;
  if (maintenance.isError) return <ErrorPanel message="Failed to load maintenance." onRetry={() => maintenance.refetch()} />;

  return (
    <div>
      <PageHeader title="Shop Floor" subtitle="Live furnace & oven status — derived from orders in process." />
      <ShopFloorGrid
        orders={openOrders(orders.data ?? [])}
        customers={customers.data ?? []}
        equipment={equipment.data ?? []}
        maintenance={maintenance.data ?? []}
        asOf={DEMO_NOW}
        onSelect={(id) => router.push(`/orders/${id}`)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test && npx tsc --noEmit && npm run lint -- --max-warnings 0` → green.
Note: `tests/e2e/shop-floor.spec.ts` still passes (wash tile still drills to the order; eq-wash-1 is available in seed).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/shop-floor.ts lib/logic/shop-floor.test.ts components/shop-floor app/\(app\)/shop-floor
git commit -m "feat(shop-floor): repo-backed roster, availability precedence, out-of-service + pyrometry KPIs, DEMO_NOW"
```

---

### Task 6: Schedule migration + delete the static EQUIPMENT const

**Files:**
- Modify: `lib/logic/schedule.ts` (drop `EQUIPMENT` import + `EQUIP_BY_ID`; `assignPatch` signature)
- Modify: `lib/query/hooks.ts` (`useAssignSchedule` vars)
- Modify: `components/schedule/schedule-board.tsx`, `components/schedule/assign-dialog.tsx` (equipment prop, filter, chips)
- Modify: `app/(app)/schedule/page.tsx` (`useEquipment` + threading)
- Modify: `lib/domain/enums.ts` (DELETE `EQUIPMENT`, `EquipmentDef`, `EquipmentId`)
- Test: `lib/logic/schedule.test.ts`, `components/schedule/schedule-board.test.tsx`, `components/schedule/assign-dialog.test.tsx`, `tests/schedule-hooks.test.tsx`, `components/schedule/schedule-page.test.tsx` (check — full-provider test should pass unchanged)

**Interfaces:**
- Consumes: `Equipment` type, `useEquipment`, `equipmentAvailabilityMeta`.
- Produces:
  - `assignPatch(order: WorkOrder, equipment: Pick<Equipment, "id" | "name">, day: string, actor: string, at: string): AssignPatch`
  - `useAssignSchedule` vars: `{ order: WorkOrder; equipment: Pick<Equipment, "id" | "name">; day: string; operator: Operator; at: string }`
  - `ScheduleBoard` props gain `equipment: Equipment[]`; `onAssign: (order, equipment: Equipment, day) => void` (move/unassign unchanged)
  - `AssignDialog` props gain `equipment: Equipment[]`; options filtered to `availability === "available"`; `onConfirm(equipmentId, day)` contract unchanged
- After this task `grep -rn "EQUIPMENT\b" app components lib --include="*.ts" --include="*.tsx"` must match only `EQUIPMENT_KINDS`, `EQUIPMENT_STATES`, `EQUIPMENT_AVAILABILITY` (word-boundary grep: `grep -rnE "EQUIPMENT[^_]" app components lib` → no hits).

- [ ] **Step 1: Update tests**

`lib/logic/schedule.test.ts` — the assignPatch test becomes:

```ts
  it("assignPatch sets scheduled + activity and a planned block input", () => {
    const order = wo({ id: "a", activity: [{ actor: "System", message: "Order received", at: "t0" }] });
    const p = assignPatch(order, { id: "eq-iq-2", name: "Batch IQ #2" }, "2026-07-01T00:00:00.000Z", "Dana Mercer", "t1");
    expect(p.workOrder.status).toBe("scheduled");
    expect(p.workOrder.activity.at(-1)).toEqual({ actor: "Dana Mercer", message: "Scheduled — Batch IQ #2 · Wed 7/1", at: "t1" });
    expect(p.block).toEqual({ workOrderId: "a", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned" });
  });
```

`components/schedule/assign-dialog.test.tsx` — pass an `equipment` fixture prop (reuse the `equip()` helper pattern from Task 5; a 3-unit list: eq-iq-1 available, eq-vac-1 available, eq-temper-2 down). Existing selectOptions("eq-vac-1") flows keep working. Add:

```ts
  it("excludes non-available units from the equipment options", () => {
    // render with the 3-unit fixture, eq-temper-2 down
    const select = screen.getByLabelText("Equipment");
    const values = Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["eq-iq-1", "eq-vac-1"]);
  });
```

`components/schedule/schedule-board.test.tsx` — pass `equipment={FIXTURE}` (10-unit `equip()` roster or a smaller list that includes eq-iq-2/eq-vac-1); `onAssign` assertion becomes `expect(onAssign).toHaveBeenCalledWith(receivedWo, expect.objectContaining({ id: "eq-vac-1" }), "2026-06-29T00:00:00.000Z")`. Add a chip test: with eq-temper-2 down in the fixture, its row header shows "Down".

`tests/schedule-hooks.test.tsx` — `assign.mutate({ order, equipmentId: "eq-iq-1", ... })` becomes `assign.mutate({ order, equipment: { id: "eq-iq-1", name: "Batch IQ #1" }, ... })`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/schedule.test.ts components/schedule tests/schedule-hooks.test.tsx`
Expected: FAIL — signature/prop mismatches.

- [ ] **Step 3: Implement**

`lib/logic/schedule.ts`:
- Delete line 2 (`import { EQUIPMENT } ...`) and line 9 (`EQUIP_BY_ID`); add `Equipment` to the type import from `@/lib/domain`.
- `assignPatch` becomes:

```ts
export function assignPatch(order: WorkOrder, equipment: Pick<Equipment, "id" | "name">, day: string, actor: string, at: string): AssignPatch {
  const message = `Scheduled — ${equipment.name} · ${weekDayLabel(day)}`;
  return {
    workOrder: { status: "scheduled", activity: [...order.activity, activityEntry(actor, message, at)] },
    block: { workOrderId: order.id, equipmentId: equipment.id, day, state: "planned" },
  };
}
```

`lib/query/hooks.ts` — `useAssignSchedule` mutationFn:

```ts
    mutationFn: async (vars: { order: WorkOrder; equipment: Pick<Equipment, "id" | "name">; day: string; operator: Operator; at: string }) => {
      const patch = assignPatch(vars.order, vars.equipment, vars.day, vars.operator.name, vars.at);
      // Version-check the WO update FIRST — a stale order throws before any orphan block is created.
      const updated = await r.workOrders.update(vars.order.id, patch.workOrder, vars.order.version);
      await r.scheduleBlocks.create(patch.block);
      return updated;
    },
```

(add `Equipment` to the hooks type import now).

`components/schedule/assign-dialog.tsx`:
- Replace the enums import with `import { equipmentKindMeta } from "@/lib/domain/enums";` + `import type { Equipment } from "@/lib/domain";`
- Both `AssignForm` and `AssignDialog` gain `equipment: Equipment[]` prop (threaded through).
- In `AssignForm`: `const options = equipment.filter((e) => e.availability === "available");`, default `useState(initialEquipmentId ?? options[0]?.id ?? "")`, and the `<option>` map runs over `options`.

`components/schedule/schedule-board.tsx`:
- Replace the enums import with `import { equipmentKindMeta, equipmentAvailabilityMeta } from "@/lib/domain/enums";`; add `Equipment` to the domain type import; add `StatusPill` to the patterns import.
- Props: add `equipment: Equipment[]`; `onAssign: (order: WorkOrder, equipment: Equipment, day: string) => void`.
- Row loop `{EQUIPMENT.map((eq) => (` → `{equipment.map((eq) => (`, and inside the row-header div after the kind label:

```tsx
                  {eq.availability !== "available" && (
                    <div className="mt-1">
                      <StatusPill tone={equipmentAvailabilityMeta[eq.availability].tone}>
                        {equipmentAvailabilityMeta[eq.availability].label}
                      </StatusPill>
                    </div>
                  )}
```

- Both `AssignDialog` usages get `equipment={equipment}`; the assign dialog's `onConfirm` resolves the unit:

```tsx
        onConfirm={(equipmentId, day) => {
          const unit = equipment.find((e) => e.id === equipmentId);
          if (assignFor && unit) { onAssign(assignFor, unit, day); setAssignFor(null); }
        }}
```

(move dialog `onConfirm` unchanged — `movePatch` still takes the raw id.)

`app/(app)/schedule/page.tsx`:
- Add `useEquipment` to the hooks import; `const equipment = useEquipment();`
- Loading guard adds `|| equipment.isLoading`; add error branch `if (equipment.isError) return <ErrorPanel message="Failed to load equipment." onRetry={() => equipment.refetch()} />;`
- Pass `equipment={equipment.data ?? []}` to `ScheduleBoard`; `onAssign={(order, equip, day) => assign.mutate({ order, equipment: equip, day, operator, at: asOf })}`.

`lib/domain/enums.ts` — DELETE the `EQUIPMENT` const, `EquipmentDef`, `EquipmentId` (lines 95–108 in the pre-task file). Verify no remaining consumers:

Run: `grep -rnE "\bEQUIPMENT\b[^_]" app components lib tests --include="*.ts" --include="*.tsx"`
Expected: no hits (only `EQUIPMENT_KINDS` / `EQUIPMENT_STATES` / `EQUIPMENT_AVAILABILITY` remain, which the regex excludes).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test && npx tsc --noEmit && npm run lint -- --max-warnings 0` → green (schedule-page.test.tsx uses full providers and should pass untouched; fix any missed import fallout the compiler finds).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/schedule.ts lib/query/hooks.ts components/schedule app/\(app\)/schedule lib/domain/enums.ts lib/logic/schedule.test.ts tests/schedule-hooks.test.tsx
git commit -m "feat(schedule): availability-aware board + dialogs; delete static EQUIPMENT const"
```

---

### Task 7: Write mutations — availability + mark complete

**Files:**
- Modify: `lib/query/hooks.ts` (two mutations; import `completePatch`; `EquipmentAvailability` type import from enums)
- Test: `tests/equipment-hooks.test.tsx` (create — mirror the harness style of `tests/schedule-hooks.test.tsx`)

**Interfaces:**
- Consumes: `completePatch` (Task 2), repos (Task 3), keys (Task 4).
- Produces:
  - `useSetEquipmentAvailability()` — vars `{ equipment: Equipment; availability: EquipmentAvailability; note: string | null }`
  - `useCompleteMaintenance()` — vars `{ task: Maintenance; at: string }`

- [ ] **Step 1: Write the failing test**

`tests/equipment-hooks.test.tsx` — copy the provider/harness structure from `tests/schedule-hooks.test.tsx` (fresh `createMockRepositories({ latencyMs: 0 })`, QueryClient `retry: false`, probe component or `renderHook` with wrapper — match whatever that file does). Test bodies:

```ts
// 1) availability happy path
const repos = createMockRepositories({ latencyMs: 0 });
const unit = (await repos.equipment.get("eq-iq-1"))!;
await act(() => result.current.setAvailability.mutateAsync({ equipment: unit, availability: "down", note: "Burner fault" }));
const after = (await repos.equipment.get("eq-iq-1"))!;
expect(after.availability).toBe("down");
expect(after.note).toBe("Burner fault");
expect(after.version).toBe(1);

// 2) availability stale version rejects, state unchanged
await expect(
  result.current.setAvailability.mutateAsync({ equipment: { ...unit, version: 99 }, availability: "down", note: "x" }),
).rejects.toThrow("Version conflict");
expect((await repos.equipment.get("eq-iq-1"))!.availability).toBe("available");

// 3) complete rolls the SAT forward from DEMO_NOW
const task = (await repos.maintenance.get("mnt-vac-1-sat"))!;
await act(() => result.current.complete.mutateAsync({ task, at: DEMO_NOW }));
const rolled = (await repos.maintenance.get("mnt-vac-1-sat"))!;
expect(rolled.lastDoneAt).toBe("2026-06-30T00:00:00.000Z");
expect(rolled.nextDueAt).toBe("2026-07-30T00:00:00.000Z");
expect(rolled.version).toBe(1);

// 4) complete stale version rejects, dates unchanged
await expect(result.current.complete.mutateAsync({ task: { ...task, version: 99 }, at: DEMO_NOW })).rejects.toThrow("Version conflict");
expect((await repos.maintenance.get("mnt-vac-1-sat"))!.nextDueAt).toBe("2026-06-30T00:00:00.000Z");
```

(Each scenario in its own `it` with a fresh repo instance — no shared state between tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/equipment-hooks.test.tsx`
Expected: FAIL — `useSetEquipmentAvailability` not exported.

- [ ] **Step 3: Implement**

`lib/query/hooks.ts` — add `import { completePatch } from "@/lib/logic/maintenance";`, add `EquipmentAvailability` to the enums import (alongside `orderStatusMeta`), `Equipment, Maintenance` to the domain type import, then append:

```ts
export function useSetEquipmentAvailability() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { equipment: Equipment; availability: EquipmentAvailability; note: string | null }) =>
      r.equipment.update(vars.equipment.id, { availability: vars.availability, note: vars.note }, vars.equipment.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.equipment }); // prefix covers ["equipment", id] detail
    },
  });
}

export function useCompleteMaintenance() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { task: Maintenance; at: string }) =>
      r.maintenance.update(vars.task.id, completePatch(vars.task, vars.at), vars.task.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.maintenance });
    },
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/equipment-hooks.test.tsx` → PASS. `npm test && npx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add lib/query/hooks.ts tests/equipment-hooks.test.tsx
git commit -m "feat(query): setEquipmentAvailability + completeMaintenance mutations"
```

---

### Task 8: Equipment detail page + tile retarget + shop-floor e2e update

**Files:**
- Create: `components/shop-floor/pyrometry-table.tsx`
- Create: `components/shop-floor/equipment-detail.tsx`
- Create: `app/(app)/shop-floor/[equipmentId]/page.tsx`
- Modify: `components/shop-floor/equipment-tile.tsx` (whole tile → button to equipment detail, both branches)
- Modify: `components/shop-floor/shop-floor-grid.tsx` + `app/(app)/shop-floor/page.tsx` (`onSelect` now receives `equipmentId`)
- Modify: `tests/e2e/shop-floor.spec.ts`
- Test: `components/shop-floor/pyrometry-table.test.tsx`, `components/shop-floor/equipment-detail.test.tsx` (create); update `equipment-tile.test.tsx`, `shop-floor-grid.test.tsx`, `shop-floor-page.test.tsx`

**Interfaces:**
- Consumes: everything above. **Before writing the page: read `node_modules/next/dist/docs/` on dynamic route params (`params` is a Promise unwrapped with React `use()` — mirror `app/(app)/certifications/[id]/page.tsx`).**
- Produces:
  - Route `/shop-floor/[equipmentId]`
  - `EquipmentDetail` props: `{ equipment: Equipment; entry: EquipmentLoad; customerName: string | null; tasks: Maintenance[]; specCodeById: Map<string, string>; asOf: string; canMaintain: boolean; busy: boolean; onSetAvailability: (availability: EquipmentAvailability, note: string | null) => void; onComplete: (task: Maintenance) => void }`
  - `PyrometryTable` props: `{ tasks: Maintenance[]; specCodeById: Map<string, string>; asOf: string; canMaintain: boolean; busy: boolean; onComplete: (task: Maintenance) => void }`
  - Test ids: `equipment-state-pill`, `pyro-row-<taskId>`, `pyro-due-<taskId>`, `pyro-complete-<taskId>`
  - Copy (e2e depends on these exact strings): page buttons "Mark down", "Start maintenance", "Return to service"; dialog confirm labels "Confirm down", "Confirm maintenance", "Confirm return", "Confirm complete"; tile/detail EmptyStates "No load · available" / "Equipment not found" / "No pyrometry schedule"
  - Grid/page `onSelect` now `(equipmentId: string) => void` → `router.push(\`/shop-floor/${equipmentId}\`)`

- [ ] **Step 1: Write failing component tests**

`components/shop-floor/pyrometry-table.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { PyrometryTable } from "./pyrometry-table";
import type { Maintenance } from "@/lib/domain";

const ASOF = "2026-06-30T12:00:00.000Z";
function task(p: Partial<Maintenance> & Pick<Maintenance, "id" | "type" | "nextDueAt">): Maintenance {
  return { createdAt: "", updatedAt: "", version: 0, equipmentId: "eq-vac-1",
    specificationId: "spec-ams2750", intervalDays: 30, lastDoneAt: "2026-05-31T00:00:00.000Z", ...p };
}
const specs = new Map([["spec-ams2750", "AMS 2750"]]);

it("renders type pill, spec code, dates, and a due pill only for due rows", () => {
  const due = task({ id: "m-due", type: "sat", nextDueAt: "2026-06-30T00:00:00.000Z" });
  const future = task({ id: "m-fut", type: "tus", nextDueAt: "2026-08-25T00:00:00.000Z" });
  render(<PyrometryTable tasks={[due, future]} specCodeById={specs} asOf={ASOF} canMaintain busy={false} onComplete={() => {}} />);
  expect(screen.getByTestId("pyro-row-m-due")).toHaveTextContent("SAT");
  expect(screen.getAllByText("AMS 2750").length).toBe(2);
  expect(screen.getByTestId("pyro-due-m-due")).toBeInTheDocument();
  expect(screen.queryByTestId("pyro-due-m-fut")).not.toBeInTheDocument();
});

it("fires onComplete from the row button and hides it without permission", () => {
  const due = task({ id: "m-due", type: "sat", nextDueAt: "2026-06-30T00:00:00.000Z" });
  const onComplete = vi.fn();
  const { rerender } = render(<PyrometryTable tasks={[due]} specCodeById={specs} asOf={ASOF} canMaintain busy={false} onComplete={onComplete} />);
  fireEvent.click(screen.getByTestId("pyro-complete-m-due"));
  expect(onComplete).toHaveBeenCalledWith(due);
  rerender(<PyrometryTable tasks={[due]} specCodeById={specs} asOf={ASOF} canMaintain={false} busy={false} onComplete={onComplete} />);
  expect(screen.queryByTestId("pyro-complete-m-due")).not.toBeInTheDocument();
});

it("shows the empty state when a unit has no schedule", () => {
  render(<PyrometryTable tasks={[]} specCodeById={specs} asOf={ASOF} canMaintain busy={false} onComplete={() => {}} />);
  expect(screen.getByText("No pyrometry schedule")).toBeInTheDocument();
});
```

`components/shop-floor/equipment-detail.test.tsx` (fixtures reuse the `equip()` pattern):

```tsx
// 1) header + state pill + load card with WO link
//    render with available unit + running entry (load WO-1) → getByTestId("equipment-state-pill") has text "Running";
//    screen.getByRole("link", { name: /WO-1/ }) has href "/orders/wo-1".
// 2) availability controls (canMaintain): available unit shows "Mark down" + "Start maintenance";
//    clicking "Mark down", typing a note, clicking "Confirm down" fires onSetAvailability("down", "the note").
// 3) down unit shows its note and "Return to service"; ConfirmDialog "Confirm return" fires onSetAvailability("available", null).
// 4) canMaintain=false hides all three controls.
// 5) idle entry (no load) renders "No load · available" EmptyState in the load card.
```

Write these as real `it()` blocks with `render`/`fireEvent` — the comment lines above are the required scenarios, each one becomes a test with concrete fixtures and assertions.

Update `equipment-tile.test.tsx`: click tests now assert `onSelect` is called with the **equipment id** (`"eq-iq-3"`), and the idle tile IS a button (`getByRole("button")`) firing `onSelect("eq-...")`.
Update `shop-floor-grid.test.tsx`: click assertion → `onSelect` with `"eq-pit-1"` (the loaded unit's id).
Update `shop-floor-page.test.tsx`: no change needed beyond what Task 5 did (grid is mocked).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/shop-floor`
Expected: FAIL — missing modules / behavior.

- [ ] **Step 3: Implement components**

`components/shop-floor/pyrometry-table.tsx`:

```tsx
import { ListCard, StatusPill, EmptyState } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { maintenanceTypeMeta } from "@/lib/domain/enums";
import { isMaintenanceDue } from "@/lib/logic/maintenance";
import { formatDate } from "@/lib/format";   // check the exact date-format helper other tables use (standards-list) and mirror it
import type { Maintenance } from "@/lib/domain";

export function PyrometryTable({ tasks, specCodeById, asOf, canMaintain, busy, onComplete }: {
  tasks: Maintenance[];
  specCodeById: Map<string, string>;
  asOf: string;
  canMaintain: boolean;
  busy: boolean;
  onComplete: (task: Maintenance) => void;
}) {
  if (tasks.length === 0) return <EmptyState title="No pyrometry schedule" />;
  return (
    <ListCard
      headers={["Type", "Spec", "Interval", "Last done", "Next due", ""]}
      rows={tasks.map((t) => [
        <StatusPill key="type" tone="info">{maintenanceTypeMeta[t.type].label}</StatusPill>,
        <span key="spec" className="font-mono text-xs">{specCodeById.get(t.specificationId) ?? t.specificationId}</span>,
        <span key="int" className="font-mono text-xs">{t.intervalDays}d</span>,
        <span key="last" className="font-mono text-xs">{formatDate(t.lastDoneAt)}</span>,
        <span key="due" data-testid={`pyro-row-${t.id}`} className="font-mono text-xs">
          {formatDate(t.nextDueAt)}{" "}
          {isMaintenanceDue(t, asOf) && <StatusPill tone="danger" data-testid={`pyro-due-${t.id}`}>Overdue</StatusPill>}
        </span>,
        canMaintain
          ? <Button key="act" size="sm" variant="outline" disabled={busy} data-testid={`pyro-complete-${t.id}`} onClick={() => onComplete(t)}>Mark complete</Button>
          : <span key="act" />,
      ])}
    />
  );
}
```

**Check `ListCard`, `StatusPill`, and `Button` real prop signatures in `components/patterns/` before writing (e.g. whether StatusPill forwards `data-testid`; if not, wrap in a `<span data-testid=…>`). Check whether a `formatDate` helper exists (standards-list uses one) and import from the same place.** Adjust mechanically; keep the test ids and copy exact. The `pyro-row-<id>` testid may live on the row's first cell if ListCard rows are arrays — put it wherever the test can address the row; keep tests and component consistent.

`components/shop-floor/equipment-detail.tsx` — structure (exact copy strings matter; layout mirrors existing detail components):

```tsx
"use client";
import { useState } from "react";
import Link from "next/link";
import { StatusPill, MonoId, EmptyState, ConfirmDialog } from "@/components/patterns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
import { equipmentStateMeta, equipmentKindMeta, type EquipmentAvailability } from "@/lib/domain/enums";
import { PyrometryTable } from "./pyrometry-table";
import type { Equipment, Maintenance } from "@/lib/domain";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

function NoteForm({ mode, busy, onCancel, onConfirm }: {
  mode: "down" | "maintenance"; busy: boolean; onCancel: () => void; onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "down" ? "Mark down" : "Start maintenance"}</DialogTitle>
        <DialogDescription>Add a note explaining why the unit is out of service.</DialogDescription>
      </DialogHeader>
      <label className="block text-xs">
        <span className="text-text-muted mb-1 block">Note</span>
        <textarea aria-label="Note" className="w-full rounded-lg border border-input bg-transparent p-2 text-sm" rows={3}
          value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button disabled={busy || note.trim() === ""} onClick={() => onConfirm(note.trim())}>
          {mode === "down" ? "Confirm down" : "Confirm maintenance"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function EquipmentDetail({ equipment, entry, customerName, tasks, specCodeById, asOf, canMaintain, busy, onSetAvailability, onComplete }: {
  equipment: Equipment; entry: EquipmentLoad; customerName: string | null;
  tasks: Maintenance[]; specCodeById: Map<string, string>; asOf: string;
  canMaintain: boolean; busy: boolean;
  onSetAvailability: (availability: EquipmentAvailability, note: string | null) => void;
  onComplete: (task: Maintenance) => void;
}) {
  const [noteMode, setNoteMode] = useState<"down" | "maintenance" | null>(null);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState<Maintenance | null>(null);
  const sm = equipmentStateMeta[entry.state];
  const l = entry.load;

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">{equipment.name}</h1>
          <div className="text-text-muted text-xs">{equipmentKindMeta[equipment.kind].label} · <MonoId>{equipment.id}</MonoId></div>
          {equipment.note && <div className="text-text-muted mt-1 text-xs">{equipment.note}</div>}
        </div>
        <span data-testid="equipment-state-pill"><StatusPill tone={sm.tone}>{sm.label}</StatusPill></span>
      </div>

      {/* availability controls */}
      {canMaintain && (
        <div className="flex gap-2">
          {equipment.availability === "available" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setNoteMode("down")}>Mark down</Button>
              <Button variant="outline" disabled={busy} onClick={() => setNoteMode("maintenance")}>Start maintenance</Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setConfirmReturn(true)}>Return to service</Button>
          )}
        </div>
      )}

      {/* current load */}
      <div className="rounded-card border border-border bg-surface p-4">
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Current load</div>
        {l ? (
          <div>
            <div className="flex items-center justify-between">
              <Link href={`/orders/${l.workOrderId}`} className="underline-offset-2 hover:underline"><MonoId>{l.workOrderNumber}</MonoId></Link>
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
              {entry.queued > 0 && <span>+{entry.queued} queued</span>}
            </div>
          </div>
        ) : (
          <EmptyState title="No load · available" />
        )}
      </div>

      {/* pyrometry */}
      <div>
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Pyrometry (AMS 2750)</div>
        <PyrometryTable tasks={tasks} specCodeById={specCodeById} asOf={asOf} canMaintain={canMaintain} busy={busy}
          onComplete={(t) => setConfirmComplete(t)} />
        <p className="text-text-faint mt-2 text-[11px]">TUS — Temperature Uniformity Survey · SAT — System Accuracy Test</p>
      </div>

      <Dialog open={noteMode !== null} onOpenChange={(o) => { if (!o) setNoteMode(null); }}>
        <DialogContent showCloseButton={false}>
          {noteMode && (
            <NoteForm key={noteMode} mode={noteMode} busy={busy} onCancel={() => setNoteMode(null)}
              onConfirm={(note) => { onSetAvailability(noteMode, note); setNoteMode(null); }} />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirmReturn} onOpenChange={setConfirmReturn}
        title="Return to service" description={`${equipment.name} will be marked available.`}
        confirmLabel="Confirm return" onConfirm={() => onSetAvailability("available", null)} />
      <ConfirmDialog open={confirmComplete !== null} onOpenChange={(o) => { if (!o) setConfirmComplete(null); }}
        title="Mark survey complete"
        description={confirmComplete ? `${maintenanceLabel(confirmComplete)} — completion rolls the next due date forward.` : ""}
        confirmLabel="Confirm complete" onConfirm={() => { if (confirmComplete) onComplete(confirmComplete); }} />
    </div>
  );
}
```

with a tiny local helper (top of file, after imports):

```tsx
import { maintenanceTypeMeta } from "@/lib/domain/enums";
function maintenanceLabel(t: Maintenance): string { return maintenanceTypeMeta[t.type].label; }
```

(fold that import into the existing enums import line.)

- [ ] **Step 4: Implement page + retarget tiles**

`components/shop-floor/equipment-tile.tsx` — make BOTH branches a `<button>` calling `onSelect?.(equipment.id)`; prop `onSelect?: (equipmentId: string) => void`. No-load branch becomes:

```tsx
    return (
      <button type="button" data-testid={testId} onClick={() => onSelect?.(equipment.id)}
        className="w-full rounded-card border border-border bg-surface p-4 text-left opacity-60">
        {header}
        {(entry.state === "down" || entry.state === "maintenance") && equipment.note && (
          <div className="text-text-muted mt-3 text-xs">{equipment.note}</div>
        )}
        {entry.state === "idle" && <div className="text-text-muted mt-3 text-xs">No load · available</div>}
      </button>
    );
```

Loaded branch: `onClick={() => onSelect?.(equipment.id)}` (drop the `l.workOrderId` argument). `shop-floor-grid.tsx` prop type: `onSelect?: (equipmentId: string) => void` (pass-through unchanged). `app/(app)/shop-floor/page.tsx`: `onSelect={(id) => router.push(\`/shop-floor/${id}\`)}`.

`app/(app)/shop-floor/[equipmentId]/page.tsx`:

```tsx
"use client";
import { use } from "react";
import { useCan } from "@/lib/auth/provider";
import {
  useEquipment, useEquipmentUnit, useWorkOrders, useCustomers, useMaintenance, useSpecifications,
  useSetEquipmentAvailability, useCompleteMaintenance,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { EquipmentDetail } from "@/components/shop-floor/equipment-detail";
import { equipmentLoads } from "@/lib/logic/shop-floor";
import { maintenanceForEquipment } from "@/lib/logic/maintenance";
import { openOrders } from "@/lib/logic/dashboard";
import { DEMO_NOW } from "@/lib/clock";

export default function EquipmentDetailPage({ params }: { params: Promise<{ equipmentId: string }> }) {
  const { equipmentId } = use(params);
  const canMaintain = useCan("maintain_equipment");
  const unit = useEquipmentUnit(equipmentId);
  const equipment = useEquipment();
  const orders = useWorkOrders();
  const customers = useCustomers();
  const maintenance = useMaintenance();
  const specs = useSpecifications();
  const setAvailability = useSetEquipmentAvailability();
  const complete = useCompleteMaintenance();

  if (unit.isLoading) return <SkeletonRows />;
  if (unit.isError) return <ErrorPanel message="Failed to load equipment." onRetry={() => unit.refetch()} />;
  if (!unit.data) return <EmptyState title="Equipment not found" />;

  if (equipment.isLoading || orders.isLoading || customers.isLoading || maintenance.isLoading || specs.isLoading) return <SkeletonRows />;
  if (equipment.isError || orders.isError || customers.isError || maintenance.isError || specs.isError)
    return <ErrorPanel message="Failed to load equipment context." onRetry={() => { equipment.refetch(); orders.refetch(); customers.refetch(); maintenance.refetch(); specs.refetch(); }} />;

  // Project with the FULL roster (single-unit projection would mis-route heuristic matches), then pick this unit.
  const loads = equipmentLoads(openOrders(orders.data ?? []), equipment.data ?? [], DEMO_NOW);
  const entry = loads.find((l) => l.equipmentId === equipmentId) ?? { equipmentId, state: unit.data.availability === "available" ? "idle" as const : unit.data.availability, load: null, queued: 0 };
  const customerName = entry.load ? ((customers.data ?? []).find((c) => c.id === entry.load!.customerId)?.name ?? null) : null;
  const specCodeById = new Map((specs.data ?? []).map((s) => [s.id, s.code]));
  const busy = setAvailability.isPending || complete.isPending;

  return (
    <EquipmentDetail
      equipment={unit.data}
      entry={entry}
      customerName={customerName}
      tasks={maintenanceForEquipment(maintenance.data ?? [], equipmentId)}
      specCodeById={specCodeById}
      asOf={DEMO_NOW}
      canMaintain={canMaintain}
      busy={busy}
      onSetAvailability={(availability, note) => {
        if (unit.data) setAvailability.mutate({ equipment: unit.data, availability, note });
      }}
      onComplete={(task) => complete.mutate({ task, at: DEMO_NOW })}
    />
  );
}
```

`tests/e2e/shop-floor.spec.ts` — updated flow:

```ts
import { test, expect } from "@playwright/test";

test("shop floor tile drills into equipment detail and through to the order", async ({ page }) => {
  await page.goto("/shop-floor");

  // Seed: WO-48211 (Apex) step 2 "Wash & rack" is in_process → Wash Station is Running.
  const tile = page.getByTestId("equipment-tile-eq-wash-1");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("WO-48211")).toBeVisible();

  await tile.click();
  await expect(page).toHaveURL(/\/shop-floor\/eq-wash-1$/);
  await expect(page.getByTestId("equipment-state-pill")).toHaveText("Running");

  await page.getByRole("link", { name: "WO-48211" }).click();
  await expect(page).toHaveURL(/\/orders\/wo-48211$/);
  await expect(page.getByTestId("order-progress")).toBeVisible();
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test && npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run build` → green; the build must list `/shop-floor/[equipmentId]` as a dynamic route.
Run: `npx playwright test tests/e2e/shop-floor.spec.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add components/shop-floor app/\(app\)/shop-floor tests/e2e/shop-floor.spec.ts
git commit -m "feat(shop-floor): equipment detail page with availability control + pyrometry table; tiles drill to equipment"
```

---

### Task 9: Equipment-maintenance E2E + full gate

**Files:**
- Create: `tests/e2e/equipment-maintenance.spec.ts`
- Verify: whole suite

**Interfaces:**
- Consumes: seed story (eq-vac-1 maintenance + `mnt-vac-1-sat` due today), detail-page copy/test ids from Task 8.

- [ ] **Step 1: Write the E2E spec**

`tests/e2e/equipment-maintenance.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("SAT completed on a maintenance furnace, then returned to service", async ({ page }) => {
  await page.goto("/shop-floor");

  // Seed: eq-vac-1 is in maintenance with its SAT due today (DEMO_NOW boundary).
  await expect(page.getByTestId("shopfloor-summary")).toContainText("Pyrometry due");
  const tile = page.getByTestId("equipment-tile-eq-vac-1");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("Maintenance")).toBeVisible();

  await tile.click();
  await expect(page).toHaveURL(/\/shop-floor\/eq-vac-1$/);
  await expect(page.getByTestId("equipment-state-pill")).toHaveText("Maintenance");
  await expect(page.getByTestId("pyro-due-mnt-vac-1-sat")).toBeVisible();

  // Mark the SAT complete — the due pill clears (nextDueAt rolls +30d past DEMO_NOW).
  await page.getByTestId("pyro-complete-mnt-vac-1-sat").click();
  await page.getByRole("button", { name: "Confirm complete" }).click();
  await expect(page.getByTestId("pyro-due-mnt-vac-1-sat")).toHaveCount(0);

  // Return the furnace to service.
  await page.getByRole("button", { name: "Return to service" }).click();
  await page.getByRole("button", { name: "Confirm return" }).click();
  await expect(page.getByTestId("equipment-state-pill")).toHaveText("Idle");
});
```

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test tests/e2e/equipment-maintenance.spec.ts`
Expected: PASS (auto-login is op-dana, manager → `maintain_equipment` granted).

- [ ] **Step 3: Full gate**

Run, in order, and confirm each is green:

```bash
npm test                          # all vitest files
npx tsc --noEmit
npm run lint -- --max-warnings 0
npm run build                     # /shop-floor static, /shop-floor/[equipmentId] dynamic
npm run test:e2e                  # 7 spec files
```

If any pinned count broke (e.g. dashboard/nav-badge assertions), STOP and check the spec §6: Plan 8 must NOT change WO/quote/cert statuses — fix the regression, don't repin unrelated numbers.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/equipment-maintenance.spec.ts
git commit -m "test(e2e): equipment maintenance happy path — complete SAT, return to service"
```

---

## Post-plan (not tasks — controller workflow)

Whole-branch adversarial review; push branch `heatsynq-equipment-maintenance`; PR to `main` (branch protection requires the green `verify` check); Codex review round; merge; update project memory.

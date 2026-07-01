# HeatSynQ Plan 7 — Certifications & Standards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Quality module — a `/certifications/[id]` detail page with navigable cert↔WO linkage and an honest "blocking N shipments" dashboard framing, plus the `/standards` library screen (retiring its placeholder) backed by a new read-only `Standard` entity.

**Architecture:** Read-mostly slice. `Standard` is a seeded `ReadRepo` entity (the Specification pattern — no writes, no numbering). The only mutation anywhere is the *existing* `useReleaseCertification` reused on the new detail page. Everything new on screen is derived at read: "review overdue" from `nextReviewAt` vs a page-passed `asOf` (`DEMO_NOW`), "blocking shipments" from a pure join of pending certs × `ready_to_ship` orders. `certificationSchema` is untouched.

**Tech Stack:** Next 16 (App Router, `use(params)`), TypeScript, Zod, TanStack Query, Tailwind (project tokens), Vitest + RTL, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-01-heatsynq-certifications-standards-design.md` (approved).

## Global Constraints

- UI depends only on async repository interfaces via TanStack Query hooks — no component touches the mock directly.
- Dates are ISO strings, midnight-UTC for date-only fields (`reviewedAt`/`nextReviewAt` follow the `due` precedent). Money = integer cents (untouched this plan).
- IBM Plex Mono for ids/numbers/pills: use `MonoId` / `font-mono` / `StatusPill` from `components/patterns`.
- NO new `any` (the only two approved `any`s live in `lib/data/mock/repositories.ts` plumbing). NO new `eslint-disable`.
- Optimistic-concurrency `version` on every update (the reused cert release already passes it).
- Permissions via authenticated `operator.role` / `useCan("release_cert")` — never `viewAs`.
- Pure logic never calls `Date.now()` — callers pass `asOf`. The demo clock is `DEMO_NOW` from `lib/clock.ts` (`"2026-06-30T12:00:00.000Z"`).
- **AGENTS.md rule:** this repo's Next.js has breaking changes — read the relevant guide in `node_modules/next/dist/docs/` before writing any Next-specific code (routes, `use(params)`, `next/link`).
- Gate that must stay green: `npm test` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `npm run build` · `npm run test:e2e`.
- Run all commands from the repo root `/home/cojoa13/Desktop/HeatSynQ`. Work on branch `heatsynq-certifications-standards`.

## File Structure

**Create:**
- `lib/logic/standards.ts` + `lib/logic/standards.test.ts` — `isReviewDue` pure fn (+ schema fixture tests)
- `components/standards/standards-list.tsx` + `.test.tsx` — Standards table
- `components/certifications/certification-detail.tsx` + `.test.tsx` — cert detail presentation
- `app/(app)/standards/standards-page.test.tsx` — page guard tests
- `app/(app)/certifications/[id]/page.tsx` + `certification-detail-page.test.tsx` — detail route
- `tests/e2e/certifications.spec.ts` — E2E happy path

**Modify:**
- `lib/domain/enums.ts` — `STANDARD_CATEGORIES`, `StandardCategory`, `standardCategoryMeta` (append at end)
- `lib/domain/entities.ts` — `standardSchema`, `Standard` (append at end)
- `lib/data/repositories/index.ts` — `standards: ReadRepo<Standard>`
- `lib/data/mock/repositories.ts` — `standards` collection + wiring
- `lib/data/seed/index.ts` — 4 standards rows; `cert-9910` status flip
- `lib/data/seed/seed.test.ts` — standards validation + story invariants
- `lib/logic/dashboard.ts` + `dashboard.test.ts` — `certsBlockingShipments` + computed KPI sub
- `tests/nav-badges.test.tsx` — `c2 → c3`
- `lib/query/keys.ts` — `standards`, `certification(id)` keys
- `lib/query/hooks.ts` — `useStandards`, `useCertification`
- `app/(app)/standards/page.tsx` — placeholder → real screen
- `app/(app)/certifications/page.tsx` — row-click navigation
- `components/certifications/certifications-list.tsx` + `.test.tsx` — `onSelect` + `stopPropagation`
- `components/orders/order-detail.tsx` + `.test.tsx` — cert number → link

---

### Task 1: `Standard` domain entity + `isReviewDue` pure logic

**Files:**
- Modify: `lib/domain/enums.ts` (append after `scheduleBlockStateMeta`, ~line 123)
- Modify: `lib/domain/entities.ts` (append after `scheduleBlockSchema`, ~line 227; extend the enums import at the top)
- Create: `lib/logic/standards.ts`
- Test: `lib/logic/standards.test.ts`

**Interfaces:**
- Consumes: `baseEntitySchema` (`lib/domain/base.ts`), `Meta<T>` alias (`lib/domain/enums.ts:28`, file-internal).
- Produces: `STANDARD_CATEGORIES: readonly ["quality","process"]`, `type StandardCategory`, `standardCategoryMeta: Meta<StandardCategory>`, `standardSchema` (zod), `type Standard` (all re-exported via the `@/lib/domain` barrel automatically — `lib/domain/index.ts` does `export *`), and `isReviewDue(standard: Standard, asOf: string): boolean` from `@/lib/logic/standards`.

- [ ] **Step 1: Write the failing test**

Create `lib/logic/standards.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { standardSchema, type Standard } from "@/lib/domain";
import { isReviewDue } from "./standards";

const base = { id: "std-x", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0 };
const std = (over: Partial<Standard> = {}): Standard =>
  standardSchema.parse({
    ...base, code: "AS9100D", title: "Aerospace quality management system", category: "quality",
    reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z", ...over,
  });

describe("standardSchema", () => {
  it("parses a valid standard", () => {
    expect(std().category).toBe("quality");
    expect(std({ category: "process" }).category).toBe("process");
  });
  it("rejects an unknown category", () => {
    expect(() => std({ category: "safety" as Standard["category"] })).toThrow();
  });
});

describe("isReviewDue", () => {
  const asOf = "2026-06-30T12:00:00.000Z"; // DEMO_NOW
  it("is false when nextReviewAt is after asOf", () => {
    expect(isReviewDue(std({ nextReviewAt: "2026-07-01T00:00:00.000Z" }), asOf)).toBe(false);
  });
  it("is true when nextReviewAt is before asOf", () => {
    expect(isReviewDue(std({ nextReviewAt: "2026-06-15T00:00:00.000Z" }), asOf)).toBe(true);
  });
  it("is true on the exact boundary (due at asOf counts as due)", () => {
    expect(isReviewDue(std({ nextReviewAt: asOf }), asOf)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/logic/standards.test.ts`
Expected: FAIL — `standardSchema` is not exported from `@/lib/domain` / cannot resolve `./standards`.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/domain/enums.ts` (end of file, after `scheduleBlockStateMeta`):

```ts
export const STANDARD_CATEGORIES = ["quality","process"] as const;
export type StandardCategory = (typeof STANDARD_CATEGORIES)[number];
export const standardCategoryMeta: Meta<StandardCategory> = {
  quality: { label: "Quality", tone: "neutral" },
  process: { label: "Process", tone: "neutral" },
};
```

In `lib/domain/entities.ts`, add `STANDARD_CATEGORIES` to the existing `from "./enums"` import list, then append at end of file:

```ts
export const standardSchema = baseEntitySchema.extend({
  code: z.string(),                 // "AS9100D" — display id (Specification `code` precedent)
  title: z.string(),
  category: z.enum(STANDARD_CATEGORIES),
  reviewedAt: z.string(),           // ISO midnight-UTC — last internal review
  nextReviewAt: z.string(),         // ISO midnight-UTC — next review due
});
export type Standard = z.infer<typeof standardSchema>;
```

Create `lib/logic/standards.ts`:

```ts
import type { Standard } from "@/lib/domain";

/** Review is due on or before `asOf` — the boundary instant counts as due. */
export function isReviewDue(standard: Standard, asOf: string): boolean {
  return new Date(standard.nextReviewAt).getTime() <= new Date(asOf).getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/logic/standards.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Type/lint check + commit**

Run: `npx tsc --noEmit && npx eslint lib/domain lib/logic --max-warnings 0`
Expected: clean.

```bash
git add lib/domain/enums.ts lib/domain/entities.ts lib/logic/standards.ts lib/logic/standards.test.ts
git commit -m "feat: Standard domain entity + isReviewDue pure logic"
```

---

### Task 2: `standards` repository + seed rows

**Files:**
- Modify: `lib/data/repositories/index.ts` (import + `Repositories` map)
- Modify: `lib/data/mock/repositories.ts` (`cols` + return map)
- Modify: `lib/data/seed/index.ts` (import, array after `specifications` ~line 59, return block ~line 899)
- Test: `lib/data/seed/seed.test.ts`

**Interfaces:**
- Consumes: `Standard` / `standardSchema` (Task 1), `isReviewDue` (Task 1), `ReadRepo<T>`, `Collection`, `DEMO_NOW` from `@/lib/clock`.
- Produces: `Repositories.standards: ReadRepo<Standard>`; `buildSeed().standards: Standard[]` (4 rows, ids `std-as9100d`, `std-iso9001`, `std-nadcap-ht`, `std-cqi9`; exactly `std-cqi9` is review-overdue vs `DEMO_NOW`).

- [ ] **Step 1: Write the failing tests**

In `lib/data/seed/seed.test.ts`: add `standardSchema` to the `@/lib/domain` import list, and add these imports below it:

```ts
import { isReviewDue } from "@/lib/logic/standards";
import { DEMO_NOW } from "@/lib/clock";
```

Inside the `"validates every array against its schema"` test, add one line after the `specifications` line:

```ts
    s.standards.forEach((r) => expect(() => standardSchema.parse(r)).not.toThrow());
```

Add a new test inside `describe("seed", ...)`:

```ts
  it("seeds the standards library with exactly one review-overdue row", () => {
    expect(s.standards).toHaveLength(4);
    expect(s.standards.filter((st) => isReviewDue(st, DEMO_NOW)).map((st) => st.code)).toEqual(["CQI-9"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/data/seed/seed.test.ts`
Expected: FAIL — `s.standards` is undefined (TypeScript will also flag it; that's the failure).

- [ ] **Step 3: Write minimal implementation**

`lib/data/seed/index.ts` — add `Standard` to the type import list at the top. After the `specifications` array (ends ~line 59), insert:

```ts
  const standards: Standard[] = [
    { ...meta, id: "std-as9100d", code: "AS9100D", title: "Aerospace quality management system", category: "quality", reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z" },
    { ...meta, id: "std-iso9001", code: "ISO 9001", title: "Quality management systems", category: "quality", reviewedAt: "2026-02-01T00:00:00.000Z", nextReviewAt: "2027-02-01T00:00:00.000Z" },
    { ...meta, id: "std-nadcap-ht", code: "Nadcap HT", title: "Heat treating special-process accreditation", category: "process", reviewedAt: "2026-03-10T00:00:00.000Z", nextReviewAt: "2026-09-10T00:00:00.000Z" },
    { ...meta, id: "std-cqi9", code: "CQI-9", title: "AIAG heat-treat system assessment", category: "process", reviewedAt: "2025-06-15T00:00:00.000Z", nextReviewAt: "2026-06-15T00:00:00.000Z" },
  ];
```

Add `standards,` to the `return { ... }` block (after `specifications,`).

`lib/data/repositories/index.ts` — add `Standard` to the type import; in `Repositories`, after the `specifications` line add:

```ts
  standards: ReadRepo<Standard>;
```

`lib/data/mock/repositories.ts` — in `cols`, after `specifications`: `standards: new Collection(seed.standards),`; in the return map, after `specifications: read(cols.specifications),`:

```ts
    standards: read(cols.standards),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/data/seed/seed.test.ts`
Expected: PASS (all seed tests, including the new one).

- [ ] **Step 5: Type/lint check + commit**

Run: `npx tsc --noEmit && npx eslint lib/data --max-warnings 0`
Expected: clean.

```bash
git add lib/data/repositories/index.ts lib/data/mock/repositories.ts lib/data/seed/index.ts lib/data/seed/seed.test.ts
git commit -m "feat: standards ReadRepo + seeded standards library (one review-overdue)"
```

---

### Task 3: `certsBlockingShipments` + computed KPI sub + C-9910 seed flip

**Files:**
- Modify: `lib/logic/dashboard.ts` (new fn in the `--- certs ---` section ~line 44; manager tile ~line 104)
- Modify: `lib/data/seed/index.ts:882` (cert-9910 status)
- Test: `lib/logic/dashboard.test.ts`, `tests/nav-badges.test.tsx`, `lib/data/seed/seed.test.ts`

**Interfaces:**
- Consumes: seed shape (`cert-9910`/`C-9910` → `wo-48120` `ready_to_ship`, process master `pm-nh15`).
- Produces: `certsBlockingShipments(certs: Certification[], orders: WorkOrder[]): number` exported from `@/lib/logic/dashboard`; manager KPI tile `{ label: "Certs Awaiting Release", value: "3", sub: "blocking 1 shipment" }` on seed data. Seed invariant: `C-9910` is `pending` and its WO is `ready_to_ship`.

- [ ] **Step 1: Write the failing tests**

`lib/logic/dashboard.test.ts` — add `certsBlockingShipments` to the `./dashboard` import list. Update the pinned counts (the seed flip makes pending certs 2 → 3):
- In `"computes AR, to-bill, invoiced MTD and pending certs"`: `expect(certsAwaitingRelease(s.certifications)).toBe(3);`
- In `"manager tiles"`: `expect(t["Certs Awaiting Release"]).toBe("3");`
- In `"computes live sidebar counts"`: `certifications: 3,`

Add a new describe block at the end of the file:

```ts
describe("certsBlockingShipments", () => {
  it("counts only pending certs whose order is ready_to_ship (seed: C-9910/WO-48120)", () => {
    expect(certsBlockingShipments(s.certifications, s.workOrders)).toBe(1);
  });
  it("ignores pending certs on non-ready orders, released certs, and orphans", () => {
    const wo = s.workOrders.find((w) => w.id === "wo-48120")!;
    const cert = s.certifications.find((c) => c.number === "C-9910")!;
    expect(certsBlockingShipments([{ ...cert, status: "released" }], [wo])).toBe(0);
    expect(certsBlockingShipments([cert], [{ ...wo, status: "in_process" }])).toBe(0);
    expect(certsBlockingShipments([{ ...cert, workOrderId: "wo-nope" }], [wo])).toBe(0);
  });
  it("feeds the manager tile sub with pluralization", () => {
    const data = { orders: s.workOrders, quotes: s.quotes, invoices: s.invoices, certifications: s.certifications, customers: s.customers };
    const tile = dashboardKpis("manager", data, "2026-06-30T12:00:00.000Z").find((t) => t.label === "Certs Awaiting Release")!;
    expect(tile.sub).toBe("blocking 1 shipment");
    const noneBlocking = { ...data, certifications: data.certifications.map((c) => ({ ...c, status: "released" as const })) };
    const tile0 = dashboardKpis("manager", noneBlocking, "2026-06-30T12:00:00.000Z").find((t) => t.label === "Certs Awaiting Release")!;
    expect(tile0.sub).toBe("blocking 0 shipments");
  });
});
```

`tests/nav-badges.test.tsx` — change the expectation: `expect(await screen.findByText("q3-o9-c3")).toBeInTheDocument();`

`lib/data/seed/seed.test.ts` — add a new test inside `describe("seed", ...)`:

```ts
  it("has a ready-to-ship order blocked by a pending cert (manual-release story)", () => {
    const cert = s.certifications.find((c) => c.number === "C-9910")!;
    expect(cert.status).toBe("pending");
    const wo = s.workOrders.find((w) => w.id === cert.workOrderId)!;
    expect(wo.status).toBe("ready_to_ship");
    // Coherence with Plan-4 auto-release: this WO's process has NO inspect step,
    // so a pending cert on a done-steps order is exactly the manual-release case.
    const pm = s.processMasters.find((m) => m.id === wo.processMasterId)!;
    expect(pm.steps.some((st) => st.track === "inspect")).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/dashboard.test.ts tests/nav-badges.test.tsx lib/data/seed/seed.test.ts`
Expected: FAIL — `certsBlockingShipments` not exported; counts still 2; C-9910 still released.

- [ ] **Step 3: Write minimal implementation**

`lib/data/seed/index.ts:882` — change `cert-9910`'s `status: "released"` to `status: "pending"` (only that field, only that row).

`lib/logic/dashboard.ts` — in the `// --- certs ---` section, after `certsAwaitingRelease`:

```ts
export function certsBlockingShipments(certs: Certification[], orders: WorkOrder[]): number {
  const readyToShip = new Set(orders.filter((o) => o.status === "ready_to_ship").map((o) => o.id));
  return certs.filter((c) => c.status === "pending" && readyToShip.has(c.workOrderId)).length;
}
```

In `dashboardKpis`, in the manager branch (before the `return`), add:

```ts
  const blocking = certsBlockingShipments(certifications, orders);
```

and replace the cert tile line with:

```ts
    { label: "Certs Awaiting Release", value: String(certsAwaitingRelease(certifications)), sub: `blocking ${blocking} shipment${blocking === 1 ? "" : "s"}` },
```

- [ ] **Step 4: Run the full unit suite to verify pass + no unexpected fallout**

Run: `npx vitest run`
Expected: PASS across the board. If any other test still pins the old counts (pending certs = 2 / `c2`), fix that expectation to the new seed truth — do NOT weaken assertions.

- [ ] **Step 5: Type/lint check + commit**

Run: `npx tsc --noEmit && npx eslint . --max-warnings 0`
Expected: clean.

```bash
git add lib/logic/dashboard.ts lib/logic/dashboard.test.ts lib/data/seed/index.ts lib/data/seed/seed.test.ts tests/nav-badges.test.tsx
git commit -m "feat: computed 'blocking N shipments' dashboard framing + C-9910 pending seed story"
```

---

### Task 4: `/standards` screen (hook + list + page, placeholder retired)

**Files:**
- Modify: `lib/query/keys.ts` (add `standards` key)
- Modify: `lib/query/hooks.ts` (add `useStandards` next to `useSpecifications`, ~line 20)
- Create: `components/standards/standards-list.tsx`
- Modify: `app/(app)/standards/page.tsx` (replace `PlaceholderPage` entirely)
- Test: `components/standards/standards-list.test.tsx`, `app/(app)/standards/standards-page.test.tsx`

**Interfaces:**
- Consumes: `Standard`, `standardCategoryMeta`, `isReviewDue`, `DEMO_NOW`, `Repositories.standards.list()`, patterns `ListCard/MonoId/StatusPill/PageHeader/SkeletonRows/ErrorPanel/EmptyState`, `formatDate` from `@/lib/utils`.
- Produces: `useStandards()` (query key `["standards"]`); `StandardsList({ standards: Standard[]; asOf: string })`.

- [ ] **Step 1: Write the failing component test**

Create `components/standards/standards-list.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StandardsList } from "./standards-list";
import type { Standard } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const asOf = "2026-06-30T12:00:00.000Z";
const standards: Standard[] = [
  { ...base, id: "std-as9100d", code: "AS9100D", title: "Aerospace quality management system", category: "quality", reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z" },
  { ...base, id: "std-cqi9", code: "CQI-9", title: "AIAG heat-treat system assessment", category: "process", reviewedAt: "2025-06-15T00:00:00.000Z", nextReviewAt: "2026-06-15T00:00:00.000Z" },
];

describe("StandardsList", () => {
  it("renders code, title, category pill, and review dates", () => {
    render(<StandardsList standards={standards} asOf={asOf} />);
    expect(screen.getByText("AS9100D")).toBeInTheDocument();
    expect(screen.getByText("Aerospace quality management system")).toBeInTheDocument();
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText("Process")).toBeInTheDocument();
    expect(screen.getByText("Nov 15, 2026")).toBeInTheDocument(); // formatDate(nextReviewAt), UTC
  });
  it("flags only the overdue row", () => {
    render(<StandardsList standards={standards} asOf={asOf} />);
    const overdue = screen.getAllByText("Overdue");
    expect(overdue).toHaveLength(1);
    // The overdue pill sits in the CQI-9 row
    expect(overdue[0].closest("tr")).toHaveTextContent("CQI-9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/standards/standards-list.test.tsx`
Expected: FAIL — cannot resolve `./standards-list`.

- [ ] **Step 3: Implement the list component**

Create `components/standards/standards-list.tsx`:

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { standardCategoryMeta } from "@/lib/domain/enums";
import { isReviewDue } from "@/lib/logic/standards";
import { formatDate } from "@/lib/utils";
import type { Standard } from "@/lib/domain";

export function StandardsList({ standards, asOf }: { standards: Standard[]; asOf: string }) {
  return (
    <ListCard
      headers={["STANDARD", "TITLE", "CATEGORY", "REVIEWED", "NEXT REVIEW"]}
      rows={standards.map((s) => {
        const cat = standardCategoryMeta[s.category];
        return [
          <MonoId key="code">{s.code}</MonoId>,
          s.title,
          <StatusPill key="cat" tone={cat.tone}>{cat.label}</StatusPill>,
          <span key="rev" className="font-mono">{formatDate(s.reviewedAt)}</span>,
          <span key="next" className="flex items-center gap-2 font-mono">
            {formatDate(s.nextReviewAt)}
            {isReviewDue(s, asOf) && <StatusPill tone="danger">Overdue</StatusPill>}
          </span>,
        ];
      })}
    />
  );
}
```

Run: `npx vitest run components/standards/standards-list.test.tsx` → PASS.

- [ ] **Step 4: Write the failing page test**

Create `app/(app)/standards/standards-page.test.tsx` (mirrors `app/(app)/shop-floor/shop-floor-page.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StandardsPage from "./page";

const mockStandards = vi.fn();
vi.mock("@/lib/query/hooks", () => ({ useStandards: () => mockStandards() }));
vi.mock("@/components/standards/standards-list", () => ({
  StandardsList: () => <div data-testid="standards-list" />,
}));

beforeEach(() => {
  mockStandards.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("StandardsPage guards", () => {
  it("renders skeleton while loading", () => {
    mockStandards.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<StandardsPage />);
    expect(screen.queryByTestId("standards-list")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockStandards.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<StandardsPage />);
    expect(screen.getByText("Failed to load standards.")).toBeInTheDocument();
  });
  it("renders EmptyState when no rows", () => {
    render(<StandardsPage />);
    expect(screen.getByText("No standards")).toBeInTheDocument();
  });
  it("renders the list with data", () => {
    mockStandards.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ id: "std-as9100d", createdAt: "", updatedAt: "", version: 0, code: "AS9100D", title: "Aerospace quality management system", category: "quality", reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z" }],
    });
    render(<StandardsPage />);
    expect(screen.getByTestId("standards-list")).toBeInTheDocument();
    expect(screen.getByText("Standards")).toBeInTheDocument();
  });
});
```

Run: `npx vitest run "app/(app)/standards/standards-page.test.tsx"`
Expected: FAIL — page still renders the `PlaceholderPage` ("Coming in a later phase") and `useStandards` doesn't exist.

- [ ] **Step 5: Implement hook, key, and page**

`lib/query/keys.ts` — add after `specifications`:

```ts
  standards: ["standards"] as const,
```

`lib/query/hooks.ts` — add directly after the `useSpecifications` line (~line 20):

```ts
export function useStandards() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.standards, queryFn: () => r.standards.list() }); }
```

Replace `app/(app)/standards/page.tsx` entirely:

```tsx
"use client";
import { useStandards } from "@/lib/query/hooks";
import { DEMO_NOW } from "@/lib/clock";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { StandardsList } from "@/components/standards/standards-list";

export default function StandardsPage() {
  const { data, isLoading, isError, refetch } = useStandards();
  return (
    <div>
      <PageHeader title="Standards" subtitle="Quality & process standards library." />
      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorPanel message="Failed to load standards." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No standards" description="No standards on file yet." />
      ) : (
        <StandardsList standards={data} asOf={DEMO_NOW} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run components/standards "app/(app)/standards/standards-page.test.tsx"`
Expected: PASS.

- [ ] **Step 7: Type/lint check + commit**

Run: `npx tsc --noEmit && npx eslint . --max-warnings 0`
Expected: clean.

```bash
git add lib/query/keys.ts lib/query/hooks.ts components/standards app/\(app\)/standards
git commit -m "feat: /standards library screen (useStandards + StandardsList), placeholder retired"
```

---

### Task 5: `/certifications/[id]` detail page

**Files:**
- Modify: `lib/query/keys.ts` (add `certification(id)` key)
- Modify: `lib/query/hooks.ts` (add `useCertification` next to `useCertifications`, ~line 26)
- Create: `components/certifications/certification-detail.tsx`
- Create: `app/(app)/certifications/[id]/page.tsx`
- Test: `components/certifications/certification-detail.test.tsx`, `app/(app)/certifications/[id]/certification-detail-page.test.tsx`

**Interfaces:**
- Consumes: `useCertifications`-style hook plumbing, existing `useReleaseCertification` (`mutate({ id, version })` — release invalidates `["certifications"]`, which prefix-invalidates the new `["certifications", id]` key: no hook changes), `useWorkOrder(id)`, `useCustomer(id)`, `useSpecifications()`, `useCan("release_cert")`, patterns `DetailHeader/SummaryRail/StatusPill/MonoId/SkeletonRows/ErrorPanel/EmptyState`, `certStatusMeta`/`orderStatusMeta`, `formatDate`.
- Produces: `useCertification(id: string)` (key `["certifications", id]`, fn `r.certifications.get(id)` → `Certification | null`); `CertificationDetail({ cert: Certification; workOrder: WorkOrder | null; customer: Customer | null; specification: Specification | null; canRelease: boolean; busy: boolean; onRelease: () => void })`; route `/certifications/[id]`. Task 6 links to `/certifications/${cert.id}`.

- [ ] **Step 1: Write the failing component test**

Create `components/certifications/certification-detail.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CertificationDetail } from "./certification-detail";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

const base = { createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0 };
const pendingCert: Certification = { ...base, id: "cert-9910", number: "C-9910", customerId: "cust-summit", workOrderId: "wo-48120", specificationId: "spec-sb4", type: "Customer spec SB-4", status: "pending", copies: 1 };
const releasedCert: Certification = { ...pendingCert, status: "released" };
const readyWo = { ...base, id: "wo-48120", number: "WO-48120", status: "ready_to_ship", due: "2026-06-26T00:00:00.000Z", processSummary: "Neutral harden" } as unknown as WorkOrder;
const inProcessWo = { ...readyWo, status: "in_process" } as WorkOrder;
const customer = { ...base, id: "cust-summit", name: "Summit Bearing" } as unknown as Customer;
const spec = { ...base, id: "spec-sb4", code: "SB-4", rev: "2" } as unknown as Specification;

const renderDetail = (over: Partial<Parameters<typeof CertificationDetail>[0]> = {}) =>
  render(<CertificationDetail cert={pendingCert} workOrder={readyWo} customer={customer} specification={spec}
    canRelease busy={false} onRelease={vi.fn()} {...over} />);

describe("CertificationDetail", () => {
  it("renders cert fields, spec, and customer link", () => {
    renderDetail();
    expect(screen.getByText("C-9910")).toBeInTheDocument();
    expect(screen.getByText("SB-4 rev 2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Summit Bearing" })).toHaveAttribute("href", "/customers/cust-summit");
  });
  it("links to the work order and shows its status", () => {
    renderDetail();
    expect(screen.getByRole("link", { name: "WO-48120" })).toHaveAttribute("href", "/orders/wo-48120");
    expect(screen.getByText("Ready to ship")).toBeInTheDocument();
  });
  it("shows the blocking note only when pending + ready_to_ship", () => {
    renderDetail();
    expect(screen.getByText("This cert blocks shipment of WO-48120.")).toBeInTheDocument();
  });
  it("hides the blocking note when the order is not ready_to_ship", () => {
    renderDetail({ workOrder: inProcessWo });
    expect(screen.queryByText(/blocks shipment/)).not.toBeInTheDocument();
  });
  it("fires onRelease from the header action", async () => {
    const onRelease = vi.fn();
    renderDetail({ onRelease });
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
  it("hides Release when released or when the user cannot release", () => {
    renderDetail({ cert: releasedCert });
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    renderDetail({ canRelease: false });
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });
  it("renders a fallback when the work order is missing", () => {
    renderDetail({ workOrder: null });
    expect(screen.getByText("Work order not found.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/certifications/certification-detail.test.tsx`
Expected: FAIL — cannot resolve `./certification-detail`.

- [ ] **Step 3: Implement the detail component**

Create `components/certifications/certification-detail.tsx`:

```tsx
import Link from "next/link";
import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { certStatusMeta, orderStatusMeta } from "@/lib/domain/enums";
import { formatDate } from "@/lib/utils";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

export function CertificationDetail({
  cert, workOrder, customer, specification, canRelease, busy, onRelease,
}: {
  cert: Certification; workOrder: WorkOrder | null; customer: Customer | null;
  specification: Specification | null; canRelease: boolean; busy: boolean; onRelease: () => void;
}) {
  const meta = certStatusMeta[cert.status];
  const blocking = cert.status === "pending" && workOrder?.status === "ready_to_ship";
  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/certifications" backLabel="Certifications" title={<MonoId>{cert.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · ${cert.type}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>}
          actions={cert.status === "pending" && canRelease
            ? <Button size="sm" disabled={busy} onClick={onRelease}>Release</Button>
            : undefined} />

        {blocking && workOrder && (
          <p className="mb-4 rounded-card border border-status-warn-tint bg-status-warn-tint px-3 py-2 text-xs text-status-warn">
            This cert blocks shipment of {workOrder.number}.
          </p>
        )}

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Certification</div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between"><dt className="text-text-muted">Type</dt><dd>{cert.type}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Specification</dt>
              <dd className="font-mono">{specification ? `${specification.code} rev ${specification.rev}` : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Copies</dt><dd className="font-mono">{cert.copies}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Created</dt><dd className="font-mono">{formatDate(cert.createdAt)}</dd></div>
          </dl>
        </div>

        <div className="rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Work order</div>
          {workOrder ? (
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between"><dt className="text-text-muted">Order</dt>
                <dd><Link href={`/orders/${workOrder.id}`} className="text-primary"><MonoId>{workOrder.number}</MonoId></Link></dd></div>
              <div className="flex justify-between"><dt className="text-text-muted">Status</dt>
                <dd><StatusPill tone={orderStatusMeta[workOrder.status].tone}>{orderStatusMeta[workOrder.status].label}</StatusPill></dd></div>
              <div className="flex justify-between"><dt className="text-text-muted">Due</dt><dd className="font-mono">{formatDate(workOrder.due)}</dd></div>
              <div className="flex justify-between"><dt className="text-text-muted">Process</dt><dd>{workOrder.processSummary}</dd></div>
            </dl>
          ) : <p className="text-text-muted text-xs">Work order not found.</p>}
        </div>
      </div>

      <SummaryRail title="Certification">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Customer</dt>
            <dd>{customer ? <Link href={`/customers/${customer.id}`} className="text-primary">{customer.name}</Link> : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Status</dt>
            <dd><StatusPill tone={meta.tone}>{meta.label}</StatusPill></dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Copies</dt><dd className="font-mono">{cert.copies}</dd></div>
        </dl>
      </SummaryRail>
    </div>
  );
}
```

Run: `npx vitest run components/certifications/certification-detail.test.tsx` → PASS.

- [ ] **Step 4: Write the failing page test**

Create `app/(app)/certifications/[id]/certification-detail-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CertificationDetailPage from "./page";

const mockCert = vi.fn();
const mockWorkOrder = vi.fn();
const mockCustomer = vi.fn();
const mockSpecs = vi.fn();
const mockRelease = vi.fn();

vi.mock("@/lib/auth/provider", () => ({ useCan: () => true }));
vi.mock("@/lib/query/hooks", () => ({
  useCertification: () => mockCert(),
  useWorkOrder: () => mockWorkOrder(),
  useCustomer: () => mockCustomer(),
  useSpecifications: () => mockSpecs(),
  useReleaseCertification: () => ({ mutate: mockRelease, isPending: false }),
}));
vi.mock("@/components/certifications/certification-detail", () => ({
  CertificationDetail: (props: { onRelease: () => void }) => (
    <button data-testid="cert-detail" onClick={props.onRelease}>detail</button>
  ),
}));

const cert = { id: "cert-9910", createdAt: "", updatedAt: "", version: 4, number: "C-9910", customerId: "cust-summit", workOrderId: "wo-48120", specificationId: "spec-sb4", type: "Customer spec SB-4", status: "pending", copies: 1 };
const ok = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });
const params = Promise.resolve({ id: "cert-9910" });

beforeEach(() => {
  mockRelease.mockReset();
  mockCert.mockReturnValue(ok(cert));
  mockWorkOrder.mockReturnValue(ok(null));
  mockCustomer.mockReturnValue(ok(null));
  mockSpecs.mockReturnValue(ok([]));
});

describe("CertificationDetailPage", () => {
  it("renders skeleton while the cert loads", () => {
    mockCert.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.queryByTestId("cert-detail")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel when the cert errors", () => {
    mockCert.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.getByText("Failed to load certification.")).toBeInTheDocument();
  });
  it("renders not-found for an unknown id", () => {
    mockCert.mockReturnValue(ok(null));
    render(<CertificationDetailPage params={params} />);
    expect(screen.getByText("Certification not found")).toBeInTheDocument();
  });
  it("holds the skeleton while context queries load (no premature action render)", () => {
    mockWorkOrder.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.queryByTestId("cert-detail")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel when a context query errors", () => {
    mockCustomer.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.getByText("Failed to load certification context.")).toBeInTheDocument();
  });
  it("wires onRelease to release.mutate with id + version", async () => {
    render(<CertificationDetailPage params={params} />);
    (await screen.findByTestId("cert-detail")).click();
    expect(mockRelease).toHaveBeenCalledWith({ id: "cert-9910", version: 4 });
  });
});
```

Run: `npx vitest run "app/(app)/certifications/[id]/certification-detail-page.test.tsx"`
Expected: FAIL — `./page` does not exist.

- [ ] **Step 5: Implement key, hook, and page**

`lib/query/keys.ts` — add after the `certifications` line:

```ts
  certification: (id: string) => ["certifications", id] as const,
```

`lib/query/hooks.ts` — add directly after the `useCertifications` line (~line 26):

```ts
export function useCertification(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.certification(id), queryFn: () => r.certifications.get(id) }); }
```

Create `app/(app)/certifications/[id]/page.tsx`:

```tsx
"use client";
import { use } from "react";
import { useCan } from "@/lib/auth/provider";
import { useCertification, useWorkOrder, useCustomer, useSpecifications, useReleaseCertification } from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CertificationDetail } from "@/components/certifications/certification-detail";

export default function CertificationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canRelease = useCan("release_cert");
  const cert = useCertification(id);
  const workOrder = useWorkOrder(cert.data?.workOrderId ?? "");
  const customer = useCustomer(cert.data?.customerId ?? "");
  const specs = useSpecifications();
  const release = useReleaseCertification();

  if (cert.isLoading) return <SkeletonRows />;
  if (cert.isError) return <ErrorPanel message="Failed to load certification." onRetry={() => cert.refetch()} />;
  if (!cert.data) return <EmptyState title="Certification not found" />;
  const c = cert.data;

  if (workOrder.isLoading || customer.isLoading || specs.isLoading) return <SkeletonRows />;
  if (workOrder.isError || customer.isError || specs.isError)
    return <ErrorPanel message="Failed to load certification context." onRetry={() => { workOrder.refetch(); customer.refetch(); specs.refetch(); }} />;

  const specification = c.specificationId ? (specs.data ?? []).find((s) => s.id === c.specificationId) ?? null : null;

  return (
    <CertificationDetail
      cert={c} workOrder={workOrder.data ?? null} customer={customer.data ?? null} specification={specification}
      canRelease={canRelease} busy={release.isPending}
      onRelease={() => release.mutate({ id: c.id, version: c.version })}
    />
  );
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run components/certifications/certification-detail.test.tsx "app/(app)/certifications/[id]/certification-detail-page.test.tsx"`
Expected: PASS.

- [ ] **Step 7: Type/lint check + commit**

Run: `npx tsc --noEmit && npx eslint . --max-warnings 0`
Expected: clean.

```bash
git add lib/query/keys.ts lib/query/hooks.ts components/certifications/certification-detail.tsx components/certifications/certification-detail.test.tsx app/\(app\)/certifications/\[id\]
git commit -m "feat: /certifications/[id] detail page reusing useReleaseCertification"
```

---

### Task 6: Linkage — clickable cert rows + order-detail cert link

**Files:**
- Modify: `components/certifications/certifications-list.tsx` (add `onSelect`, `stopPropagation`)
- Modify: `app/(app)/certifications/page.tsx` (wire `router.push`)
- Modify: `components/orders/order-detail.tsx:129` (cert number → link)
- Test: `components/certifications/certifications-list.test.tsx`, `components/orders/order-detail.test.tsx`

**Interfaces:**
- Consumes: `CertificationsList` props (Task-5 route `/certifications/[id]` as the target), `ListCard.onRowClick(index)`, `useRouter` from `next/navigation`.
- Produces: `CertificationsList` gains optional `onSelect?: (id: string) => void`; order-detail renders `<Link href={`/certifications/${cert.id}`}>` around the cert number.

- [ ] **Step 1: Write the failing tests**

In `components/certifications/certifications-list.test.tsx`, add to the existing `describe`:

```tsx
  it("navigates on row click but NOT when Release is clicked", async () => {
    const onSelect = vi.fn();
    const onRelease = vi.fn();
    render(
      <CertificationsList certifications={certs} customers={customers} workOrders={workOrders}
        specifications={specs} canRelease onRelease={onRelease} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByText("C-9918"));
    expect(onSelect).toHaveBeenCalledWith("cert-9918");
    await userEvent.click(screen.getByRole("button", { name: /release/i }));
    expect(onRelease).toHaveBeenCalledWith("cert-9921");
    expect(onSelect).toHaveBeenCalledTimes(1); // Release click must not bubble into row navigation
  });
```

In `components/orders/order-detail.test.tsx`, add a test inside the existing `describe` (fixtures `readyOrder`/`cust`/`pm`/`pendingCert` with `id: "cert-1"`, `number: "C-9921"` already exist in that file):

```tsx
  it("links the cert number to the certification detail page", () => {
    render(<OrderDetail order={readyOrder} customer={cust} processMaster={pm} cert={pendingCert} canRelease={false} busy={false} {...handlers} />);
    expect(screen.getByRole("link", { name: "C-9921" })).toHaveAttribute("href", "/certifications/cert-1");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/certifications/certifications-list.test.tsx components/orders/order-detail.test.tsx`
Expected: FAIL — `onSelect` prop does not exist; cert number is plain text, no link role.

- [ ] **Step 3: Implement**

`components/certifications/certifications-list.tsx` — add `onSelect` to the props (type `onSelect?: (id: string) => void;`), pass `onRowClick` to `ListCard`, and stop propagation on the Release button:

```tsx
    <ListCard
      headers={["CERT", "CUSTOMER", "WORK ORDER", "SPEC", "TYPE", "COPIES", "STATUS", ""]}
      onRowClick={onSelect ? (i) => onSelect(certifications[i].id) : undefined}
```

and replace the Release button cell with:

```tsx
          canRelease && c.status === "pending"
            ? <Button key="r" size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onRelease(c.id); }}>Release</Button>
            : null,
```

`app/(app)/certifications/page.tsx` — add `import { useRouter } from "next/navigation";`, `const router = useRouter();` inside the component, and pass to the list:

```tsx
          onSelect={(id) => router.push(`/certifications/${id}`)}
```

`components/orders/order-detail.tsx` — add `import Link from "next/link";` at the top and change line ~129 from `<MonoId>{cert.number}</MonoId>` to:

```tsx
                <Link href={`/certifications/${cert.id}`} className="text-primary"><MonoId>{cert.number}</MonoId></Link>
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run components/certifications components/orders`
Expected: PASS (including all pre-existing tests in both files).

- [ ] **Step 5: Type/lint check + commit**

Run: `npx tsc --noEmit && npx eslint . --max-warnings 0`
Expected: clean.

```bash
git add components/certifications/certifications-list.tsx components/certifications/certifications-list.test.tsx app/\(app\)/certifications/page.tsx components/orders/order-detail.tsx components/orders/order-detail.test.tsx
git commit -m "feat: cert list row navigation + order-detail cert link"
```

---

### Task 7: E2E happy path + full gate

**Files:**
- Create: `tests/e2e/certifications.spec.ts`

**Interfaces:**
- Consumes: the seeded story (C-9910 pending on ready-to-ship WO-48120; CQI-9 overdue), routes `/standards`, `/certifications`, `/certifications/[id]`, `/orders/wo-48120`. Auth auto-logs-in the demo **manager** (`op-dana`) — `release_cert` is available without any setup.
- Produces: 6th E2E spec; the full gate green.

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/certifications.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("standards library renders with the overdue review flagged", async ({ page }) => {
  await page.goto("/standards");
  await expect(page.getByText("AS9100D")).toBeVisible();
  // Exactly one Overdue flag, and it sits in the CQI-9 row
  const cqi9Row = page.getByRole("row").filter({ hasText: "CQI-9" });
  await expect(cqi9Row.getByText("Overdue")).toBeVisible();
  await expect(page.getByText("Overdue")).toHaveCount(1);
});

test("pending cert blocks ship until manual release from the cert detail page", async ({ page }) => {
  // WO-48120 is ready to ship but its cert C-9910 is pending → Ship gated
  await page.goto("/orders/wo-48120");
  await expect(page.getByText("Certification must be released before ship")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeDisabled();

  // Release it from the Quality module: list → row click → detail → Release (manager)
  await page.getByRole("link", { name: "Certifications" }).click();
  await page.getByText("C-9910").click();
  await expect(page.getByText("This cert blocks shipment of WO-48120.")).toBeVisible();
  await page.getByRole("button", { name: "Release" }).click();
  await expect(page.getByText("Released", { exact: true }).first()).toBeVisible();

  // Back on the order via the detail's WO link, the ship gate is cleared
  await page.getByRole("link", { name: "WO-48120" }).click();
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeEnabled();
});
```

- [ ] **Step 2: Run the new spec**

Run: `npm run test:e2e -- certifications.spec.ts`
Expected: 2/2 PASS. (If a locator is ambiguous under strict mode, scope it to the row/section as done above — do not switch to index-based selectors.)

- [ ] **Step 3: Run the FULL gate**

```bash
npm test && npx tsc --noEmit && npx eslint . --max-warnings 0 && npm run build && npm run test:e2e
```

Expected: vitest all green, tsc clean, eslint 0 warnings, build succeeds with `/standards` and `/certifications/[id]` in the route list, e2e **6/6** (smoke, quote-to-invoice, tracking, schedule, shop-floor, certifications).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/certifications.spec.ts
git commit -m "test: e2e cert manual-release happy path + standards library"
```

---

## Self-review notes (spec → plan coverage)

- Spec §5 domain → Task 1. §6 repo/seed → Tasks 2–3. §7 pure logic → Tasks 1, 3. §8 hooks/keys → Tasks 4–5. §9.1 standards screen → Task 4. §9.2 detail → Task 5. §9.3/9.4 linkage → Task 6. §9.5 dashboard → Task 3. §11 testing → every task + Task 7 gate. §12 seed → Tasks 2–3.
- Release-path reuse (spec §2): Task 5 calls the existing `useReleaseCertification`; no hook edits anywhere — prefix invalidation of `["certifications", id]` is free.
- No new permissions, no cert schema changes, Specifications untouched — no task touches them.

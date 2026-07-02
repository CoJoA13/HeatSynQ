# HeatSynQ Plan 10 — Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the last placeholder (`/setup`) with the prototype's 6-card Setup catalog, three honest drill-down views (operators+permissions, pricing, cert defaults), and one version-checked write (operator quote-auth limit) that finally spends the reserved `edit_setup` permission.

**Architecture:** Static typed config (`SETUP_CARDS`) drives a dumb grid component (Reports-catalog pattern); three new static client subroutes under `/setup/*` are thin containers over existing Query hooks; `operators` is promoted `ReadRepo → WriteRepo` (Plan-8 Equipment precedent) for exactly one narrow mutation. Zero seed changes, zero new entities, zero clock logic.

**Tech Stack:** Next.js (app router — THIS REPO'S FORK HAS BREAKING CHANGES, see AGENTS.md), React Query, zod, Tailwind tokens, Vitest + Testing Library, Playwright.

Spec: `docs/superpowers/specs/2026-07-02-heatsynq-setup-design.md` (approved). Branch: `heatsynq-setup` (already created; spec committed as `ae86b31`).

## Global Constraints

- **AGENTS.md mandate:** read the relevant guide in `node_modules/next/dist/docs/` before writing any Next-specific code. All three new routes are static client pages — copy the exact structure of existing pages (e.g. `app/(app)/standards/page.tsx`); they are already conformant.
- **Canon strings verbatim** (prototype `Visual Shop.dc.html` lines 1102–1109 + 372): card titles/descs and the page subtitle `Configuration once buried under Maintain ▸ … ▸ …, now flat` must match character-for-character (including `▸` and `…`).
- **Money = integer cents**; display via whole-dollar `formatMoney` from `@/lib/utils` (1030¢ → "$10" — this is the house convention, do NOT add a cents-precise formatter).
- **No `new Date()` / `Date.now()`** anywhere in app/components/lib (topbar is the sole exception; this slice needs no clock at all).
- **No new `any`**, no new deps, no `eslint-disable`. Lint runs `--max-warnings 0`.
- **FKs are plain `z.string()`** — no branded id unions.
- **Optimistic concurrency:** every update passes `expectedVersion`; mock throws `"Version conflict"` on mismatch.
- **Permissions:** gate ACTIONS with `useCan("edit_setup")` (manager-only, matrix unchanged); views stay ungated. Never use `viewAs` for gating.
- **Naming:** `.test.ts(x)` = Vitest (colocated next to source), `.spec.ts` = Playwright (in `tests/e2e/` only).
- **Baseline stays green:** `npx tsc --noEmit` · `npm run lint -- --max-warnings 0` · `npm run test` (400 tests / 78 files before this plan) · `npm run build` · `npm run test:e2e` (8 specs / 10 tests before this plan).
- Commit after every task with the message given in the task.

---

### Task 1: Setup catalog config (`lib/logic/setup.ts`)

**Files:**
- Create: `lib/logic/setup.ts`
- Test: `lib/logic/setup.test.ts`

**Interfaces:**
- Consumes: nothing (pure static config).
- Produces: `export type SetupCardKey`, `export type SetupCard = { key: SetupCardKey; title: string; desc: string; href: string | null }`, `export const SETUP_CARDS: SetupCard[]` (Task 4 imports `SETUP_CARDS`).

- [ ] **Step 1: Write the failing test**

Create `lib/logic/setup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SETUP_CARDS } from "./setup";

describe("SETUP_CARDS canon", () => {
  it("pins the 6 prototype cards verbatim, in order", () => {
    expect(SETUP_CARDS.map((c) => [c.title, c.desc])).toEqual([
      ["Operators & Security", "Operator IDs, roles, module permissions and signatures."],
      ["Plant Setup", "Company info that prints on travelers, certs and invoices."],
      ["Process Masters", "Recipes: standard steps, table keys and equipment."],
      ["Equipment & Areas", "Furnaces, ovens, areas and tracking templates."],
      ["Pricing & Price Keys", "Step pricing, customer overrides and dimensional pricing."],
      ["Certifications & Forms", "Cert formats, defaults and form / message inserts."],
    ]);
  });

  it("pins card targets: 5 links + inert Plant Setup", () => {
    expect(SETUP_CARDS.map((c) => [c.key, c.href])).toEqual([
      ["operators", "/setup/operators"],
      ["plant", null],
      ["process-masters", "/process-masters"],
      ["equipment", "/shop-floor"],
      ["pricing", "/setup/pricing"],
      ["cert-defaults", "/setup/cert-defaults"],
    ]);
  });

  it("keys are unique", () => {
    const keys = SETUP_CARDS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/logic/setup.test.ts`
Expected: FAIL — `Cannot find module './setup'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `lib/logic/setup.ts`:

```ts
export type SetupCardKey = "operators" | "plant" | "process-masters" | "equipment" | "pricing" | "cert-defaults";

export type SetupCard = { key: SetupCardKey; title: string; desc: string; href: string | null };

/** Prototype canon: Visual Shop.dc.html lines 1102-1109 (setupCards data) + 370-378 (markup).
 *  Titles and descs are verbatim. Targets are per-card honesty (spec §1): cards whose domain
 *  already has a screen link there; Plant Setup is inert (nothing prints anywhere yet). */
export const SETUP_CARDS: SetupCard[] = [
  { key: "operators", title: "Operators & Security", desc: "Operator IDs, roles, module permissions and signatures.", href: "/setup/operators" },
  { key: "plant", title: "Plant Setup", desc: "Company info that prints on travelers, certs and invoices.", href: null },
  { key: "process-masters", title: "Process Masters", desc: "Recipes: standard steps, table keys and equipment.", href: "/process-masters" },
  { key: "equipment", title: "Equipment & Areas", desc: "Furnaces, ovens, areas and tracking templates.", href: "/shop-floor" },
  { key: "pricing", title: "Pricing & Price Keys", desc: "Step pricing, customer overrides and dimensional pricing.", href: "/setup/pricing" },
  { key: "cert-defaults", title: "Certifications & Forms", desc: "Cert formats, defaults and form / message inserts.", href: "/setup/cert-defaults" },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/logic/setup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/setup.ts lib/logic/setup.test.ts
git commit -m "feat(setup): canon SETUP_CARDS config (6 prototype cards, per-card honesty targets)"
```

---

### Task 2: Permission-matrix exports + roleMeta centralization

**Files:**
- Modify: `lib/auth/permissions.ts` (whole file shown below)
- Modify: `lib/domain/enums.ts` (append `roleMeta` after line 26, the `RoleKey` type)
- Modify: `components/today/today-dashboard.tsx:7-11` (derive `ROLES` from `roleMeta`)
- Test: `lib/auth/permissions.test.ts` (extend), `lib/domain/enums.test.ts` (extend)

**Interfaces:**
- Consumes: `RoleKey`, `ROLE_KEYS` from `@/lib/domain/enums` (existing).
- Produces: `export const PERMISSIONS: readonly Permission[]` (7 keys, display order), `export const MATRIX: Record<Permission, RoleKey[]>` (now exported, values unchanged), `export const permissionMeta: Record<Permission, { label: string }>`, `export const roleMeta: Record<RoleKey, { label: string }>` in enums. `Permission` type and `can()` signature unchanged. Task 5 imports `PERMISSIONS`, `MATRIX`, `permissionMeta`, `roleMeta`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/auth/permissions.test.ts` (keep existing describes untouched):

```ts
import { PERMISSIONS, MATRIX, permissionMeta } from "@/lib/auth/permissions";
import { ROLE_KEYS } from "@/lib/domain/enums";

describe("permission matrix exports (Setup)", () => {
  it("PERMISSIONS lists all 7 keys in display order", () => {
    expect(PERMISSIONS).toEqual([
      "approve_over_limit", "apply_discount", "release_cert", "close_period",
      "edit_setup", "schedule_loads", "maintain_equipment",
    ]);
  });
  it("MATRIX agrees with can() for every permission × role", () => {
    for (const p of PERMISSIONS) for (const r of ROLE_KEYS) {
      expect(MATRIX[p].includes(r)).toBe(can(r, p));
    }
  });
  it("every permission has a label", () => {
    for (const p of PERMISSIONS) expect(permissionMeta[p].label.length).toBeGreaterThan(0);
  });
});
```

(Note: the file already imports `can` and `describe/it/expect` from vitest — merge the new imports into the existing import lines rather than duplicating them.)

Append to `lib/domain/enums.test.ts`:

```ts
import { roleMeta, ROLE_KEYS } from "./enums";

describe("roleMeta", () => {
  it("labels every role", () => {
    expect(ROLE_KEYS.map((k) => roleMeta[k].label)).toEqual(["Manager", "Sales", "Office"]);
  });
});
```

(Same merge note: `ROLE_KEYS` may already be imported there — merge, don't duplicate.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/auth/permissions.test.ts lib/domain/enums.test.ts`
Expected: FAIL — `permissions.ts` has no export `PERMISSIONS`; `enums.ts` has no export `roleMeta`.

- [ ] **Step 3: Implement**

Replace `lib/auth/permissions.ts` entirely with:

```ts
import type { RoleKey } from "@/lib/domain";

/** Display order for the Setup permission-matrix view. */
export const PERMISSIONS = ["approve_over_limit", "apply_discount", "release_cert", "close_period", "edit_setup", "schedule_loads", "maintain_equipment"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const MATRIX: Record<Permission, RoleKey[]> = {
  approve_over_limit: ["manager"],
  apply_discount: ["manager", "sales"],
  release_cert: ["manager"],
  close_period: ["manager", "office"],
  edit_setup: ["manager"],
  schedule_loads: ["manager", "office"],
  maintain_equipment: ["manager", "office"],
};

export const permissionMeta: Record<Permission, { label: string }> = {
  approve_over_limit: { label: "Approve over-limit quotes" },
  apply_discount: { label: "Apply discounts" },
  release_cert: { label: "Release certifications" },
  close_period: { label: "Close A/R period" },
  edit_setup: { label: "Edit setup" },
  schedule_loads: { label: "Schedule loads" },
  maintain_equipment: { label: "Maintain equipment" },
};

export function can(role: RoleKey, perm: Permission): boolean {
  return MATRIX[perm].includes(role);
}
```

(The `Permission` union is now derived from the tuple — identical member set, same house idiom as `ROLE_KEYS`. Matrix rows and `can()` are byte-identical in behavior.)

In `lib/domain/enums.ts`, insert directly after line 26 (`export type RoleKey = ...`):

```ts
export const roleMeta: Record<RoleKey, { label: string }> = {
  manager: { label: "Manager" },
  sales: { label: "Sales" },
  office: { label: "Office" },
};
```

In `components/today/today-dashboard.tsx`, replace lines 7–11:

```ts
const ROLES: { key: RoleKey; label: string }[] = [
  { key: "manager", label: "Manager" },
  { key: "sales", label: "Sales" },
  { key: "office", label: "Office" },
];
```

with:

```ts
const ROLES = ROLE_KEYS.map((key) => ({ key, label: roleMeta[key].label }));
```

and change its enums import line to include both names (the file currently imports `RoleKey` from `@/lib/domain` — keep that if still used by the props type; add `import { ROLE_KEYS, roleMeta } from "@/lib/domain/enums";`).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run lib/auth/permissions.test.ts lib/domain/enums.test.ts && npx vitest run components/today && npx tsc --noEmit`
Expected: ALL PASS (today-dashboard behavior unchanged — same three buttons, same labels).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/permissions.ts lib/auth/permissions.test.ts lib/domain/enums.ts lib/domain/enums.test.ts components/today/today-dashboard.tsx
git commit -m "feat(setup): export PERMISSIONS/MATRIX/permissionMeta, centralize roleMeta"
```

---

### Task 3: Operators WriteRepo promotion + `useSetOperatorQuoteLimit`

**Files:**
- Modify: `lib/data/repositories/index.ts:45` (`operators: ReadRepo<Operator>` → `WriteRepo<Operator>`)
- Modify: `lib/data/mock/repositories.ts:85` (`operators: read(cols.operators)` → `write(cols.operators)`)
- Modify: `lib/query/hooks.ts` (append the mutation hook at the end of the file)
- Test: `tests/operator-hooks.test.tsx` (new)

**Interfaces:**
- Consumes: `WriteRepo<T>` (existing, `update(id, patch, expectedVersion)`), `queryKeys.operators = ["operators"]` (existing), `Operator` type (already imported in hooks.ts line 3).
- Produces: `useSetOperatorQuoteLimit(): UseMutationResult` with `mutate/mutateAsync(vars: { operator: Operator; quoteAuthLimitCents: number })`. Task 5's page calls `setLimit.mutate({ operator, quoteAuthLimitCents })`.

- [ ] **Step 1: Write the failing test**

Create `tests/operator-hooks.test.tsx` (mirrors `tests/equipment-hooks.test.tsx` — REAL mock repos, never vi.mock the data layer):

```tsx
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import { useSetOperatorQuoteLimit } from "@/lib/query/hooks";
import type { ReactNode } from "react";

function createWrapper(repositories = createMockRepositories({ latencyMs: 0 })) {
  const Wrapper = ({ children }: { children: ReactNode }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={client}>
        <RepositoriesProvider repositories={repositories}>
          <AuthProvider>{children}</AuthProvider>
        </RepositoriesProvider>
      </QueryClientProvider>
    );
  };
  Wrapper.displayName = "OperatorHooksTestWrapper";
  return Wrapper;
}

describe("operator seed pins", () => {
  it("pins the 3 seed operators' roles and quote limits", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const ops = await repos.operators.list();
    expect(ops.map((o) => [o.id, o.role, o.quoteAuthLimitCents])).toEqual([
      ["op-dana", "manager", 100_000_00],
      ["op-vance", "sales", 25_000_00],
      ["op-office", "office", 0],
    ]);
  });
});

describe("useSetOperatorQuoteLimit", () => {
  it("happy path: updates the limit and bumps version", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useSetOperatorQuoteLimit(), { wrapper });

    const vance = (await repos.operators.get("op-vance"))!;
    await act(() => result.current.mutateAsync({ operator: vance, quoteAuthLimitCents: 30_000_00 }));

    const after = (await repos.operators.get("op-vance"))!;
    expect(after.quoteAuthLimitCents).toBe(30_000_00);
    expect(after.version).toBe(1);
    expect(after.role).toBe("sales"); // narrow patch — nothing else changes
  });

  it("stale version rejects with Version conflict, state unchanged", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useSetOperatorQuoteLimit(), { wrapper });

    const vance = (await repos.operators.get("op-vance"))!;
    await expect(
      result.current.mutateAsync({ operator: { ...vance, version: 99 }, quoteAuthLimitCents: 1 }),
    ).rejects.toThrow("Version conflict");
    expect((await repos.operators.get("op-vance"))!.quoteAuthLimitCents).toBe(25_000_00);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/operator-hooks.test.tsx`
Expected: FAIL — `useSetOperatorQuoteLimit` is not exported from `@/lib/query/hooks`.

- [ ] **Step 3: Implement**

In `lib/data/repositories/index.ts`, change line 45 from:

```ts
  operators: ReadRepo<Operator>;
```

to:

```ts
  operators: WriteRepo<Operator>;
```

In `lib/data/mock/repositories.ts`, change line 85 from:

```ts
    operators: read(cols.operators),
```

to:

```ts
    operators: write(cols.operators),
```

(The generic `write()` factory already exists; operators gain `create` with no callers — same shape as `scheduleBlocks`/`equipment`.)

Append to the end of `lib/query/hooks.ts`:

```ts
export function useSetOperatorQuoteLimit() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { operator: Operator; quoteAuthLimitCents: number }) =>
      r.operators.update(vars.operator.id, { quoteAuthLimitCents: vars.quoteAuthLimitCents }, vars.operator.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.operators });
    },
  });
}
```

(`Operator` is already imported at hooks.ts line 3; no import changes needed.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/operator-hooks.test.tsx && npx tsc --noEmit`
Expected: PASS (3 tests), clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add lib/data/repositories/index.ts lib/data/mock/repositories.ts lib/query/hooks.ts tests/operator-hooks.test.tsx
git commit -m "feat(setup): promote operators to WriteRepo + useSetOperatorQuoteLimit (version-checked)"
```

---

### Task 4: SetupGrid + `/setup` page rewrite + PlaceholderPage retirement

**Files:**
- Create: `components/setup/setup-grid.tsx`
- Test: `components/setup/setup-grid.test.tsx`
- Modify: `app/(app)/setup/page.tsx` (full rewrite)
- Delete: `components/patterns/placeholder-page.tsx`, `components/patterns/placeholder-page.test.tsx`
- Modify: `components/patterns/index.ts` (remove line 14: `export * from "./placeholder-page";`)
- Delete: the stray empty untracked directory literally named `app/\(app\)/` (escaped parens — shell accident; verify it is empty first with `ls`)

**Interfaces:**
- Consumes: `SETUP_CARDS` from `@/lib/logic/setup` (Task 1), `PageHeader` from `@/components/patterns`.
- Produces: `export function SetupGrid()` (no props); route `/setup` renders it. Testids `setup-card-<key>`.

- [ ] **Step 1: Write the failing test**

Create `components/setup/setup-grid.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SetupGrid } from "./setup-grid";

describe("SetupGrid", () => {
  it("renders all 6 canon cards", () => {
    render(<SetupGrid />);
    for (const key of ["operators", "plant", "process-masters", "equipment", "pricing", "cert-defaults"]) {
      expect(screen.getByTestId(`setup-card-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Operators & Security")).toBeInTheDocument();
    expect(screen.getByText("Operator IDs, roles, module permissions and signatures.")).toBeInTheDocument();
  });

  it("5 cards are links with canon targets; Plant Setup is inert with honest caption", () => {
    render(<SetupGrid />);
    expect(screen.getByTestId("setup-card-operators")).toHaveAttribute("href", "/setup/operators");
    expect(screen.getByTestId("setup-card-process-masters")).toHaveAttribute("href", "/process-masters");
    expect(screen.getByTestId("setup-card-equipment")).toHaveAttribute("href", "/shop-floor");
    expect(screen.getByTestId("setup-card-pricing")).toHaveAttribute("href", "/setup/pricing");
    expect(screen.getByTestId("setup-card-cert-defaults")).toHaveAttribute("href", "/setup/cert-defaults");
    const plant = screen.getByTestId("setup-card-plant");
    expect(plant).not.toHaveAttribute("href");
    expect(plant).toHaveTextContent("Not built yet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/setup/setup-grid.test.tsx`
Expected: FAIL — cannot resolve `./setup-grid`.

- [ ] **Step 3: Implement the component**

Create `components/setup/setup-grid.tsx`:

```tsx
import Link from "next/link";
import { SETUP_CARDS } from "@/lib/logic/setup";

export function SetupGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SETUP_CARDS.map((c) =>
        c.href ? (
          <Link
            key={c.key}
            data-testid={`setup-card-${c.key}`}
            href={c.href}
            className="rounded-card border-border bg-surface hover:bg-canvas block border p-4"
          >
            <div className="flex items-center justify-between">
              <div className="text-[13.5px] font-semibold">{c.title}</div>
              <span className="text-text-faint">→</span>
            </div>
            <p className="text-text-muted mt-1 text-xs leading-relaxed">{c.desc}</p>
          </Link>
        ) : (
          <div key={c.key} data-testid={`setup-card-${c.key}`} className="rounded-card border-border bg-surface border p-4">
            <div className="text-[13.5px] font-semibold">{c.title}</div>
            <p className="text-text-muted mt-1 text-xs leading-relaxed">{c.desc}</p>
            <p className="text-text-faint mt-2 text-[11px]">Not built yet</p>
          </div>
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/setup/setup-grid.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewrite the page + retire PlaceholderPage**

Replace `app/(app)/setup/page.tsx` entirely with:

```tsx
"use client";
import { PageHeader } from "@/components/patterns";
import { SetupGrid } from "@/components/setup/setup-grid";

export default function SetupPage() {
  return (
    <div>
      <PageHeader title="Setup" subtitle="Configuration once buried under Maintain ▸ … ▸ …, now flat" />
      <SetupGrid />
    </div>
  );
}
```

Then:

```bash
git rm components/patterns/placeholder-page.tsx components/patterns/placeholder-page.test.tsx
```

Remove line 14 (`export * from "./placeholder-page";`) from `components/patterns/index.ts`.

Remove the stray directory (verify empty first — if `ls` shows contents, STOP and flag instead of deleting):

```bash
ls 'app/\(app\)/' && rmdir 'app/\(app\)/'
```

- [ ] **Step 6: Verify no dangling references + full unit suite**

Run: `grep -rn "PlaceholderPage" app/ components/ lib/ tests/ ; npx vitest run && npx tsc --noEmit`
Expected: grep returns NOTHING; vitest total DROPS by 1 (PlaceholderPage's own test deleted) then GROWS with the new tests — all passing; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(setup): canon catalog grid at /setup; retire PlaceholderPage (last consumer)"
```

---

### Task 5: Operators & Security view (`/setup/operators`) — the one write

**Files:**
- Create: `components/setup/operators-security.tsx`
- Test: `components/setup/operators-security.test.tsx`
- Create: `app/(app)/setup/operators/page.tsx`
- Test: `app/(app)/setup/operators/setup-operators-page.test.tsx`

**Interfaces:**
- Consumes: `PERMISSIONS`, `MATRIX`, `permissionMeta` from `@/lib/auth/permissions` and `roleMeta`, `ROLE_KEYS` from `@/lib/domain/enums` (Task 2); `useSetOperatorQuoteLimit` (Task 3); `useOperators`, `useCan`, patterns, `Dialog`/`Button`/`Input` primitives (existing).
- Produces: `export function OperatorsSecurity({ operators, canEdit, busy, onSetLimit }: { operators: Operator[]; canEdit: boolean; busy: boolean; onSetLimit: (operator: Operator, quoteAuthLimitCents: number) => void })`. Testids: `operator-row-<id>`, `operator-limit-<id>`, `edit-limit-<id>`, `permission-row-<perm>`. Dialog input labeled `Quote limit ($)`; confirm button text `Save limit`. Task 8's e2e relies on these exact testids/labels.

- [ ] **Step 1: Write the failing component test**

Create `components/setup/operators-security.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OperatorsSecurity } from "./operators-security";
import type { Operator } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const OPERATORS: Operator[] = [
  { ...base, id: "op-dana", name: "Dana Mercer", initials: "DM", title: "Plant Manager", role: "manager", quoteAuthLimitCents: 100_000_00 },
  { ...base, id: "op-vance", name: "S. Vance", initials: "SV", title: "Estimator", role: "sales", quoteAuthLimitCents: 25_000_00 },
  { ...base, id: "op-office", name: "R. Office", initials: "RO", title: "A/R Clerk", role: "office", quoteAuthLimitCents: 0 },
];

function renderView(over: Partial<Parameters<typeof OperatorsSecurity>[0]> = {}) {
  const onSetLimit = vi.fn();
  render(<OperatorsSecurity operators={OPERATORS} canEdit={true} busy={false} onSetLimit={onSetLimit} {...over} />);
  return { onSetLimit };
}

describe("OperatorsSecurity", () => {
  it("renders operator rows with role labels and mono limits", () => {
    renderView();
    expect(screen.getByTestId("operator-row-op-dana")).toHaveTextContent("Dana Mercer");
    expect(screen.getByText("Estimator")).toBeInTheDocument();
    expect(screen.getByText("Manager")).toBeInTheDocument();
    expect(screen.getByTestId("operator-limit-op-vance")).toHaveTextContent("$25,000");
    expect(screen.getByTestId("operator-limit-op-office")).toHaveTextContent("$0");
  });

  it("renders the 7-row permission matrix with ✓/— placement", () => {
    renderView();
    for (const p of ["approve_over_limit", "apply_discount", "release_cert", "close_period", "edit_setup", "schedule_loads", "maintain_equipment"]) {
      expect(screen.getByTestId(`permission-row-${p}`)).toBeInTheDocument();
    }
    // edit_setup row: manager ✓, sales —, office —
    const row = screen.getByTestId("permission-row-edit_setup").closest("tr")!;
    const cells = Array.from(row.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toEqual(["Edit setup", "✓", "—", "—"]);
  });

  it("shows the signatures framing note", () => {
    renderView();
    expect(screen.getByText("Signatures aren't modeled yet.")).toBeInTheDocument();
  });

  it("hides Edit-limit actions when canEdit is false", () => {
    renderView({ canEdit: false });
    expect(screen.queryByTestId("edit-limit-op-vance")).not.toBeInTheDocument();
  });

  it("edit dialog validates and submits cents", () => {
    const { onSetLimit } = renderView();
    fireEvent.click(screen.getByTestId("edit-limit-op-vance"));
    const input = screen.getByLabelText("Quote limit ($)");
    // invalid: negative disables Save
    fireEvent.change(input, { target: { value: "-5" } });
    expect(screen.getByRole("button", { name: "Save limit" })).toBeDisabled();
    // unchanged value disables Save
    fireEvent.change(input, { target: { value: "25000" } });
    expect(screen.getByRole("button", { name: "Save limit" })).toBeDisabled();
    // valid new value → converts dollars to cents
    fireEvent.change(input, { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(onSetLimit).toHaveBeenCalledWith(expect.objectContaining({ id: "op-vance" }), 30_000_00);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/setup/operators-security.test.tsx`
Expected: FAIL — cannot resolve `./operators-security`.

- [ ] **Step 3: Implement the component**

Create `components/setup/operators-security.tsx`:

```tsx
"use client";
import { useState } from "react";
import { ListCard, MonoId } from "@/components/patterns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { roleMeta, ROLE_KEYS } from "@/lib/domain/enums";
import { PERMISSIONS, MATRIX, permissionMeta } from "@/lib/auth/permissions";
import { formatMoney } from "@/lib/utils";
import type { Operator } from "@/lib/domain";

function LimitForm({ operator, busy, onCancel, onConfirm }: {
  operator: Operator; busy: boolean; onCancel: () => void; onConfirm: (quoteAuthLimitCents: number) => void;
}) {
  const [dollars, setDollars] = useState(String(operator.quoteAuthLimitCents / 100));
  const parsed = Number(dollars);
  const valid = dollars.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const cents = valid ? Math.round(parsed * 100) : operator.quoteAuthLimitCents;
  const unchanged = cents === operator.quoteAuthLimitCents;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit quote limit</DialogTitle>
        <DialogDescription>{operator.name} — quotes above this limit route to manager approval.</DialogDescription>
      </DialogHeader>
      <label className="block text-xs">
        <span className="text-text-muted mb-1 block">Quote limit ($)</span>
        <Input aria-label="Quote limit ($)" type="number" min={0} value={dollars} onChange={(e) => setDollars(e.target.value)} />
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button disabled={busy || !valid || unchanged} onClick={() => onConfirm(cents)}>Save limit</Button>
      </DialogFooter>
    </>
  );
}

export function OperatorsSecurity({ operators, canEdit, busy, onSetLimit }: {
  operators: Operator[]; canEdit: boolean; busy: boolean;
  onSetLimit: (operator: Operator, quoteAuthLimitCents: number) => void;
}) {
  const [editing, setEditing] = useState<Operator | null>(null);
  return (
    <div className="space-y-5">
      <div>
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Operators</div>
        <ListCard
          headers={["OPERATOR", "TITLE", "ROLE", "QUOTE LIMIT", ...(canEdit ? [""] : [])]}
          rows={operators.map((o) => [
            <div key="op" data-testid={`operator-row-${o.id}`}>
              <div className="text-[13px] font-medium">{o.name}</div>
              <MonoId className="text-text-muted text-xs">{o.id}</MonoId>
            </div>,
            o.title,
            roleMeta[o.role].label,
            <span key="limit" data-testid={`operator-limit-${o.id}`} className="font-mono">{formatMoney(o.quoteAuthLimitCents)}</span>,
            ...(canEdit
              ? [<Button key="edit" size="sm" variant="outline" data-testid={`edit-limit-${o.id}`} disabled={busy} onClick={() => setEditing(o)}>Edit limit</Button>]
              : []),
          ])}
        />
        <p className="text-text-faint mt-2 text-[11px]">Signatures aren&apos;t modeled yet.</p>
      </div>
      <div>
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Module permissions</div>
        <ListCard
          headers={["PERMISSION", ...ROLE_KEYS.map((r) => roleMeta[r].label.toUpperCase())]}
          rows={PERMISSIONS.map((p) => [
            <span key="p" data-testid={`permission-row-${p}`}>{permissionMeta[p].label}</span>,
            ...ROLE_KEYS.map((role) => (MATRIX[p].includes(role) ? "✓" : "—")),
          ])}
        />
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent showCloseButton={false}>
          {editing && (
            <LimitForm key={editing.id} operator={editing} busy={busy} onCancel={() => setEditing(null)}
              onConfirm={(cents) => { onSetLimit(editing, cents); setEditing(null); }} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/setup/operators-security.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing page-guard test**

Create `app/(app)/setup/operators/setup-operators-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupOperatorsPage from "./page";

const mockOperators = vi.fn();
const mockMutation = vi.fn();
vi.mock("@/lib/query/hooks", () => ({
  useOperators: () => mockOperators(),
  useSetOperatorQuoteLimit: () => mockMutation(),
}));
vi.mock("@/lib/auth/provider", () => ({ useCan: () => true }));
vi.mock("@/components/setup/operators-security", () => ({
  OperatorsSecurity: () => <div data-testid="operators-security" />,
}));

beforeEach(() => {
  mockOperators.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockMutation.mockReturnValue({ isPending: false, mutate: vi.fn() });
});

describe("SetupOperatorsPage guards", () => {
  it("renders skeleton while loading", () => {
    mockOperators.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<SetupOperatorsPage />);
    expect(screen.queryByTestId("operators-security")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockOperators.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<SetupOperatorsPage />);
    expect(screen.getByText("Failed to load operators.")).toBeInTheDocument();
  });
  it("renders EmptyState when no rows", () => {
    render(<SetupOperatorsPage />);
    expect(screen.getByText("No operators")).toBeInTheDocument();
  });
  it("renders the view with data + back link to /setup", () => {
    mockOperators.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ id: "op-dana", createdAt: "", updatedAt: "", version: 0, name: "Dana Mercer", initials: "DM", title: "Plant Manager", role: "manager", quoteAuthLimitCents: 100_000_00 }],
    });
    render(<SetupOperatorsPage />);
    expect(screen.getByTestId("operators-security")).toBeInTheDocument();
    expect(screen.getByText("Operators & Security")).toBeInTheDocument();
    expect(screen.getByText("Setup")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run "app/(app)/setup/operators/setup-operators-page.test.tsx"`
Expected: FAIL — cannot resolve `./page`.

- [ ] **Step 7: Implement the page**

Create `app/(app)/setup/operators/page.tsx`:

```tsx
"use client";
import { useOperators, useSetOperatorQuoteLimit } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { DetailHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OperatorsSecurity } from "@/components/setup/operators-security";

export default function SetupOperatorsPage() {
  const canEdit = useCan("edit_setup");
  const operators = useOperators();
  const setLimit = useSetOperatorQuoteLimit();
  return (
    <div>
      <DetailHeader backHref="/setup" backLabel="Setup" title="Operators & Security"
        subtitle="Operator IDs, roles, module permissions and signatures." />
      {operators.isLoading ? (
        <SkeletonRows />
      ) : operators.isError ? (
        <ErrorPanel message="Failed to load operators." onRetry={() => operators.refetch()} />
      ) : !operators.data || operators.data.length === 0 ? (
        <EmptyState title="No operators" />
      ) : (
        <OperatorsSecurity operators={operators.data} canEdit={canEdit} busy={setLimit.isPending}
          onSetLimit={(operator, quoteAuthLimitCents) => setLimit.mutate({ operator, quoteAuthLimitCents })} />
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run components/setup "app/(app)/setup" && npx tsc --noEmit`
Expected: ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add components/setup/operators-security.tsx components/setup/operators-security.test.tsx "app/(app)/setup/operators/"
git commit -m "feat(setup): Operators & Security view — roster, permission matrix, edit_setup-gated quote-limit write"
```

---

### Task 6: Pricing & Price Keys view (`/setup/pricing`)

**Files:**
- Create: `components/setup/pricing-keys.tsx`
- Test: `components/setup/pricing-keys.test.tsx`
- Create: `app/(app)/setup/pricing/page.tsx`
- Test: `app/(app)/setup/pricing/setup-pricing-page.test.tsx`

**Interfaces:**
- Consumes: `usePriceKeys`, `usePricingRulesByPriceKey`, `useCustomers` (existing hooks); `basisLabel` from `@/lib/domain/enums`; `formatMoney`; patterns.
- Produces: `export function PricingKeyCard({ priceKey, rules, customerCount }: { priceKey: PriceKey; rules: PricingRule[]; customerCount: number })` — presentational; the page owns a `PriceKeySection` child that fetches rules per key. Testid `price-key-<code>` (e.g. `price-key-AERO-1`) — Task 8's e2e relies on it.

- [ ] **Step 1: Write the failing component test**

Create `components/setup/pricing-keys.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PricingKeyCard } from "./pricing-keys";
import type { PriceKey, PricingRule } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const KEY: PriceKey = { ...base, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" };
const RULES: PricingRule[] = [
  { ...base, id: "pr-carb", priceKeyId: "pk-aero1", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
  { ...base, id: "pr-temper", priceKeyId: "pk-aero1", process: "Temper", basis: "per_lot", rateCents: 144000, minChargeCents: null },
  { ...base, id: "pr-cert", priceKeyId: "pk-aero1", process: "Certification", basis: "flat", rateCents: 80000, minChargeCents: null },
  { ...base, id: "pr-neutral", priceKeyId: "pk-aero1", process: "Neutral harden", basis: "per_lb", rateCents: 680, minChargeCents: 18000 },
];

describe("PricingKeyCard", () => {
  it("renders key header, customer count, and the 4 seed rules (whole-dollar formatMoney)", () => {
    render(<PricingKeyCard priceKey={KEY} rules={RULES} customerCount={1} />);
    const card = screen.getByTestId("price-key-AERO-1");
    expect(card).toHaveTextContent("AERO-1");
    expect(card).toHaveTextContent("Aerospace step pricing");
    expect(card).toHaveTextContent("Used by 1 customer");
    expect(card).toHaveTextContent("Carburize");
    expect(card).toHaveTextContent("per lb");
    expect(card).toHaveTextContent("$10");   // 1030¢ — house whole-dollar convention (matches customer Pricing tab)
    expect(card).toHaveTextContent("$250");  // min charge 25000¢
    expect(card).toHaveTextContent("$1,440");
    expect(card).toHaveTextContent("$800");
    expect(card).toHaveTextContent("$7");    // 680¢ rounds to $7
  });

  it("pluralizes the customer count and shows an empty state for zero rules", () => {
    render(<PricingKeyCard priceKey={KEY} rules={[]} customerCount={0} />);
    expect(screen.getByTestId("price-key-AERO-1")).toHaveTextContent("Used by 0 customers");
    expect(screen.getByText("No rules")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/setup/pricing-keys.test.tsx`
Expected: FAIL — cannot resolve `./pricing-keys`.

- [ ] **Step 3: Implement the component**

Create `components/setup/pricing-keys.tsx`:

```tsx
import { ListCard, MonoId, EmptyState } from "@/components/patterns";
import { basisLabel } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import type { PriceKey, PricingRule } from "@/lib/domain";

export function PricingKeyCard({ priceKey, rules, customerCount }: {
  priceKey: PriceKey; rules: PricingRule[]; customerCount: number;
}) {
  return (
    <div data-testid={`price-key-${priceKey.code}`} className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <MonoId>{priceKey.code}</MonoId>
          <span className="text-text-muted text-xs">— {priceKey.description}</span>
        </div>
        <p className="text-text-muted text-xs">Used by {customerCount} customer{customerCount === 1 ? "" : "s"}</p>
      </div>
      {rules.length === 0 ? (
        <EmptyState title="No rules" />
      ) : (
        <ListCard
          headers={["PROCESS", "BASIS", "RATE", "MIN CHARGE"]}
          rows={rules.map((r) => [
            r.process,
            basisLabel[r.basis],
            <span key="rate" className="font-mono">{formatMoney(r.rateCents)}</span>,
            <span key="min" className="font-mono">{r.minChargeCents != null ? formatMoney(r.minChargeCents) : "—"}</span>,
          ])}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/setup/pricing-keys.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing page-guard test**

Create `app/(app)/setup/pricing/setup-pricing-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupPricingPage from "./page";

const mockPriceKeys = vi.fn();
const mockCustomers = vi.fn();
const mockRules = vi.fn();
vi.mock("@/lib/query/hooks", () => ({
  usePriceKeys: () => mockPriceKeys(),
  useCustomers: () => mockCustomers(),
  usePricingRulesByPriceKey: () => mockRules(),
}));
vi.mock("@/components/setup/pricing-keys", () => ({
  PricingKeyCard: () => <div data-testid="pricing-key-card" />,
}));

const base = { createdAt: "", updatedAt: "", version: 0 };

beforeEach(() => {
  mockPriceKeys.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockCustomers.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockRules.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("SetupPricingPage guards", () => {
  it("renders skeleton while loading", () => {
    mockPriceKeys.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<SetupPricingPage />);
    expect(screen.queryByTestId("pricing-key-card")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockPriceKeys.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<SetupPricingPage />);
    expect(screen.getByText("Failed to load pricing.")).toBeInTheDocument();
  });
  it("renders EmptyState when no price keys", () => {
    render(<SetupPricingPage />);
    expect(screen.getByText("No price keys")).toBeInTheDocument();
  });
  it("renders a card per key with data", () => {
    mockPriceKeys.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ ...base, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" }],
    });
    render(<SetupPricingPage />);
    expect(screen.getByTestId("pricing-key-card")).toBeInTheDocument();
    expect(screen.getByText("Pricing & Price Keys")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run "app/(app)/setup/pricing/setup-pricing-page.test.tsx"`
Expected: FAIL — cannot resolve `./page`.

- [ ] **Step 7: Implement the page**

Create `app/(app)/setup/pricing/page.tsx`:

```tsx
"use client";
import { usePriceKeys, usePricingRulesByPriceKey, useCustomers } from "@/lib/query/hooks";
import { DetailHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { PricingKeyCard } from "@/components/setup/pricing-keys";
import type { PriceKey } from "@/lib/domain";

function PriceKeySection({ priceKey, customerCount }: { priceKey: PriceKey; customerCount: number }) {
  const rules = usePricingRulesByPriceKey(priceKey.id);
  if (rules.isLoading) return <SkeletonRows count={3} />;
  if (rules.isError) return <ErrorPanel message="Failed to load pricing rules." onRetry={() => rules.refetch()} />;
  return <PricingKeyCard priceKey={priceKey} rules={rules.data ?? []} customerCount={customerCount} />;
}

export default function SetupPricingPage() {
  const keys = usePriceKeys();
  const customers = useCustomers();
  return (
    <div>
      <DetailHeader backHref="/setup" backLabel="Setup" title="Pricing & Price Keys"
        subtitle="Step pricing, customer overrides and dimensional pricing." />
      {keys.isLoading || customers.isLoading ? (
        <SkeletonRows />
      ) : keys.isError || customers.isError ? (
        <ErrorPanel message="Failed to load pricing." onRetry={() => { keys.refetch(); customers.refetch(); }} />
      ) : !keys.data || keys.data.length === 0 ? (
        <EmptyState title="No price keys" description="No pricing profiles on file yet." />
      ) : (
        <div className="space-y-6">
          {keys.data.map((k) => (
            <PriceKeySection key={k.id} priceKey={k}
              customerCount={(customers.data ?? []).filter((c) => c.priceKeyId === k.id).length} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run components/setup/pricing-keys.test.tsx "app/(app)/setup/pricing" && npx tsc --noEmit`
Expected: ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add components/setup/pricing-keys.tsx components/setup/pricing-keys.test.tsx "app/(app)/setup/pricing/"
git commit -m "feat(setup): Pricing & Price Keys read view (first standalone pricing screen)"
```

---

### Task 7: Certifications & Forms view (`/setup/cert-defaults`)

**Files:**
- Create: `components/setup/cert-defaults.tsx`
- Test: `components/setup/cert-defaults.test.tsx`
- Create: `app/(app)/setup/cert-defaults/page.tsx`
- Test: `app/(app)/setup/cert-defaults/setup-cert-defaults-page.test.tsx`

**Interfaces:**
- Consumes: `useCustomers`, `useSpecifications` (existing); patterns.
- Produces: `export function CertDefaults({ customers, specifications }: { customers: Customer[]; specifications: Specification[] })`. Testid `cert-default-row-<customerId>` on the customer-name cell.

- [ ] **Step 1: Write the failing component test**

Create `components/setup/cert-defaults.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CertDefaults } from "./cert-defaults";
import type { Customer, Specification } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const SPECS = [
  { ...base, id: "spec-ams2759-3", code: "AMS 2759/3", title: "Carburize & harden", rev: "K", owner: "SAE" },
] as unknown as Specification[];
const CUSTOMERS = [
  { ...base, id: "cust-apex", name: "Apex Aerospace", defaultCertSpecId: "spec-ams2759-3", defaultCertCopies: 2 },
  { ...base, id: "cust-vulcan", name: "Vulcan Forge", defaultCertSpecId: null, defaultCertCopies: 0 },
  { ...base, id: "cust-delta", name: "Delta Gear Works", defaultCertSpecId: null, defaultCertCopies: 1 },
] as unknown as Customer[];

describe("CertDefaults", () => {
  it("resolves spec codes, dashes null specs, shows raw copies", () => {
    render(<CertDefaults customers={CUSTOMERS} specifications={SPECS} />);
    expect(screen.getByTestId("cert-default-row-cust-apex")).toHaveTextContent("Apex Aerospace");
    expect(screen.getByText("AMS 2759/3")).toBeInTheDocument();
    const vulcanRow = screen.getByTestId("cert-default-row-cust-vulcan").closest("tr")!;
    expect(Array.from(vulcanRow.querySelectorAll("td")).map((td) => td.textContent)).toEqual(["Vulcan Forge", "—", "0"]);
    // raw seed truth: copies can be nonzero with a null spec
    const deltaRow = screen.getByTestId("cert-default-row-cust-delta").closest("tr")!;
    expect(Array.from(deltaRow.querySelectorAll("td")).map((td) => td.textContent)).toEqual(["Delta Gear Works", "—", "1"]);
  });

  it("shows the formats/inserts framing note", () => {
    render(<CertDefaults customers={CUSTOMERS} specifications={SPECS} />);
    expect(screen.getByText("Cert formats and form / message inserts aren't modeled yet — customer defaults only.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/setup/cert-defaults.test.tsx`
Expected: FAIL — cannot resolve `./cert-defaults`.

- [ ] **Step 3: Implement the component**

Create `components/setup/cert-defaults.tsx`:

```tsx
import { ListCard, MonoId } from "@/components/patterns";
import type { Customer, Specification } from "@/lib/domain";

export function CertDefaults({ customers, specifications }: {
  customers: Customer[]; specifications: Specification[];
}) {
  const codeById = new Map(specifications.map((s) => [s.id, s.code]));
  return (
    <div className="space-y-3">
      <ListCard
        headers={["CUSTOMER", "DEFAULT CERT", "COPIES"]}
        rows={customers.map((c) => [
          <span key="n" data-testid={`cert-default-row-${c.id}`}>{c.name}</span>,
          c.defaultCertSpecId ? <MonoId key="s">{codeById.get(c.defaultCertSpecId) ?? c.defaultCertSpecId}</MonoId> : "—",
          <span key="c" className="font-mono">{c.defaultCertCopies}</span>,
        ])}
      />
      <p className="text-text-faint text-[11px]">Cert formats and form / message inserts aren&apos;t modeled yet — customer defaults only.</p>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/setup/cert-defaults.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing page-guard test**

Create `app/(app)/setup/cert-defaults/setup-cert-defaults-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupCertDefaultsPage from "./page";

const mockCustomers = vi.fn();
const mockSpecs = vi.fn();
vi.mock("@/lib/query/hooks", () => ({
  useCustomers: () => mockCustomers(),
  useSpecifications: () => mockSpecs(),
}));
vi.mock("@/components/setup/cert-defaults", () => ({
  CertDefaults: () => <div data-testid="cert-defaults" />,
}));

beforeEach(() => {
  mockCustomers.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockSpecs.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("SetupCertDefaultsPage guards", () => {
  it("renders skeleton while loading", () => {
    mockCustomers.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<SetupCertDefaultsPage />);
    expect(screen.queryByTestId("cert-defaults")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockSpecs.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<SetupCertDefaultsPage />);
    expect(screen.getByText("Failed to load cert defaults.")).toBeInTheDocument();
  });
  it("renders EmptyState when no customers", () => {
    render(<SetupCertDefaultsPage />);
    expect(screen.getByText("No customers")).toBeInTheDocument();
  });
  it("renders the view with data", () => {
    mockCustomers.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ id: "cust-apex", createdAt: "", updatedAt: "", version: 0, name: "Apex Aerospace", defaultCertSpecId: null, defaultCertCopies: 0 }],
    });
    render(<SetupCertDefaultsPage />);
    expect(screen.getByTestId("cert-defaults")).toBeInTheDocument();
    expect(screen.getByText("Certifications & Forms")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run "app/(app)/setup/cert-defaults/setup-cert-defaults-page.test.tsx"`
Expected: FAIL — cannot resolve `./page`.

- [ ] **Step 7: Implement the page**

Create `app/(app)/setup/cert-defaults/page.tsx`:

```tsx
"use client";
import { useCustomers, useSpecifications } from "@/lib/query/hooks";
import { DetailHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CertDefaults } from "@/components/setup/cert-defaults";

export default function SetupCertDefaultsPage() {
  const customers = useCustomers();
  const specs = useSpecifications();
  return (
    <div>
      <DetailHeader backHref="/setup" backLabel="Setup" title="Certifications & Forms"
        subtitle="Cert formats, defaults and form / message inserts." />
      {customers.isLoading || specs.isLoading ? (
        <SkeletonRows />
      ) : customers.isError || specs.isError ? (
        <ErrorPanel message="Failed to load cert defaults." onRetry={() => { customers.refetch(); specs.refetch(); }} />
      ) : !customers.data || customers.data.length === 0 ? (
        <EmptyState title="No customers" />
      ) : (
        <CertDefaults customers={customers.data} specifications={specs.data ?? []} />
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run components/setup/cert-defaults.test.tsx "app/(app)/setup/cert-defaults" && npx tsc --noEmit`
Expected: ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add components/setup/cert-defaults.tsx components/setup/cert-defaults.test.tsx "app/(app)/setup/cert-defaults/"
git commit -m "feat(setup): Certifications & Forms view — customer cert defaults (spec code resolved for the first time)"
```

---

### Task 8: E2E happy path + full gate

**Files:**
- Create: `tests/e2e/setup.spec.ts`

**Interfaces:**
- Consumes: testids from Tasks 4–6 (`setup-card-<key>`, `operator-limit-<id>`, `edit-limit-<id>`, `permission-row-<perm>`, `price-key-AERO-1`), dialog label `Quote limit ($)`, button `Save limit`. E2E auto-logs-in `op-dana` (manager) — `edit_setup` passes; no auth fixture exists or is needed.
- Produces: 9th e2e spec (2 tests → suite total 12).

- [ ] **Step 1: Write the spec**

Create `tests/e2e/setup.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("setup catalog drills into operators and edits a quote limit", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  for (const key of ["operators", "plant", "process-masters", "equipment", "pricing", "cert-defaults"]) {
    await expect(page.getByTestId(`setup-card-${key}`)).toBeVisible();
  }
  // exactly 5 live links; Plant Setup is inert (a div, not an anchor)
  await expect(page.locator('a[data-testid^="setup-card-"]')).toHaveCount(5);

  await page.getByTestId("setup-card-operators").click();
  await expect(page).toHaveURL(/\/setup\/operators$/);
  // Seed: op-dana $100,000 manager / op-vance $25,000 sales / op-office $0 office
  await expect(page.getByText("Dana Mercer")).toBeVisible();
  await expect(page.getByTestId("operator-limit-op-vance")).toHaveText("$25,000");
  await expect(page.getByTestId("permission-row-edit_setup")).toBeVisible();

  // The one write: raise Vance's limit (logged in as op-dana, manager → edit_setup granted)
  await page.getByTestId("edit-limit-op-vance").click();
  await page.getByLabel("Quote limit ($)").fill("30000");
  await page.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByTestId("operator-limit-op-vance")).toHaveText("$30,000");
});

test("pricing card shows the AERO-1 rules", async ({ page }) => {
  await page.goto("/setup");
  await page.getByTestId("setup-card-pricing").click();
  await expect(page).toHaveURL(/\/setup\/pricing$/);
  // Seed: pk-aero1 AERO-1, 4 rules; Temper per lot $1,440 is exact under whole-dollar formatMoney
  await expect(page.getByTestId("price-key-AERO-1")).toContainText("Carburize");
  await expect(page.getByTestId("price-key-AERO-1")).toContainText("$1,440");
  await expect(page.getByTestId("price-key-AERO-1")).toContainText("Used by 1 customer");
});
```

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test tests/e2e/setup.spec.ts`
Expected: 2 passed (dev server auto-starts per playwright.config.ts).

- [ ] **Step 3: Run the FULL verify gate (same order as CI)**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build && npm run test:e2e
```

Expected: tsc clean; lint 0 warnings; vitest all green (baseline 400 minus 1 deleted PlaceholderPage test plus ~19 new = ~418; verify the actual count and that ALL pass); build succeeds with `/setup` ○ static plus `/setup/operators`, `/setup/pricing`, `/setup/cert-defaults` ○ static; e2e 9 specs / 12 tests all green.

- [ ] **Step 4: Grep invariants**

```bash
grep -rn "new Date()" app/ components/ lib/ --include="*.ts" --include="*.tsx" | grep -v ".test."
grep -rn "PlaceholderPage" app/ components/ lib/ tests/
grep -rn "edit_setup" app/ components/ lib/ --include="*.ts" --include="*.tsx" | grep -v ".test."
```

Expected: (1) ONLY `components/shell/topbar.tsx`; (2) NOTHING; (3) hits in `lib/auth/permissions.ts` (definition) AND `app/(app)/setup/operators/page.tsx` (the spent permission) — no other call sites.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/setup.spec.ts
git commit -m "test(setup): e2e happy path — catalog links, quote-limit write, pricing drill-down"
```

---

## Self-review notes (already applied)

- **Spec coverage:** §1 grid+targets → T1/T4; §2 write+promotion → T3/T5; permission-matrix display + roleMeta → T2/T5; pricing view → T6; cert-defaults view → T7; PlaceholderPage deletion + stray dir → T4; e2e + gates + grep invariants → T8. Plant Setup inert → T1 (`href: null`) + T4 caption. No task for nav/palette/seed — deliberately zero changes (spec §2).
- **Type consistency:** `SETUP_CARDS`/`SetupCard` (T1→T4); `PERMISSIONS`/`MATRIX`/`permissionMeta`/`roleMeta` (T2→T5); `useSetOperatorQuoteLimit` vars `{ operator, quoteAuthLimitCents }` (T3→T5); `PricingKeyCard` props (T6 internal); testids consistent T4/T5/T6→T8.
- **Known-good pins:** operator seed values, AERO-1 rule cents, and cert-default seed pairs were read from `lib/data/seed/index.ts` first-hand during planning; `formatMoney` whole-dollar behavior verified against `lib/utils.ts`.

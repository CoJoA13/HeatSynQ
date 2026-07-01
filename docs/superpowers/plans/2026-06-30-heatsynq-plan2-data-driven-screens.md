# HeatSynQ Plan 2 — Data-Driven Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-heavy reference + dashboard screens on top of the Plan 1 foundation — Customers (list + tabbed detail), Parts (list + editor), Process Master (list + read-only detail), Specifications, Certifications, the Today dashboard (Manager/Sales/Office KPIs computed from the seed), placeholder pages for every remaining nav item, and live sidebar badge counts.

**Architecture:** Every screen is a thin `app/(app)/**/page.tsx` route (a client component that calls the Plan 1 TanStack Query hooks, handles `isLoading` / `isError` / empty, and delegates to a **pure presentational component** that receives already-fetched data via plain props). All KPI/aggregation math lives in a new pure module `lib/logic/dashboard.ts` (unit-tested against the real seed). The two write actions in this plan (Part save, Cert release) go through new `useMutation` hooks that call the existing `WriteRepo` interfaces and invalidate the relevant query keys. Nothing in `app/` or `components/` imports the mock or seed directly — the UI depends only on the async repository interfaces via the query hooks.

**Tech Stack:** Next.js 16 (App Router) + TypeScript, TanStack Query v5, react-hook-form + Zod, Radix-based shadcn UI primitives (`lib/ui/*`), Tailwind v4 tokens, Vitest + React Testing Library.

## Global Constraints

Copied verbatim from the spec, the Plan 1 conventions, and the memory carry-forwards. **Every task implicitly includes this section.**

- **Money is integer cents; dates are ISO 8601 strings.** Display money with `formatMoney(cents)` from `lib/utils` (whole-dollar, e.g. `842000 → "$8,420"`); display dates with `formatDate(iso)`.
- **IBM Plex Mono is the brand signature** for IDs, KPI numbers, timestamps, and status pills. Use `MonoId` for identifiers, `KpiTile` for KPI numbers (already mono), `StatusPill` for status (already mono 11px). For inline mono values (rev, counts, qty) use `className="font-mono"`.
- **Exact design tokens only.** Use the token classes wired in `app/globals.css` `@theme` (`bg-surface`, `border-border`, `text-text-muted`, `text-status-*`, `bg-status-*-tint`, `rounded-card`, `rounded-pill`, `rounded-modal`, `bg-canvas`, `bg-primary-tint`, `text-primary`, etc.). Canvas is `#f6f7f9`. Never hardcode hex.
- **No `any`.** Lint runs `eslint --max-warnings 0`. `@typescript-eslint/no-explicit-any` is enforced everywhere except the two approved mock-plumbing signatures in `lib/data/mock/repositories.ts` (do not add more). `no-unused-vars` is a **warning that fails CI** — prefix intentionally-unused identifiers with `_`.
- **UI depends only on the async repository interfaces via the query hooks.** Components and pages must not import from `lib/data/mock/*` or `lib/data/seed/*` (tests may). Data flows: `page.tsx` → query hook → presentational component props.
- **Next.js 16 dynamic routes:** the `params` prop is a `Promise`. In a client page, read it with React's `use`: `const { id } = use(params)` where the prop type is `{ params: Promise<{ id: string }> }`. Any page that calls a hook is `"use client"`.
- **Presentational components are pure** (plain-data props + callbacks, no data fetching). This is what makes them unit-testable without providers. `page.tsx` route files are thin glue and are covered by `tsc` + `build` (not unit-tested directly, except the two integration smoke tests explicitly called out).
- **Testing harness:** component tests that need query hooks/auth use `renderWithProviders` from `tests/utils.tsx` (Task 1). Tests for any component that renders `next/link` (i.e. anything using `DetailHeader`) must `vi.mock("next/link", ...)` with a passthrough anchor. Tests for pages that call `useRouter`/`usePathname` must `vi.mock("next/navigation", ...)` (see `components/shell/command-palette.test.tsx` for the established pattern). Presentational list components navigate via an `onSelect`/`onRelease` callback prop (a spy in tests) — never via `useRouter` inside the presentational component.
- **Frozen surfaces:** do not modify `lib/domain/*`, `lib/data/seed/*`, `lib/data/repositories/index.ts` (the interface), or the existing `lib/logic/*` files. The only Plan 1 files this plan edits are `lib/data/provider.tsx` (add an injectable `repositories` prop — Task 1), `lib/query/keys.ts` + `lib/query/hooks.ts` (add hooks — Tasks 1/9/10), `app/globals.css` (add one token — Task 1), and `app/(app)/layout.tsx` + `app/(app)/today/page.tsx` (Tasks 3/13).

### Verify Gate (run at the end of every task, in this order — matches CI `verify`)

```bash
npx tsc --noEmit                    # expect: no output (0 errors)
npm run lint -- --max-warnings 0    # expect: clean, 0 warnings
npm run test                        # expect: all test files pass
npm run build                       # expect: "Compiled successfully" / route list
```

A task is not done until all four are green. Then commit.

### Seed facts used for exact test expectations (as-of `2026-06-30T12:00:00.000Z`)

Derived from `lib/data/seed/index.ts`. These are the ground-truth numbers the dashboard/badge tests assert:

- Customers: 8 (apex active, vulcan hold, titan/delta/midwest/crane/summit active, ironclad dormant).
- Open quotes (status draft/sent/approve): **3** (`q-2841` approve, `q-2840` sent, `q-2835` sent). Awaiting approval: **1** (`q-2841`). Won: **2** (`q-2838`, `q-2828`). Open-quote total value: `842000 + 350000 + 64000 = 1_256_000` cents = **$12,560**.
- Open orders (status ≠ shipped): **7** (all seed WOs). Late (open & `due` < as-of): **2** (`wo-48142` due 06-28, `wo-48120` due 06-26). On-schedule %: `(7−2)/7 = 71.4`.
- Pending certs: **2** (`cert-9921`, `cert-9920`).
- Invoices: Open A/R (status sent) = `674000` (`inv-30412`) = **$6,740**. Past due (sent & not "current") = **$0** (`inv-30412` invoiced 06-27, 3 days old → current). To-bill count = **2** (`inv-summit-48120`, `inv-midwest-48177`), to-bill value = `418000 + 291000 = 709000` = **$7,090**. Invoiced MTD (June `invoicedDate`) = `674000 + 1_120_000 + 156_000 = 1_950_000` = **$19,500**.

---

## File Structure

**New — pure logic**
- `lib/logic/dashboard.ts` — all KPI/aggregation functions + `dashboardKpis(role, data, asOf)` + `navBadgeCounts(quotes, orders, certs)`. Pure, unit-tested against the seed.

**New — query layer (extends Plan 1)**
- `lib/query/keys.ts` (modify) — add `processMaster`, `contactsByCustomer`, `partsByCustomer`, `priceKeys`, `pricingRulesByPriceKey`.
- `lib/query/hooks.ts` (modify) — add read hooks (`useProcessMaster`, `useContactsByCustomer`, `usePartsByCustomer`, `usePriceKeys`, `usePricingRulesByPriceKey`, `useNavBadges`) + mutation hooks (`useUpdatePart`, `useReleaseCertification`).
- `lib/data/provider.tsx` (modify) — accept optional `repositories` prop for test injection.

**New — shell / foundation**
- `components/shell/app-shell-container.tsx` — client wrapper computing live badges → `AppShell`.
- `app/(app)/layout.tsx` (modify) — render `AppShellContainer`.
- `app/globals.css` (modify) — add `--radius-md: 9px` (Plan 1 UI-polish carry-forward).
- `components/patterns/placeholder-page.tsx` (+ export from `components/patterns/index.ts`) — shared "coming later" page.

**New — presentational components**
- `components/specifications/specifications-list.tsx`
- `components/process-masters/process-masters-list.tsx`, `.../process-master-detail.tsx`
- `components/parts/parts-list.tsx`, `.../part-editor.tsx`
- `components/certifications/certifications-list.tsx`
- `components/customers/customers-list.tsx`, `.../customer-detail.tsx`
- `components/today/today-dashboard.tsx`

**New — routes (`app/(app)/…/page.tsx`)**
- Live: `specifications`, `process-masters`, `process-masters/[id]`, `parts`, `parts/[id]`, `certifications`, `customers`, `customers/[id]`, `today` (rewrite).
- Placeholder (permanent "later phase"): `schedule`, `tracking`, `shop-floor`, `standards`, `reports`, `setup`.
- Placeholder (interim, replaced by Plan 3): `quotes`, `quotes/new`, `orders`, `invoicing`, `ar`.

**New — test harness**
- `tests/utils.tsx` — `renderWithProviders(ui, { repositories? })`.

### Faithful-interpretation notes (decisions baked into this plan)

- **On-Time %** is computed as *open orders on schedule ÷ open orders* (`71.4%` from seed) rather than a shipped-vs-due history, because the seed has no `shipped` work orders. Labeled "On-Time %" per the spec vocabulary; Plan 3 can refine to shipment history.
- **Documents tab** renders an `EmptyState` — the `Document` entity was not added to the domain in Plan 1, so there is no data source. This is faithful (Documents is out of scope for the foundation domain).
- **Customer Orders / A-R balance** are filtered client-side from `useWorkOrders()` / `useInvoices()` (repo-backed full-list hooks) because the repository interface exposes `byCustomer` only for `contacts` and `parts`. This still depends only on the repo interface; the interface itself is frozen this plan.
- **`asOf`** on the Today page is `new Date().toISOString()` (real clock, ≈ 2026-06-30 in the demo); pure functions take `asOf` as a parameter so tests stay deterministic.
- **Cert Release** action is manager-gated via the existing `useCan("release_cert")` and flips the cert to `released`; the ship-gate that consumes it is Plan 3.

---

## Task 1: Foundation extensions — query hooks, injectable repos, test harness, token fix

**Files:**
- Modify: `lib/data/provider.tsx`
- Modify: `lib/query/keys.ts`
- Modify: `lib/query/hooks.ts`
- Modify: `app/globals.css`
- Create: `tests/utils.tsx`
- Test: `tests/query-hooks.test.tsx`

**Interfaces:**
- Consumes: `Repositories` (`lib/data/repositories`), `createMockRepositories` (`lib/data/mock/repositories`), existing `queryKeys`, `useRepositories`.
- Produces:
  - `RepositoriesProvider({ children, repositories? }: { children: React.ReactNode; repositories?: Repositories })`
  - `queryKeys.processMaster(id)`, `queryKeys.contactsByCustomer(customerId)`, `queryKeys.partsByCustomer(customerId)`, `queryKeys.priceKeys`, `queryKeys.pricingRulesByPriceKey(priceKeyId)`
  - `useProcessMaster(id: string)`, `useContactsByCustomer(customerId: string)`, `usePartsByCustomer(customerId: string)`, `usePriceKeys()`, `usePricingRulesByPriceKey(priceKeyId: string)` — all return TanStack `UseQueryResult`
  - `renderWithProviders(ui: React.ReactNode, opts?: { repositories?: Repositories }): RenderResult`

- [ ] **Step 1: Add the injectable prop to `RepositoriesProvider`.** Replace the body of `lib/data/provider.tsx`:

```tsx
"use client";
import { createContext, useContext, useMemo } from "react";
import type { Repositories } from "@/lib/data/repositories";
import { createMockRepositories } from "@/lib/data/mock/repositories";

const Ctx = createContext<Repositories | null>(null);

export function RepositoriesProvider({
  children,
  repositories,
}: {
  children: React.ReactNode;
  repositories?: Repositories;
}) {
  const repos = useMemo(() => repositories ?? createMockRepositories(), [repositories]);
  return <Ctx.Provider value={repos}>{children}</Ctx.Provider>;
}

export function useRepositories(): Repositories {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRepositories must be used within RepositoriesProvider");
  return r;
}
```

- [ ] **Step 2: Add the new query keys.** In `lib/query/keys.ts`, add these entries inside the `queryKeys` object (keep the existing ones):

```ts
  processMaster: (id: string) => ["processMasters", id] as const,
  contactsByCustomer: (customerId: string) => ["contacts", "byCustomer", customerId] as const,
  partsByCustomer: (customerId: string) => ["parts", "byCustomer", customerId] as const,
  priceKeys: ["priceKeys"] as const,
  pricingRulesByPriceKey: (priceKeyId: string) => ["pricingRules", "byPriceKey", priceKeyId] as const,
```

- [ ] **Step 3: Add the new read hooks.** Append to `lib/query/hooks.ts` (the file already has `"use client"` and imports `useQuery`, `useRepositories`, `queryKeys`):

```ts
export function useProcessMaster(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.processMaster(id), queryFn: () => r.processMasters.get(id) }); }
export function useContactsByCustomer(customerId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.contactsByCustomer(customerId), queryFn: () => r.contacts.byCustomer(customerId) }); }
export function usePartsByCustomer(customerId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.partsByCustomer(customerId), queryFn: () => r.parts.byCustomer(customerId) }); }
export function usePriceKeys() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.priceKeys, queryFn: () => r.priceKeys.list() }); }
export function usePricingRulesByPriceKey(priceKeyId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.pricingRulesByPriceKey(priceKeyId), queryFn: () => r.pricingRules.byPriceKey(priceKeyId), enabled: priceKeyId !== "" }); }
```

- [ ] **Step 4: Add the `--radius-md` token (Plan 1 carry-forward).** In `app/globals.css`, inside the `@theme` block, add after `--radius-modal: 16px;`:

```css
  --radius-md: 9px;   /* Plan 1 follow-up: sizes button xs/sm/icon + select sm off square corners */
```

- [ ] **Step 5: Create the test harness `tests/utils.tsx`.**

```tsx
import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import type { Repositories } from "@/lib/data/repositories";

export function renderWithProviders(
  ui: ReactNode,
  opts: { repositories?: Repositories } = {},
): RenderResult {
  const repositories = opts.repositories ?? createMockRepositories({ latencyMs: 0 });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RepositoriesProvider repositories={repositories}>
        <AuthProvider>{ui}</AuthProvider>
      </RepositoriesProvider>
    </QueryClientProvider>,
  );
}
```

- [ ] **Step 6: Write the failing test `tests/query-hooks.test.tsx`.**

```tsx
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./utils";
import { useCustomers, usePricingRulesByPriceKey } from "@/lib/query/hooks";

function CustomerProbe() {
  const q = useCustomers();
  return <div>{q.data ? `count:${q.data.length}` : "loading"}</div>;
}
function RulesProbe() {
  const q = usePricingRulesByPriceKey("pk-aero1");
  return <div>{q.data ? `rules:${q.data.length}` : "loading"}</div>;
}

describe("query hooks + test harness", () => {
  it("wires injected repositories through the read hooks", async () => {
    renderWithProviders(<CustomerProbe />);
    expect(await screen.findByText("count:8")).toBeInTheDocument();
  });
  it("resolves pricing rules by price key", async () => {
    renderWithProviders(<RulesProbe />);
    expect(await screen.findByText("rules:4")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails.**

Run: `npx vitest run tests/query-hooks.test.tsx`
Expected: FAIL — `usePricingRulesByPriceKey` / harness not yet importable, or assertion mismatch, before Steps 1–5 are saved. (If you did Steps 1–5 first, this passes; the point is the test exercises the new surface.)

- [ ] **Step 8: Run the test to verify it passes.**

Run: `npx vitest run tests/query-hooks.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 9: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add lib/data/provider.tsx lib/query/keys.ts lib/query/hooks.ts app/globals.css tests/utils.tsx tests/query-hooks.test.tsx
git commit -m "feat(query): add reference read hooks, injectable repos, test harness, radius-md token"
```

---

## Task 2: Dashboard + badge pure logic (`lib/logic/dashboard.ts`)

**Files:**
- Create: `lib/logic/dashboard.ts`
- Test: `lib/logic/dashboard.test.ts`

**Interfaces:**
- Consumes: domain types (`WorkOrder`, `Quote`, `Invoice`, `Certification`, `RoleKey`, `QuoteStatus`, `StatusTone`), `quoteTotalCents` (`./pricing`), `agingBucket` (`./ar`), `formatMoney` (`@/lib/utils`), `buildSeed` (`@/lib/data/seed`, test only).
- Produces:
  - `openOrders(orders): WorkOrder[]`, `isLate(order, asOf): boolean`, `lateOrders(orders, asOf): WorkOrder[]`, `onSchedulePct(orders, asOf): number`
  - `openQuotes(quotes): Quote[]`, `awaitingApprovalCount(quotes): number`, `openQuoteValueCents(quotes): number`, `wonQuotesCount(quotes): number`
  - `certsAwaitingRelease(certs): number`
  - `openArCents(invoices): number`, `pastDueCents(invoices, asOf): number`, `toBillCount(invoices): number`, `toBillCents(invoices): number`, `invoicedMtdCents(invoices, asOf): number`
  - `type KpiDescriptor = { label: string; value: string; sub?: string; tone?: StatusTone }`
  - `type DashboardData = { orders: WorkOrder[]; quotes: Quote[]; invoices: Invoice[]; certifications: Certification[] }`
  - `dashboardKpis(role: RoleKey, data: DashboardData, asOf: string): KpiDescriptor[]`
  - `navBadgeCounts(quotes: Quote[], orders: WorkOrder[], certs: Certification[]): Record<string, number>`

- [ ] **Step 1: Write the failing test `lib/logic/dashboard.test.ts`.**

```ts
import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import {
  openOrders, lateOrders, onSchedulePct,
  openQuotes, awaitingApprovalCount, openQuoteValueCents, wonQuotesCount,
  certsAwaitingRelease, openArCents, pastDueCents, toBillCount, toBillCents, invoicedMtdCents,
  dashboardKpis, navBadgeCounts,
} from "./dashboard";

const s = buildSeed();
const asOf = "2026-06-30T12:00:00.000Z";
const byLabel = (tiles: { label: string; value: string }[]) =>
  Object.fromEntries(tiles.map((t) => [t.label, t.value]));

describe("dashboard order metrics", () => {
  it("counts open and late orders and on-schedule %", () => {
    expect(openOrders(s.workOrders).length).toBe(7);
    expect(lateOrders(s.workOrders, asOf).length).toBe(2);
    expect(onSchedulePct(s.workOrders, asOf)).toBe(71.4);
  });
});

describe("dashboard quote metrics", () => {
  it("counts open quotes, awaiting approval, value, and wins", () => {
    expect(openQuotes(s.quotes).length).toBe(3);
    expect(awaitingApprovalCount(s.quotes)).toBe(1);
    expect(openQuoteValueCents(s.quotes)).toBe(1_256_000);
    expect(wonQuotesCount(s.quotes)).toBe(2);
  });
});

describe("dashboard finance + cert metrics", () => {
  it("computes AR, to-bill, invoiced MTD and pending certs", () => {
    expect(certsAwaitingRelease(s.certifications)).toBe(2);
    expect(openArCents(s.invoices)).toBe(674_000);
    expect(pastDueCents(s.invoices, asOf)).toBe(0);
    expect(toBillCount(s.invoices)).toBe(2);
    expect(toBillCents(s.invoices)).toBe(709_000);
    expect(invoicedMtdCents(s.invoices, asOf)).toBe(1_950_000);
  });
});

describe("dashboardKpis by role", () => {
  const data = { orders: s.workOrders, quotes: s.quotes, invoices: s.invoices, certifications: s.certifications };
  it("manager tiles", () => {
    const t = byLabel(dashboardKpis("manager", data, asOf));
    expect(t["Open Orders"]).toBe("7");
    expect(t["Late Orders"]).toBe("2");
    expect(t["On-Time %"]).toBe("71.4");
    expect(t["Certs Awaiting Release"]).toBe("2");
    expect(t["Open A/R"]).toBe("$6,740");
    expect(t["Invoiced MTD"]).toBe("$19,500");
  });
  it("sales tiles", () => {
    const t = byLabel(dashboardKpis("sales", data, asOf));
    expect(t["Open Quotes"]).toBe("3");
    expect(t["Awaiting Approval"]).toBe("1");
    expect(t["Open Quote Value"]).toBe("$12,560");
    expect(t["Won Quotes"]).toBe("2");
  });
  it("office tiles", () => {
    const t = byLabel(dashboardKpis("office", data, asOf));
    expect(t["Open A/R"]).toBe("$6,740");
    expect(t["Past Due"]).toBe("$0");
    expect(t["To-bill"]).toBe("2");
    expect(t["Invoiced MTD"]).toBe("$19,500");
  });
});

describe("navBadgeCounts", () => {
  it("computes live sidebar counts", () => {
    expect(navBadgeCounts(s.quotes, s.workOrders, s.certifications)).toEqual({
      quotes: 3, orders: 7, certifications: 2,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run lib/logic/dashboard.test.ts`
Expected: FAIL — `Cannot find module './dashboard'`.

- [ ] **Step 3: Implement `lib/logic/dashboard.ts`.**

```ts
import type {
  WorkOrder, Quote, Invoice, Certification, RoleKey, QuoteStatus,
} from "@/lib/domain";
import type { StatusTone } from "@/lib/domain/enums";
import { quoteTotalCents } from "./pricing";
import { agingBucket } from "./ar";
import { formatMoney } from "@/lib/utils";

const OPEN_QUOTE_STATUSES: QuoteStatus[] = ["draft", "sent", "approve"];

// --- orders ---
export function openOrders(orders: WorkOrder[]): WorkOrder[] {
  return orders.filter((o) => o.status !== "shipped");
}
export function isLate(order: WorkOrder, asOf: string): boolean {
  return order.status !== "shipped" && new Date(order.due).getTime() < new Date(asOf).getTime();
}
export function lateOrders(orders: WorkOrder[], asOf: string): WorkOrder[] {
  return orders.filter((o) => isLate(o, asOf));
}
export function onSchedulePct(orders: WorkOrder[], asOf: string): number {
  const open = openOrders(orders);
  if (open.length === 0) return 100;
  const onTime = open.length - lateOrders(orders, asOf).length;
  return Math.round((onTime / open.length) * 1000) / 10;
}

// --- quotes ---
export function openQuotes(quotes: Quote[]): Quote[] {
  return quotes.filter((q) => OPEN_QUOTE_STATUSES.includes(q.status));
}
export function awaitingApprovalCount(quotes: Quote[]): number {
  return quotes.filter((q) => q.status === "approve").length;
}
export function openQuoteValueCents(quotes: Quote[]): number {
  return openQuotes(quotes).reduce((sum, q) => sum + quoteTotalCents(q), 0);
}
export function wonQuotesCount(quotes: Quote[]): number {
  return quotes.filter((q) => q.status === "won").length;
}

// --- certs ---
export function certsAwaitingRelease(certs: Certification[]): number {
  return certs.filter((c) => c.status === "pending").length;
}

// --- finance ---
export function openArCents(invoices: Invoice[]): number {
  return invoices.filter((i) => i.status === "sent").reduce((s, i) => s + i.amountCents, 0);
}
export function pastDueCents(invoices: Invoice[], asOf: string): number {
  return invoices
    .filter((i) => i.status === "sent" && agingBucket(i, asOf) !== "current")
    .reduce((s, i) => s + i.amountCents, 0);
}
export function toBillCount(invoices: Invoice[]): number {
  return invoices.filter((i) => i.status === "to_bill").length;
}
export function toBillCents(invoices: Invoice[]): number {
  return invoices.filter((i) => i.status === "to_bill").reduce((s, i) => s + i.amountCents, 0);
}
function sameMonth(iso: string, asOf: string): boolean {
  const a = new Date(iso), b = new Date(asOf);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}
export function invoicedMtdCents(invoices: Invoice[], asOf: string): number {
  return invoices
    .filter((i) => i.invoicedDate != null && sameMonth(i.invoicedDate, asOf))
    .reduce((s, i) => s + i.amountCents, 0);
}

// --- assembly ---
export type KpiDescriptor = { label: string; value: string; sub?: string; tone?: StatusTone };
export type DashboardData = {
  orders: WorkOrder[]; quotes: Quote[]; invoices: Invoice[]; certifications: Certification[];
};

export function dashboardKpis(role: RoleKey, data: DashboardData, asOf: string): KpiDescriptor[] {
  const { orders, quotes, invoices, certifications } = data;
  if (role === "sales") {
    return [
      { label: "Open Quotes", value: String(openQuotes(quotes).length) },
      { label: "Awaiting Approval", value: String(awaitingApprovalCount(quotes)), tone: "warn" },
      { label: "Open Quote Value", value: formatMoney(openQuoteValueCents(quotes)) },
      { label: "Won Quotes", value: String(wonQuotesCount(quotes)) },
    ];
  }
  if (role === "office") {
    return [
      { label: "Open A/R", value: formatMoney(openArCents(invoices)) },
      { label: "Past Due", value: formatMoney(pastDueCents(invoices, asOf)), tone: "danger" },
      { label: "To-bill", value: String(toBillCount(invoices)), sub: formatMoney(toBillCents(invoices)) },
      { label: "Invoiced MTD", value: formatMoney(invoicedMtdCents(invoices, asOf)) },
    ];
  }
  // manager (default)
  const late = lateOrders(orders, asOf).length;
  return [
    { label: "Open Orders", value: String(openOrders(orders).length), sub: `${late} late` },
    { label: "Late Orders", value: String(late), tone: "danger" },
    { label: "On-Time %", value: String(onSchedulePct(orders, asOf)), sub: "of open orders" },
    { label: "Certs Awaiting Release", value: String(certsAwaitingRelease(certifications)), sub: "blocking ship" },
    { label: "Open A/R", value: formatMoney(openArCents(invoices)) },
    { label: "Invoiced MTD", value: formatMoney(invoicedMtdCents(invoices, asOf)) },
  ];
}

export function navBadgeCounts(
  quotes: Quote[], orders: WorkOrder[], certs: Certification[],
): Record<string, number> {
  return {
    quotes: openQuotes(quotes).length,
    orders: openOrders(orders).length,
    certifications: certsAwaitingRelease(certs),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run lib/logic/dashboard.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add lib/logic/dashboard.ts lib/logic/dashboard.test.ts
git commit -m "feat(logic): add dashboard KPI + nav-badge pure functions"
```

---

## Task 3: Live sidebar badges (`useNavBadges` + AppShellContainer + layout)

**Files:**
- Modify: `lib/query/hooks.ts`
- Create: `components/shell/app-shell-container.tsx`
- Modify: `app/(app)/layout.tsx`
- Test: `tests/nav-badges.test.tsx`

**Interfaces:**
- Consumes: `useQuotes`, `useWorkOrders`, `useCertifications` (existing hooks), `navBadgeCounts` (Task 2), `AppShell` (`components/shell/app-shell`).
- Produces: `useNavBadges(): Record<string, number>`; `AppShellContainer({ children }: { children: React.ReactNode })`.

- [ ] **Step 1: Add `useNavBadges` to `lib/query/hooks.ts`.** Add the import at the top (next to the others) and the hook at the bottom:

```ts
import { navBadgeCounts } from "@/lib/logic/dashboard";
```

```ts
export function useNavBadges(): Record<string, number> {
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const certs = useCertifications();
  if (!quotes.data || !orders.data || !certs.data) return {};
  return navBadgeCounts(quotes.data, orders.data, certs.data);
}
```

- [ ] **Step 2: Create `components/shell/app-shell-container.tsx`.**

```tsx
"use client";
import { AppShell } from "./app-shell";
import { useNavBadges } from "@/lib/query/hooks";

export function AppShellContainer({ children }: { children: React.ReactNode }) {
  const badges = useNavBadges();
  return <AppShell badges={badges}>{children}</AppShell>;
}
```

- [ ] **Step 3: Point the app layout at the container.** Replace `app/(app)/layout.tsx`:

```tsx
import { AppShellContainer } from "@/components/shell/app-shell-container";
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShellContainer>{children}</AppShellContainer>;
}
```

- [ ] **Step 4: Write the failing test `tests/nav-badges.test.tsx`.** Probe the hook (avoids rendering the whole shell):

```tsx
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./utils";
import { useNavBadges } from "@/lib/query/hooks";

function BadgeProbe() {
  const b = useNavBadges();
  return <div>{Object.keys(b).length ? `q${b.quotes}-o${b.orders}-c${b.certifications}` : "loading"}</div>;
}

describe("useNavBadges", () => {
  it("computes live counts from the seed", async () => {
    renderWithProviders(<BadgeProbe />);
    expect(await screen.findByText("q3-o7-c2")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails, then passes.**

Run: `npx vitest run tests/nav-badges.test.tsx`
Expected: FAIL before Step 1 (`useNavBadges` undefined), PASS after.

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add lib/query/hooks.ts components/shell/app-shell-container.tsx app/\(app\)/layout.tsx tests/nav-badges.test.tsx
git commit -m "feat(shell): wire live nav badge counts into the sidebar"
```

---

## Task 4: Placeholder pages (shared component + every remaining nav route)

**Files:**
- Create: `components/patterns/placeholder-page.tsx`
- Modify: `components/patterns/index.ts`
- Create: `app/(app)/schedule/page.tsx`, `app/(app)/tracking/page.tsx`, `app/(app)/shop-floor/page.tsx`, `app/(app)/standards/page.tsx`, `app/(app)/reports/page.tsx`, `app/(app)/setup/page.tsx`
- Create (interim, Plan 3 replaces): `app/(app)/quotes/page.tsx`, `app/(app)/quotes/new/page.tsx`, `app/(app)/orders/page.tsx`, `app/(app)/invoicing/page.tsx`, `app/(app)/ar/page.tsx`
- Test: `components/patterns/placeholder-page.test.tsx`

**Interfaces:**
- Consumes: `EmptyState` (`./empty-state`).
- Produces: `PlaceholderPage({ title, note }: { title: string; note?: string })`.

- [ ] **Step 1: Write the failing test `components/patterns/placeholder-page.test.tsx`.**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlaceholderPage } from "./placeholder-page";

describe("PlaceholderPage", () => {
  it("renders the title and a later-phase empty state", () => {
    render(<PlaceholderPage title="Schedule" note="Equipment load scheduling arrives later." />);
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByText("Coming in a later phase")).toBeInTheDocument();
    expect(screen.getByText("Equipment load scheduling arrives later.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/patterns/placeholder-page.test.tsx`
Expected: FAIL — `Cannot find module './placeholder-page'`.

- [ ] **Step 3: Implement `components/patterns/placeholder-page.tsx`.**

```tsx
import { EmptyState } from "./empty-state";
export function PlaceholderPage({ title, note }: { title: string; note?: string }) {
  return (
    <div>
      <h1 className="mb-5 text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
      <EmptyState title="Coming in a later phase" description={note ?? `${title} isn't part of this build yet.`} />
    </div>
  );
}
```

- [ ] **Step 4: Export it from `components/patterns/index.ts`.** Add:

```ts
export * from "./placeholder-page";
```

- [ ] **Step 5: Create the six permanent placeholder routes.** Each is one file, e.g. `app/(app)/schedule/page.tsx`:

```tsx
import { PlaceholderPage } from "@/components/patterns";
export default function SchedulePage() {
  return <PlaceholderPage title="Schedule" note="Weekly equipment-load scheduling arrives in a later phase." />;
}
```

Repeat with these exact titles/notes:
- `app/(app)/tracking/page.tsx` → `title="Tracking"` note `"Scan-driven shop-floor tracking arrives in a later phase."`
- `app/(app)/shop-floor/page.tsx` → `title="Shop Floor"` note `"Live furnace/equipment status arrives in a later phase."`
- `app/(app)/standards/page.tsx` → `title="Standards"` note `"The quality-standards library arrives in a later phase."`
- `app/(app)/reports/page.tsx` → `title="Reports"` note `"Reporting dashboards arrive in a later phase."`
- `app/(app)/setup/page.tsx` → `title="Setup"` note `"Configuration & administration arrive in a later phase."`

- [ ] **Step 6: Create the five interim (Plan 3) placeholder routes.** Same shape; note that they are the next phase, e.g. `app/(app)/quotes/page.tsx`:

```tsx
import { PlaceholderPage } from "@/components/patterns";
export default function QuotesPage() {
  return <PlaceholderPage title="Quotes" note="The Quote → Order → Invoice workflow is built in the next phase." />;
}
```

Repeat with:
- `app/(app)/quotes/new/page.tsx` → `QuoteBuilderPage`, `title="New quote"` note `"The quote builder is built in the next phase."`
- `app/(app)/orders/page.tsx` → `OrdersPage`, `title="Orders"` note `"The Quote → Order → Invoice workflow is built in the next phase."`
- `app/(app)/invoicing/page.tsx` → `InvoicingPage`, `title="Invoicing"` note `"Invoicing is built in the next phase."`
- `app/(app)/ar/page.tsx` → `ArPage`, `title="A/R"` note `"Accounts-receivable aging is built in the next phase."`

- [ ] **Step 7: Run the placeholder test to verify it passes.**

Run: `npx vitest run components/patterns/placeholder-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full Verify Gate (confirms all 11 new routes build with no dead nav links), then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/patterns/placeholder-page.tsx components/patterns/placeholder-page.test.tsx components/patterns/index.ts "app/(app)/schedule" "app/(app)/tracking" "app/(app)/shop-floor" "app/(app)/standards" "app/(app)/reports" "app/(app)/setup" "app/(app)/quotes" "app/(app)/orders" "app/(app)/invoicing" "app/(app)/ar"
git commit -m "feat(shell): add placeholder pages for every remaining nav route"
```

---

## Task 5: Specifications list (`/specifications`)

**Files:**
- Create: `components/specifications/specifications-list.tsx`
- Create: `app/(app)/specifications/page.tsx`
- Test: `components/specifications/specifications-list.test.tsx`

**Interfaces:**
- Consumes: `Specification` (domain), `ListCard`, `MonoId` (patterns), `useSpecifications` (hooks).
- Produces: `SpecificationsList({ specifications }: { specifications: Specification[] })`.

- [ ] **Step 1: Write the failing test `components/specifications/specifications-list.test.tsx`.**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpecificationsList } from "./specifications-list";
import type { Specification } from "@/lib/domain";

const specs: Specification[] = [
  { id: "s1", createdAt: "", updatedAt: "", version: 0, code: "AMS 2759/3", title: "Carburize & harden", rev: "K", owner: "SAE" },
  { id: "s2", createdAt: "", updatedAt: "", version: 0, code: "MIL-S-6090", title: "Bearing steels", rev: "A", owner: "DoD" },
];

describe("SpecificationsList", () => {
  it("renders spec code, title and owner", () => {
    render(<SpecificationsList specifications={specs} />);
    expect(screen.getByText("AMS 2759/3")).toBeInTheDocument();
    expect(screen.getByText("Carburize & harden")).toBeInTheDocument();
    expect(screen.getByText("DoD")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/specifications/specifications-list.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/specifications/specifications-list.tsx`.**

```tsx
import { ListCard, MonoId } from "@/components/patterns";
import type { Specification } from "@/lib/domain";

export function SpecificationsList({ specifications }: { specifications: Specification[] }) {
  return (
    <ListCard
      headers={["SPEC", "TITLE", "REV", "OWNER"]}
      rows={specifications.map((s) => [
        <MonoId key="code">{s.code}</MonoId>,
        s.title,
        <span key="rev" className="font-mono">{s.rev}</span>,
        s.owner,
      ])}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run components/specifications/specifications-list.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create the route `app/(app)/specifications/page.tsx`.**

```tsx
"use client";
import { useSpecifications } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { SpecificationsList } from "@/components/specifications/specifications-list";

export default function SpecificationsPage() {
  const { data, isLoading, isError, refetch } = useSpecifications();
  return (
    <div>
      <PageHeader title="Specifications" subtitle="Quality & industry specs referenced by parts and certs." />
      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorPanel message="Failed to load specifications." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No specifications" description="No specifications on file yet." />
      ) : (
        <SpecificationsList specifications={data} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/specifications "app/(app)/specifications"
git commit -m "feat(specifications): add specifications reference list screen"
```

---

## Task 6: Process Master list (`/process-masters`)

**Files:**
- Create: `components/process-masters/process-masters-list.tsx`
- Create: `app/(app)/process-masters/page.tsx`
- Test: `components/process-masters/process-masters-list.test.tsx`

**Interfaces:**
- Consumes: `ProcessMaster` (domain), `ListCard`, `MonoId`, `StatusPill` (patterns), `useProcessMasters`, `useRouter`.
- Produces: `ProcessMastersList({ processMasters, onSelect }: { processMasters: ProcessMaster[]; onSelect?: (id: string) => void })`.

- [ ] **Step 1: Write the failing test `components/process-masters/process-masters-list.test.tsx`.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcessMastersList } from "./process-masters-list";
import type { ProcessMaster } from "@/lib/domain";

const pm: ProcessMaster = {
  id: "pm-carb58", createdAt: "", updatedAt: "", version: 0, code: "PM-CARB-58",
  name: "Carburize & temper", description: "Case hardened", rev: "C", status: "active",
  surfaceHardness: "Rc 58-62", caseDepth: ".020-.030 in", hardnessScale: "Rockwell C",
  steps: [
    { n: 1, op: "Receive & verify", equip: "Receiving", instr: "", params: [], track: "track_in" },
    { n: 2, op: "Carburize", equip: "Batch IQ #3", instr: "", params: ["1700°F"], track: "track_in_out" },
  ],
};

describe("ProcessMastersList", () => {
  it("renders code, step count and status, and fires row select", async () => {
    const onSelect = vi.fn();
    render(<ProcessMastersList processMasters={[pm]} onSelect={onSelect} />);
    expect(screen.getByText("PM-CARB-58")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // step count
    expect(screen.getByText("Active")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Carburize & temper"));
    expect(onSelect).toHaveBeenCalledWith("pm-carb58");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/process-masters/process-masters-list.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/process-masters/process-masters-list.tsx`.**

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import type { ProcessMaster } from "@/lib/domain";

export function ProcessMastersList({
  processMasters,
  onSelect,
}: {
  processMasters: ProcessMaster[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ListCard
      headers={["PROCESS MASTER", "NAME", "REV", "STEPS", "SURFACE", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(processMasters[i].id) : undefined}
      rows={processMasters.map((pm) => [
        <MonoId key="code">{pm.code}</MonoId>,
        pm.name,
        <span key="rev" className="font-mono">{pm.rev}</span>,
        <span key="steps" className="font-mono">{pm.steps.length}</span>,
        pm.surfaceHardness,
        <StatusPill key="status" tone="success">Active</StatusPill>,
      ])}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run components/process-masters/process-masters-list.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create the route `app/(app)/process-masters/page.tsx`.**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useProcessMasters } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { ProcessMastersList } from "@/components/process-masters/process-masters-list";

export default function ProcessMastersPage() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useProcessMasters();
  return (
    <div>
      <PageHeader title="Process Master" subtitle="Rev-controlled recipes that drive the traveler." />
      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorPanel message="Failed to load process masters." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No process masters" />
      ) : (
        <ProcessMastersList processMasters={data} onSelect={(id) => router.push(`/process-masters/${id}`)} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/process-masters "app/(app)/process-masters/page.tsx"
git commit -m "feat(process-masters): add process master list screen"
```

---

## Task 7: Process Master read-only detail (`/process-masters/[id]`)

**Files:**
- Create: `components/process-masters/process-master-detail.tsx`
- Create: `app/(app)/process-masters/[id]/page.tsx`
- Test: `components/process-masters/process-master-detail.test.tsx`

**Interfaces:**
- Consumes: `ProcessMaster`, `Part` (domain), `DetailHeader`, `StatusPill`, `MonoId`, `ListCard`, `SummaryRail`, `EmptyState` (patterns), `useProcessMaster`, `useParts`.
- Produces: `ProcessMasterDetail({ processMaster, usedByParts }: { processMaster: ProcessMaster; usedByParts: Part[] })`.

- [ ] **Step 1: Write the failing test `components/process-masters/process-master-detail.test.tsx`.** (Mock `next/link` because `DetailHeader` renders it.)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessMasterDetail } from "./process-master-detail";
import type { ProcessMaster, Part } from "@/lib/domain";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

const pm: ProcessMaster = {
  id: "pm-carb58", createdAt: "", updatedAt: "", version: 0, code: "PM-CARB-58",
  name: "Carburize & temper", description: "Case hardened, Rc 58-62", rev: "C", status: "active",
  surfaceHardness: "Rc 58-62", caseDepth: ".020-.030 in", hardnessScale: "Rockwell C",
  steps: [{ n: 3, op: "Carburize", equip: "Batch IQ #3", instr: "", params: ["1700°F", "8.0 hr"], track: "track_in_out" }],
};
const part: Part = {
  id: "part-ts4471", createdAt: "", updatedAt: "", version: 0, partNumber: "TS-4471",
  description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C",
  hardness: "Rc 58-62", caseDepth: ".020-.030 in", specificationId: null, processMasterId: "pm-carb58",
  priceKeyId: null, inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot",
};

describe("ProcessMasterDetail", () => {
  it("renders header, steps, inspection and used-by parts", () => {
    render(<ProcessMasterDetail processMaster={pm} usedByParts={[part]} />);
    expect(screen.getByText("PM-CARB-58")).toBeInTheDocument();
    expect(screen.getByText("Carburize")).toBeInTheDocument();
    expect(screen.getByText("1700°F · 8.0 hr")).toBeInTheDocument();
    expect(screen.getByText("Rc 58-62")).toBeInTheDocument();
    expect(screen.getByText("TS-4471")).toBeInTheDocument();
  });
  it("shows an empty state when no parts use the recipe", () => {
    render(<ProcessMasterDetail processMaster={pm} usedByParts={[]} />);
    expect(screen.getByText("No parts use this recipe")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/process-masters/process-master-detail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/process-masters/process-master-detail.tsx`.**

```tsx
import { DetailHeader, StatusPill, MonoId, ListCard, SummaryRail, EmptyState } from "@/components/patterns";
import type { ProcessMaster, Part } from "@/lib/domain";

const TRACK_LABEL: Record<string, string> = {
  track_in: "Track in", track_in_out: "Track in-out", track_out: "Track out", inspect: "Inspect", none: "—",
};

export function ProcessMasterDetail({
  processMaster: pm,
  usedByParts,
}: {
  processMaster: ProcessMaster;
  usedByParts: Part[];
}) {
  return (
    <div>
      <DetailHeader
        backHref="/process-masters"
        backLabel="Process Master"
        title={<span className="flex items-center gap-2"><MonoId>{pm.code}</MonoId><span>{pm.name}</span></span>}
        subtitle={pm.description}
        statusPill={<StatusPill tone="success">Active · rev {pm.rev}</StatusPill>}
      />
      <div className="grid grid-cols-[1fr_260px] gap-6">
        <div className="space-y-6">
          <div>
            <div className="mb-2 font-semibold">Steps</div>
            <ListCard
              headers={["#", "OPERATION", "WORK CENTER", "PARAMETERS", "TRACK"]}
              rows={pm.steps.map((s) => [
                <span key="n" className="font-mono">{s.n}</span>,
                s.op,
                s.equip,
                s.params.length ? s.params.join(" · ") : "—",
                <span key="track" className="text-text-muted text-xs">{TRACK_LABEL[s.track] ?? "—"}</span>,
              ])}
            />
          </div>
          <div>
            <div className="mb-2 font-semibold">Used by</div>
            {usedByParts.length === 0 ? (
              <EmptyState title="No parts use this recipe" />
            ) : (
              <ListCard
                headers={["PART", "DESCRIPTION"]}
                rows={usedByParts.map((p) => [<MonoId key="p">{p.partNumber}</MonoId>, p.description])}
              />
            )}
          </div>
        </div>
        <SummaryRail title="Inspection">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between"><dt className="text-text-muted">Surface hardness</dt><dd className="font-mono">{pm.surfaceHardness}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Case depth</dt><dd className="font-mono">{pm.caseDepth}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Scale</dt><dd>{pm.hardnessScale}</dd></div>
          </dl>
        </SummaryRail>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run components/process-masters/process-master-detail.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Create the route `app/(app)/process-masters/[id]/page.tsx`.**

```tsx
"use client";
import { use } from "react";
import { useProcessMaster, useParts } from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { ProcessMasterDetail } from "@/components/process-masters/process-master-detail";

export default function ProcessMasterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pm = useProcessMaster(id);
  const parts = useParts();
  if (pm.isLoading || parts.isLoading) return <SkeletonRows />;
  if (pm.isError) return <ErrorPanel message="Failed to load process master." onRetry={() => pm.refetch()} />;
  if (!pm.data) return <EmptyState title="Process master not found" />;
  const usedBy = (parts.data ?? []).filter((p) => p.processMasterId === id);
  return <ProcessMasterDetail processMaster={pm.data} usedByParts={usedBy} />;
}
```

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/process-masters/process-master-detail.tsx components/process-masters/process-master-detail.test.tsx "app/(app)/process-masters/[id]"
git commit -m "feat(process-masters): add read-only process master detail screen"
```

---

## Task 8: Parts list (`/parts`)

**Files:**
- Create: `components/parts/parts-list.tsx`
- Create: `app/(app)/parts/page.tsx`
- Test: `components/parts/parts-list.test.tsx`

**Interfaces:**
- Consumes: `Part`, `ProcessMaster` (domain), `ListCard`, `MonoId` (patterns), `useParts`, `useProcessMasters`, `useRouter`.
- Produces: `PartsList({ parts, processMasters, onSelect }: { parts: Part[]; processMasters: ProcessMaster[]; onSelect?: (id: string) => void })`.

- [ ] **Step 1: Write the failing test `components/parts/parts-list.test.tsx`.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PartsList } from "./parts-list";
import type { Part, ProcessMaster } from "@/lib/domain";

const part: Part = {
  id: "part-ts4471", createdAt: "", updatedAt: "", version: 0, partNumber: "TS-4471",
  description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C",
  hardness: "Rc 58-62", caseDepth: ".020-.030 in", specificationId: null, processMasterId: "pm-carb58",
  priceKeyId: null, inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot",
};
const pm = { id: "pm-carb58", code: "PM-CARB-58" } as ProcessMaster;

describe("PartsList", () => {
  it("renders part number, material and resolved process-master code, and fires select", async () => {
    const onSelect = vi.fn();
    render(<PartsList parts={[part]} processMasters={[pm]} onSelect={onSelect} />);
    expect(screen.getByText("TS-4471")).toBeInTheDocument();
    expect(screen.getByText("4140 steel")).toBeInTheDocument();
    expect(screen.getByText("PM-CARB-58")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Turbine shaft"));
    expect(onSelect).toHaveBeenCalledWith("part-ts4471");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/parts/parts-list.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/parts/parts-list.tsx`.**

```tsx
import { ListCard, MonoId } from "@/components/patterns";
import type { Part, ProcessMaster } from "@/lib/domain";

export function PartsList({
  parts,
  processMasters,
  onSelect,
}: {
  parts: Part[];
  processMasters: ProcessMaster[];
  onSelect?: (id: string) => void;
}) {
  const pmById = new Map(processMasters.map((p) => [p.id, p]));
  return (
    <ListCard
      headers={["PART", "DESCRIPTION", "MATERIAL", "DWG", "HARDNESS", "PROCESS"]}
      onRowClick={onSelect ? (i) => onSelect(parts[i].id) : undefined}
      rows={parts.map((p) => [
        <MonoId key="pn">{p.partNumber}</MonoId>,
        p.description,
        p.material,
        <span key="dwg" className="font-mono">{p.drawingRev}</span>,
        p.hardness,
        p.processMasterId ? <MonoId key="pm">{pmById.get(p.processMasterId)?.code ?? "—"}</MonoId> : "—",
      ])}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run components/parts/parts-list.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create the route `app/(app)/parts/page.tsx`.**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useParts, useProcessMasters } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { PartsList } from "@/components/parts/parts-list";

export default function PartsPage() {
  const router = useRouter();
  const parts = useParts();
  const processMasters = useProcessMasters();
  return (
    <div>
      <PageHeader title="Part Maintenance" subtitle="Customer part records, specs and assigned recipes." />
      {parts.isLoading ? (
        <SkeletonRows />
      ) : parts.isError ? (
        <ErrorPanel message="Failed to load parts." onRetry={() => parts.refetch()} />
      ) : !parts.data || parts.data.length === 0 ? (
        <EmptyState title="No parts" />
      ) : (
        <PartsList parts={parts.data} processMasters={processMasters.data ?? []} onSelect={(id) => router.push(`/parts/${id}`)} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/parts/parts-list.tsx components/parts/parts-list.test.tsx "app/(app)/parts/page.tsx"
git commit -m "feat(parts): add part maintenance list screen"
```

---

## Task 9: Part editor + `useUpdatePart` mutation (`/parts/[id]`)

**Files:**
- Modify: `lib/query/hooks.ts` (add `useUpdatePart`; ensure `useMutation`, `useQueryClient`, `Part` imported)
- Create: `components/parts/part-editor.tsx`
- Create: `app/(app)/parts/[id]/page.tsx`
- Test: `components/parts/part-editor.test.tsx`

**Interfaces:**
- Consumes: `Part`, `Specification`, `ProcessMaster`, `PriceKey` (domain), `DetailHeader`, `FormField`, `ErrorSummary` (patterns), `Input`, `Button`, `Select*` (`lib/ui/*`), `usePart`, `useSpecifications`, `useProcessMasters`, `usePriceKeys`.
- Produces:
  - `partFormSchema` (Zod) + `type PartFormValues`
  - `PartEditor({ part, specifications, processMasters, priceKeys, onSave, saving, saved })`
  - `useUpdatePart()` → `UseMutationResult`, `mutate({ id, patch, version })` where `patch: Partial<Omit<Part, "id" | "createdAt" | "updatedAt" | "version">>`

- [ ] **Step 1: Add the `useUpdatePart` mutation to `lib/query/hooks.ts`.** Update the top import to include mutation utilities and the `Part` type, then add the hook:

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Part } from "@/lib/domain";
```

```ts
export function useUpdatePart() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Partial<Omit<Part, "id" | "createdAt" | "updatedAt" | "version">>;
      version: number;
    }) => r.parts.update(vars.id, vars.patch, vars.version),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: queryKeys.parts });
      qc.invalidateQueries({ queryKey: queryKeys.part(updated.id) });
      qc.invalidateQueries({ queryKey: queryKeys.partsByCustomer(updated.customerId) });
    },
  });
}
```

- [ ] **Step 2: Write the failing test `components/parts/part-editor.test.tsx`.** (Mock `next/link` for `DetailHeader`. Interact via text inputs only — do not open Radix selects in jsdom.)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PartEditor } from "./part-editor";
import type { Part } from "@/lib/domain";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

const part: Part = {
  id: "part-ts4471", createdAt: "", updatedAt: "", version: 3, partNumber: "TS-4471",
  description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C",
  hardness: "Rc 58-62", caseDepth: ".020-.030 in", specificationId: null, processMasterId: null,
  priceKeyId: null, inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot",
};

function setup(onSave = vi.fn()) {
  render(
    <PartEditor part={part} specifications={[]} processMasters={[]} priceKeys={[]}
      onSave={onSave} saving={false} saved={false} />,
  );
  return onSave;
}

describe("PartEditor", () => {
  it("prefills fields from the part", () => {
    setup();
    expect(screen.getByLabelText("Part number")).toHaveValue("TS-4471");
    expect(screen.getByLabelText("Material")).toHaveValue("4140 steel");
  });

  it("shows a validation error and disables save when a required field is empty", async () => {
    setup();
    const desc = screen.getByLabelText("Description");
    await userEvent.clear(desc);
    await userEvent.tab();
    expect(await screen.findByText("Description is required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save part/i })).toBeDisabled();
  });

  it("submits the edited values", async () => {
    const onSave = setup();
    const desc = screen.getByLabelText("Description");
    await userEvent.clear(desc);
    await userEvent.type(desc, "Turbine shaft rev C");
    await userEvent.click(screen.getByRole("button", { name: /save part/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ description: "Turbine shaft rev C", partNumber: "TS-4471" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `npx vitest run components/parts/part-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `components/parts/part-editor.tsx`.**

```tsx
"use client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { DetailHeader, FormField, ErrorSummary } from "@/components/patterns";
import { Input } from "@/lib/ui/input";
import { Button } from "@/lib/ui/button";
import { Label } from "@/lib/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/lib/ui/select";
import type { Part, Specification, ProcessMaster, PriceKey } from "@/lib/domain";

export const partFormSchema = z.object({
  partNumber: z.string().min(1, "Part number is required"),
  description: z.string().min(1, "Description is required"),
  material: z.string().min(1, "Material is required"),
  drawingRev: z.string(),
  hardness: z.string(),
  caseDepth: z.string(),
  specificationId: z.string().nullable(),
  processMasterId: z.string().nullable(),
  priceKeyId: z.string().nullable(),
  inspectionScale: z.string(),
  inspectionSample: z.string(),
});
export type PartFormValues = z.infer<typeof partFormSchema>;

const NONE = "__none__";

export function PartEditor({
  part,
  specifications,
  processMasters,
  priceKeys,
  onSave,
  saving,
  saved,
}: {
  part: Part;
  specifications: Specification[];
  processMasters: ProcessMaster[];
  priceKeys: PriceKey[];
  onSave: (values: PartFormValues) => void;
  saving: boolean;
  saved: boolean;
}) {
  const {
    register, handleSubmit, setValue, watch,
    formState: { errors, isValid },
  } = useForm<PartFormValues>({
    resolver: zodResolver(partFormSchema),
    mode: "onChange",
    defaultValues: {
      partNumber: part.partNumber, description: part.description, material: part.material,
      drawingRev: part.drawingRev, hardness: part.hardness, caseDepth: part.caseDepth,
      specificationId: part.specificationId, processMasterId: part.processMasterId, priceKeyId: part.priceKeyId,
      inspectionScale: part.inspectionScale, inspectionSample: part.inspectionSample,
    },
  });
  const errorList = Object.values(errors)
    .map((e) => e?.message)
    .filter((m): m is string => Boolean(m));

  return (
    <form onSubmit={handleSubmit(onSave)}>
      <DetailHeader
        backHref="/parts"
        backLabel="Part Maintenance"
        title={<span className="font-mono">{part.partNumber}</span>}
        subtitle="Edit part record"
        actions={<Button type="submit" disabled={!isValid || saving}>{saving ? "Saving…" : "Save part"}</Button>}
      />
      {saved && (
        <div className="mb-4 rounded-card border border-status-success-tint bg-status-success-tint/40 p-3 text-status-success text-xs">
          Part saved.
        </div>
      )}
      <ErrorSummary errors={errorList} />
      <div className="mt-4 grid grid-cols-2 gap-4 rounded-card border border-border bg-surface p-4">
        <FormField label="Part number" htmlFor="partNumber" error={errors.partNumber?.message}><Input id="partNumber" {...register("partNumber")} /></FormField>
        <FormField label="Description" htmlFor="description" error={errors.description?.message}><Input id="description" {...register("description")} /></FormField>
        <FormField label="Material" htmlFor="material" error={errors.material?.message}><Input id="material" {...register("material")} /></FormField>
        <FormField label="Drawing rev" htmlFor="drawingRev"><Input id="drawingRev" {...register("drawingRev")} /></FormField>
        <FormField label="Hardness" htmlFor="hardness"><Input id="hardness" {...register("hardness")} /></FormField>
        <FormField label="Case depth" htmlFor="caseDepth"><Input id="caseDepth" {...register("caseDepth")} /></FormField>
        <RefSelect label="Specification" value={watch("specificationId")} onChange={(v) => setValue("specificationId", v, { shouldValidate: true })} options={specifications.map((s) => ({ value: s.id, label: s.code }))} />
        <RefSelect label="Process master" value={watch("processMasterId")} onChange={(v) => setValue("processMasterId", v, { shouldValidate: true })} options={processMasters.map((p) => ({ value: p.id, label: p.code }))} />
        <RefSelect label="Price key" value={watch("priceKeyId")} onChange={(v) => setValue("priceKeyId", v, { shouldValidate: true })} options={priceKeys.map((k) => ({ value: k.id, label: k.code }))} />
        <FormField label="Inspection scale" htmlFor="inspectionScale"><Input id="inspectionScale" {...register("inspectionScale")} /></FormField>
        <FormField label="Inspection sample" htmlFor="inspectionSample"><Input id="inspectionSample" {...register("inspectionSample")} /></FormField>
      </div>
    </form>
  );
}

function RefSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger className="w-full"><SelectValue placeholder="None" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npx vitest run components/parts/part-editor.test.tsx`
Expected: PASS (3 tests). If `isValid` starts `false` on mount and the submit button is disabled before any interaction, note the test types into a field first — this is intentional and reflects real react-hook-form `onChange` behavior.

- [ ] **Step 6: Create the route `app/(app)/parts/[id]/page.tsx`.**

```tsx
"use client";
import { use, useState } from "react";
import { usePart, useSpecifications, useProcessMasters, usePriceKeys, useUpdatePart } from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { PartEditor, type PartFormValues } from "@/components/parts/part-editor";

export default function PartEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const part = usePart(id);
  const specs = useSpecifications();
  const processMasters = useProcessMasters();
  const priceKeys = usePriceKeys();
  const update = useUpdatePart();
  const [saved, setSaved] = useState(false);

  if (part.isLoading) return <SkeletonRows />;
  if (part.isError) return <ErrorPanel message="Failed to load part." onRetry={() => part.refetch()} />;
  if (!part.data) return <EmptyState title="Part not found" />;
  const p = part.data;

  return (
    <PartEditor
      part={p}
      specifications={specs.data ?? []}
      processMasters={processMasters.data ?? []}
      priceKeys={priceKeys.data ?? []}
      saving={update.isPending}
      saved={saved}
      onSave={(values: PartFormValues) => {
        setSaved(false);
        update.mutate({ id: p.id, patch: values, version: p.version }, { onSuccess: () => setSaved(true) });
      }}
    />
  );
}
```

- [ ] **Step 7: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add lib/query/hooks.ts components/parts/part-editor.tsx components/parts/part-editor.test.tsx "app/(app)/parts/[id]"
git commit -m "feat(parts): add part editor with update mutation and validation"
```

---

## Task 10: Certifications list + `useReleaseCertification` (`/certifications`)

**Files:**
- Modify: `lib/query/hooks.ts` (add `useReleaseCertification`)
- Create: `components/certifications/certifications-list.tsx`
- Create: `app/(app)/certifications/page.tsx`
- Test: `components/certifications/certifications-list.test.tsx`

**Interfaces:**
- Consumes: `Certification`, `Customer`, `WorkOrder`, `Specification` (domain), `certStatusMeta` (`lib/domain/enums`), `ListCard`, `MonoId`, `StatusPill` (patterns), `Button` (`lib/ui/button`), `useCertifications`, `useCustomers`, `useWorkOrders`, `useSpecifications`, `useCan`.
- Produces:
  - `CertificationsList({ certifications, customers, workOrders, specifications, canRelease, onRelease })`
  - `useReleaseCertification()` → `mutate({ id, version })`

- [ ] **Step 1: Add `useReleaseCertification` to `lib/query/hooks.ts`.** (`useMutation`/`useQueryClient` already imported from Task 9.)

```ts
export function useReleaseCertification() {
  const r = useRepositories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; version: number }) =>
      r.certifications.update(vars.id, { status: "released" }, vars.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.certifications });
    },
  });
}
```

- [ ] **Step 2: Write the failing test `components/certifications/certifications-list.test.tsx`.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CertificationsList } from "./certifications-list";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const certs: Certification[] = [
  { ...base, id: "cert-9921", number: "C-9921", customerId: "cust-apex", workOrderId: "wo-48211", specificationId: "spec-ams2759-3", type: "Carburize", status: "pending", copies: 2 },
  { ...base, id: "cert-9918", number: "C-9918", customerId: "cust-delta", workOrderId: "wo-48190", specificationId: "spec-mils6090", type: "Nitride", status: "released", copies: 1 },
];
const customers = [{ ...base, id: "cust-apex", name: "Apex Aerospace" }] as unknown as Customer[];
const workOrders = [{ ...base, id: "wo-48211", number: "WO-48211" }] as unknown as WorkOrder[];
const specs = [{ ...base, id: "spec-ams2759-3", code: "AMS 2759/3" }] as unknown as Specification[];

describe("CertificationsList", () => {
  it("renders certs with status and shows Release only on pending rows for managers", async () => {
    const onRelease = vi.fn();
    render(
      <CertificationsList certifications={certs} customers={customers} workOrders={workOrders}
        specifications={specs} canRelease onRelease={onRelease} />,
    );
    expect(screen.getByText("C-9921")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Released")).toBeInTheDocument();
    const releaseButtons = screen.getAllByRole("button", { name: /release/i });
    expect(releaseButtons).toHaveLength(1); // only the pending cert
    await userEvent.click(releaseButtons[0]);
    expect(onRelease).toHaveBeenCalledWith("cert-9921");
  });

  it("hides the Release action when the user cannot release", () => {
    render(
      <CertificationsList certifications={certs} customers={customers} workOrders={workOrders}
        specifications={specs} canRelease={false} onRelease={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `npx vitest run components/certifications/certifications-list.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `components/certifications/certifications-list.tsx`.**

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { certStatusMeta } from "@/lib/domain/enums";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

export function CertificationsList({
  certifications,
  customers,
  workOrders,
  specifications,
  canRelease,
  onRelease,
}: {
  certifications: Certification[];
  customers: Customer[];
  workOrders: WorkOrder[];
  specifications: Specification[];
  canRelease: boolean;
  onRelease: (id: string) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const woById = new Map(workOrders.map((w) => [w.id, w]));
  const specById = new Map(specifications.map((s) => [s.id, s]));
  return (
    <ListCard
      headers={["CERT", "CUSTOMER", "WORK ORDER", "SPEC", "TYPE", "COPIES", "STATUS", ""]}
      rows={certifications.map((c) => {
        const meta = certStatusMeta[c.status];
        return [
          <MonoId key="c">{c.number}</MonoId>,
          custById.get(c.customerId)?.name ?? "—",
          <MonoId key="w">{woById.get(c.workOrderId)?.number ?? "—"}</MonoId>,
          c.specificationId ? specById.get(c.specificationId)?.code ?? "—" : "—",
          c.type,
          <span key="cp" className="font-mono">{c.copies}</span>,
          <StatusPill key="s" tone={meta.tone}>{meta.label}</StatusPill>,
          canRelease && c.status === "pending"
            ? <Button key="r" size="sm" variant="outline" onClick={() => onRelease(c.id)}>Release</Button>
            : null,
        ];
      })}
    />
  );
}
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npx vitest run components/certifications/certifications-list.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Create the route `app/(app)/certifications/page.tsx`.**

```tsx
"use client";
import { useCertifications, useCustomers, useWorkOrders, useSpecifications, useReleaseCertification } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CertificationsList } from "@/components/certifications/certifications-list";

export default function CertificationsPage() {
  const certs = useCertifications();
  const customers = useCustomers();
  const workOrders = useWorkOrders();
  const specs = useSpecifications();
  const release = useReleaseCertification();
  const canRelease = useCan("release_cert");

  if (certs.isLoading) return <SkeletonRows />;
  if (certs.isError) return <ErrorPanel message="Failed to load certifications." onRetry={() => certs.refetch()} />;
  const data = certs.data ?? [];

  return (
    <div>
      <PageHeader title="Certifications" subtitle="A cert must be Released before its order can ship." />
      {data.length === 0 ? (
        <EmptyState title="No certifications" />
      ) : (
        <CertificationsList
          certifications={data}
          customers={customers.data ?? []}
          workOrders={workOrders.data ?? []}
          specifications={specs.data ?? []}
          canRelease={canRelease}
          onRelease={(id) => {
            const c = data.find((x) => x.id === id);
            if (c) release.mutate({ id, version: c.version });
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 7: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add lib/query/hooks.ts components/certifications "app/(app)/certifications"
git commit -m "feat(certifications): add certifications list with manager-gated release"
```

---

## Task 11: Customers list (`/customers`)

**Files:**
- Create: `components/customers/customers-list.tsx`
- Create: `app/(app)/customers/page.tsx`
- Test: `components/customers/customers-list.test.tsx`

**Interfaces:**
- Consumes: `Customer`, `WorkOrder`, `Invoice` (domain), `customerStatusMeta` (`lib/domain/enums`), `customerBalanceCents` (`lib/logic/ar`), `formatMoney` (`lib/utils`), `ListCard`, `MonoId`, `StatusPill` (patterns), `useCustomers`, `useWorkOrders`, `useInvoices`, `useRouter`.
- Produces: `CustomersList({ customers, workOrders, invoices, onSelect })`.

- [ ] **Step 1: Write the failing test `components/customers/customers-list.test.tsx`.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomersList } from "./customers-list";
import type { Customer, WorkOrder, Invoice } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const customers = [
  { ...base, id: "cust-apex", customerNumber: "1042", name: "Apex Aerospace", initials: "AA", city: "Wichita, KS", billingAddress: "", phone: "", terms: "Net 30", status: "active", priceKeyId: "pk-aero1", taxExempt: true, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0 },
] as Customer[];
const orders = [
  { ...base, id: "wo1", customerId: "cust-apex", status: "in_process" },
  { ...base, id: "wo2", customerId: "cust-apex", status: "shipped" },
] as unknown as WorkOrder[];
const invoices = [
  { ...base, id: "i1", customerId: "cust-apex", status: "sent", amountCents: 674000 },
] as unknown as Invoice[];

describe("CustomersList", () => {
  it("renders computed open-order count and A/R balance, and fires select", async () => {
    const onSelect = vi.fn();
    render(<CustomersList customers={customers} workOrders={orders} invoices={invoices} onSelect={onSelect} />);
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("1042")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();       // 1 open order (shipped excluded)
    expect(screen.getByText("$6,740")).toBeInTheDocument();  // A/R balance
    expect(screen.getByText("Active")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Apex Aerospace"));
    expect(onSelect).toHaveBeenCalledWith("cust-apex");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/customers/customers-list.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/customers/customers-list.tsx`.**

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { customerStatusMeta } from "@/lib/domain/enums";
import { customerBalanceCents } from "@/lib/logic/ar";
import { formatMoney } from "@/lib/utils";
import type { Customer, WorkOrder, Invoice } from "@/lib/domain";

export function CustomersList({
  customers,
  workOrders,
  invoices,
  onSelect,
}: {
  customers: Customer[];
  workOrders: WorkOrder[];
  invoices: Invoice[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ListCard
      headers={["CUSTOMER", "#", "CITY", "TERMS", "OPEN ORDERS", "A/R BALANCE", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(customers[i].id) : undefined}
      rows={customers.map((c) => {
        const meta = customerStatusMeta[c.status];
        const open = workOrders.filter((w) => w.customerId === c.id && w.status !== "shipped").length;
        const balance = customerBalanceCents(invoices, c.id);
        return [
          c.name,
          <MonoId key="num">{c.customerNumber}</MonoId>,
          c.city || "—",
          c.terms,
          <span key="open" className="font-mono">{open}</span>,
          <span key="bal" className="font-mono">{formatMoney(balance)}</span>,
          <StatusPill key="status" tone={meta.tone}>{meta.label}</StatusPill>,
        ];
      })}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run components/customers/customers-list.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create the route `app/(app)/customers/page.tsx`.**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useCustomers, useWorkOrders, useInvoices } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CustomersList } from "@/components/customers/customers-list";

export default function CustomersPage() {
  const router = useRouter();
  const customers = useCustomers();
  const workOrders = useWorkOrders();
  const invoices = useInvoices();
  return (
    <div>
      <PageHeader title="Customers" subtitle="Accounts, terms, open work and A/R at a glance." />
      {customers.isLoading ? (
        <SkeletonRows />
      ) : customers.isError ? (
        <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />
      ) : !customers.data || customers.data.length === 0 ? (
        <EmptyState title="No customers" />
      ) : (
        <CustomersList
          customers={customers.data}
          workOrders={workOrders.data ?? []}
          invoices={invoices.data ?? []}
          onSelect={(id) => router.push(`/customers/${id}`)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/customers/customers-list.tsx components/customers/customers-list.test.tsx "app/(app)/customers/page.tsx"
git commit -m "feat(customers): add customers list with computed open orders + A/R"
```

---

## Task 12: Customer detail with tabs (`/customers/[id]`)

**Files:**
- Create: `components/customers/customer-detail.tsx`
- Create: `app/(app)/customers/[id]/page.tsx`
- Test: `components/customers/customer-detail.test.tsx`

**Interfaces:**
- Consumes: `Customer`, `Contact`, `Part`, `WorkOrder`, `Invoice`, `PriceKey`, `PricingRule` (domain), `customerStatusMeta`, `orderStatusMeta`, `basisLabel` (`lib/domain/enums`), `customerBalanceCents` (`lib/logic/ar`), `formatMoney`, `formatDate` (`lib/utils`), `DetailHeader`, `StatusPill`, `MonoId`, `ListCard`, `EmptyState` (patterns), `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` (`lib/ui/tabs`), the `useCustomer`/`useContactsByCustomer`/`usePartsByCustomer`/`useWorkOrders`/`useInvoices`/`usePriceKeys`/`usePricingRulesByPriceKey` hooks.
- Produces: `CustomerDetail({ customer, contacts, parts, orders, invoices, priceKey, pricingRules })`.

- [ ] **Step 1: Write the failing test `components/customers/customer-detail.test.tsx`.** (Mock `next/link` for `DetailHeader`; Radix `Tabs` triggers are buttons — `userEvent.click` switches tabs.)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerDetail } from "./customer-detail";
import type { Customer, Contact, Part, WorkOrder, Invoice, PriceKey, PricingRule } from "@/lib/domain";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

const base = { createdAt: "", updatedAt: "", version: 0 };
const customer: Customer = {
  ...base, id: "cust-apex", customerNumber: "1042", name: "Apex Aerospace", initials: "AA",
  city: "Wichita, KS", billingAddress: "4120 Industrial Pkwy", phone: "(316) 555-0142",
  terms: "Net 30", status: "active", priceKeyId: "pk-aero1", taxExempt: true,
  defaultCertSpecId: "spec-ams2759-3", defaultCertCopies: 2, ytdSalesCents: 214_000_00,
};
const contacts = [{ ...base, id: "ct1", customerId: "cust-apex", name: "Sara Lin", role: "Buyer", email: "sara@apex.com", phone: "x" }] as Contact[];
const parts = [{ ...base, id: "p1", partNumber: "TS-4471", description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C", hardness: "Rc 58-62", caseDepth: "", specificationId: null, processMasterId: null, priceKeyId: null, inspectionScale: "", inspectionSample: "" }] as Part[];
const orders = [{ ...base, id: "wo1", number: "WO-48211", customerId: "cust-apex", customerPO: "", quoteId: null, processSummary: "Carburize + Temper", processMasterId: null, status: "in_process", orderedDate: "2026-06-26T00:00:00.000Z", due: "2026-07-02T00:00:00.000Z", certifyRequired: true, certSpecId: null, orderValueCents: 842000, progressPct: 68, lines: [], pricing: [], steps: [], activity: [] }] as WorkOrder[];
const invoices = [{ ...base, id: "i1", number: "INV-1", customerId: "cust-apex", workOrderId: "wo1", amountCents: 674000, status: "sent", shippedDate: "", invoicedDate: "2026-06-27T00:00:00.000Z", paidDate: null }] as Invoice[];
const priceKey: PriceKey = { ...base, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" };
const rules = [{ ...base, id: "pr1", priceKeyId: "pk-aero1", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 }] as PricingRule[];

function setup() {
  render(<CustomerDetail customer={customer} contacts={contacts} parts={parts} orders={orders} invoices={invoices} priceKey={priceKey} pricingRules={rules} />);
}

describe("CustomerDetail", () => {
  it("renders the header, status pill and Overview by default", () => {
    setup();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Net 30")).toBeInTheDocument();
    expect(screen.getByText("$6,740")).toBeInTheDocument(); // computed A/R balance on Overview
  });
  it("shows contacts, parts and pricing on their tabs", async () => {
    setup();
    await userEvent.click(screen.getByRole("tab", { name: "Contacts" }));
    expect(await screen.findByText("Sara Lin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Parts" }));
    expect(await screen.findByText("TS-4471")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Pricing" }));
    expect(await screen.findByText("AERO-1")).toBeInTheDocument();
    expect(await screen.findByText("Carburize")).toBeInTheDocument();
  });
  it("shows an empty documents tab", async () => {
    setup();
    await userEvent.click(screen.getByRole("tab", { name: "Documents" }));
    expect(await screen.findByText(/no documents/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/customers/customer-detail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/customers/customer-detail.tsx`.**

```tsx
import { DetailHeader, StatusPill, MonoId, ListCard, EmptyState } from "@/components/patterns";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/lib/ui/tabs";
import { customerStatusMeta, orderStatusMeta, basisLabel } from "@/lib/domain/enums";
import { customerBalanceCents } from "@/lib/logic/ar";
import { formatMoney, formatDate } from "@/lib/utils";
import type {
  Customer, Contact, Part, WorkOrder, Invoice, PriceKey, PricingRule,
} from "@/lib/domain";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-muted text-[11px]">{label}</dt>
      <dd className="text-[13px]">{value}</dd>
    </div>
  );
}

export function CustomerDetail({
  customer: c,
  contacts,
  parts,
  orders,
  invoices,
  priceKey,
  pricingRules,
}: {
  customer: Customer;
  contacts: Contact[];
  parts: Part[];
  orders: WorkOrder[];
  invoices: Invoice[];
  priceKey: PriceKey | null;
  pricingRules: PricingRule[];
}) {
  const meta = customerStatusMeta[c.status];
  const balance = customerBalanceCents(invoices, c.id);
  const openOrders = orders.filter((o) => o.status !== "shipped").length;

  return (
    <div>
      <DetailHeader
        backHref="/customers"
        backLabel="Customers"
        title={<span className="flex items-center gap-2"><span>{c.name}</span><MonoId className="text-text-muted">#{c.customerNumber}</MonoId></span>}
        subtitle={c.city || undefined}
        statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>}
      />
      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <dl className="grid grid-cols-3 gap-4 rounded-card border border-border bg-surface p-4">
            <Field label="Terms" value={c.terms} />
            <Field label="Tax exempt" value={c.taxExempt ? "Yes" : "No"} />
            <Field label="Phone" value={c.phone || "—"} />
            <Field label="Billing address" value={c.billingAddress || "—"} />
            <Field label="YTD sales" value={<span className="font-mono">{formatMoney(c.ytdSalesCents)}</span>} />
            <Field label="A/R balance" value={<span className="font-mono">{formatMoney(balance)}</span>} />
            <Field label="Open orders" value={<span className="font-mono">{openOrders}</span>} />
            <Field label="Default cert" value={c.defaultCertSpecId ? `${c.defaultCertCopies} copies` : "—"} />
            <Field label="Price key" value={priceKey ? <MonoId>{priceKey.code}</MonoId> : "—"} />
          </dl>
        </TabsContent>

        <TabsContent value="contacts" className="pt-4">
          {contacts.length === 0 ? (
            <EmptyState title="No contacts" />
          ) : (
            <ListCard
              headers={["NAME", "ROLE", "EMAIL", "PHONE"]}
              rows={contacts.map((ct) => [ct.name, ct.role, ct.email, ct.phone])}
            />
          )}
        </TabsContent>

        <TabsContent value="parts" className="pt-4">
          {parts.length === 0 ? (
            <EmptyState title="No parts" />
          ) : (
            <ListCard
              headers={["PART", "DESCRIPTION", "MATERIAL", "HARDNESS"]}
              rows={parts.map((p) => [<MonoId key="pn">{p.partNumber}</MonoId>, p.description, p.material, p.hardness])}
            />
          )}
        </TabsContent>

        <TabsContent value="orders" className="pt-4">
          {orders.length === 0 ? (
            <EmptyState title="No orders" />
          ) : (
            <ListCard
              headers={["WORK ORDER", "PROCESS", "DUE", "VALUE", "STATUS"]}
              rows={orders.map((o) => {
                const om = orderStatusMeta[o.status];
                return [
                  <MonoId key="wo">{o.number}</MonoId>,
                  o.processSummary,
                  formatDate(o.due),
                  <span key="v" className="font-mono">{formatMoney(o.orderValueCents)}</span>,
                  <StatusPill key="s" tone={om.tone}>{om.label}</StatusPill>,
                ];
              })}
            />
          )}
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <EmptyState title="No documents" description="Document management arrives in a later phase." />
        </TabsContent>

        <TabsContent value="pricing" className="pt-4">
          {!priceKey ? (
            <EmptyState title="No price key" description="This customer has no pricing profile assigned." />
          ) : (
            <div className="space-y-3">
              <div className="text-text-muted text-xs">
                Step pricing overrides · price key <MonoId>{priceKey.code}</MonoId> — {priceKey.description}
              </div>
              <ListCard
                headers={["PROCESS", "BASIS", "RATE", "MIN CHARGE"]}
                rows={pricingRules.map((r) => [
                  r.process,
                  basisLabel[r.basis],
                  <span key="rate" className="font-mono">{formatMoney(r.rateCents)}</span>,
                  <span key="min" className="font-mono">{r.minChargeCents != null ? formatMoney(r.minChargeCents) : "—"}</span>,
                ])}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run components/customers/customer-detail.test.tsx`
Expected: PASS (3 tests). If a Radix tab click doesn't reveal content, confirm the trigger is queried by `role: "tab"` and content asserted with `findByText` (async) — Radix mounts the panel on activation.

- [ ] **Step 5: Create the route `app/(app)/customers/[id]/page.tsx`.**

```tsx
"use client";
import { use } from "react";
import {
  useCustomer, useContactsByCustomer, usePartsByCustomer,
  useWorkOrders, useInvoices, usePriceKeys, usePricingRulesByPriceKey,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CustomerDetail } from "@/components/customers/customer-detail";

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const customer = useCustomer(id);
  const contacts = useContactsByCustomer(id);
  const parts = usePartsByCustomer(id);
  const orders = useWorkOrders();
  const invoices = useInvoices();
  const priceKeys = usePriceKeys();
  const priceKeyId = customer.data?.priceKeyId ?? "";
  const rules = usePricingRulesByPriceKey(priceKeyId);

  if (customer.isLoading) return <SkeletonRows />;
  if (customer.isError) return <ErrorPanel message="Failed to load customer." onRetry={() => customer.refetch()} />;
  if (!customer.data) return <EmptyState title="Customer not found" />;
  const c = customer.data;

  const custOrders = (orders.data ?? []).filter((w) => w.customerId === id);
  const custInvoices = (invoices.data ?? []).filter((i) => i.customerId === id);
  const priceKey = (priceKeys.data ?? []).find((k) => k.id === c.priceKeyId) ?? null;

  return (
    <CustomerDetail
      customer={c}
      contacts={contacts.data ?? []}
      parts={parts.data ?? []}
      orders={custOrders}
      invoices={custInvoices}
      priceKey={priceKey}
      pricingRules={rules.data ?? []}
    />
  );
}
```

- [ ] **Step 6: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/customers/customer-detail.tsx components/customers/customer-detail.test.tsx "app/(app)/customers/[id]"
git commit -m "feat(customers): add tabbed customer detail (overview/contacts/parts/orders/documents/pricing)"
```

---

## Task 13: Today dashboard (`/today`)

**Files:**
- Create: `components/today/today-dashboard.tsx`
- Modify: `app/(app)/today/page.tsx` (replace the Plan 1 stub)
- Test: `components/today/today-dashboard.test.tsx`, `app/(app)/today/today-page.test.tsx`

**Interfaces:**
- Consumes: `KpiDescriptor` (`lib/logic/dashboard`), `RoleKey` (domain), `KpiTile` (patterns), `cn` (`lib/utils`), `useAuth` (`lib/auth/provider`), `dashboardKpis` (`lib/logic/dashboard`), the `useWorkOrders`/`useQuotes`/`useInvoices`/`useCertifications` hooks.
- Produces: `TodayDashboard({ greeting, viewAs, onViewAs, tiles })`.

- [ ] **Step 1: Write the failing presentational test `components/today/today-dashboard.test.tsx`.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodayDashboard } from "./today-dashboard";
import type { KpiDescriptor } from "@/lib/logic/dashboard";

const tiles: KpiDescriptor[] = [
  { label: "Open Orders", value: "7", sub: "2 late" },
  { label: "Late Orders", value: "2", tone: "danger" },
];

describe("TodayDashboard", () => {
  it("renders the greeting, role switch and KPI tiles", () => {
    render(<TodayDashboard greeting="Good day, Dana" viewAs="manager" onViewAs={() => {}} tiles={tiles} />);
    expect(screen.getByText("Good day, Dana")).toBeInTheDocument();
    expect(screen.getByText("Open Orders")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
  it("fires onViewAs when a role is chosen", async () => {
    const onViewAs = vi.fn();
    render(<TodayDashboard greeting="Hi" viewAs="manager" onViewAs={onViewAs} tiles={tiles} />);
    await userEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(onViewAs).toHaveBeenCalledWith("sales");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run components/today/today-dashboard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `components/today/today-dashboard.tsx`.**

```tsx
"use client";
import { KpiTile } from "@/components/patterns";
import { cn } from "@/lib/utils";
import type { RoleKey } from "@/lib/domain";
import type { KpiDescriptor } from "@/lib/logic/dashboard";

const ROLES: { key: RoleKey; label: string }[] = [
  { key: "manager", label: "Manager" },
  { key: "sales", label: "Sales" },
  { key: "office", label: "Office" },
];

export function TodayDashboard({
  greeting,
  viewAs,
  onViewAs,
  tiles,
}: {
  greeting: string;
  viewAs: RoleKey;
  onViewAs: (r: RoleKey) => void;
  tiles: KpiDescriptor[];
}) {
  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{greeting}</h1>
          <p className="text-text-muted text-xs">Here&apos;s your shop at a glance.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-xs">Viewing as</span>
          <div className="inline-flex rounded-[9px] border border-border bg-surface p-0.5">
            {ROLES.map((r) => (
              <button
                key={r.key}
                onClick={() => onViewAs(r.key)}
                className={cn(
                  "rounded-[7px] px-2.5 py-1 text-xs",
                  r.key === viewAs ? "bg-primary-tint text-primary font-medium" : "text-text-muted",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {tiles.map((t) => (
          <KpiTile key={t.label} label={t.label} value={t.value} sub={t.sub} tone={t.tone} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the presentational test to verify it passes.**

Run: `npx vitest run components/today/today-dashboard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Replace the route `app/(app)/today/page.tsx`.**

```tsx
"use client";
import { useAuth } from "@/lib/auth/provider";
import { useWorkOrders, useQuotes, useInvoices, useCertifications } from "@/lib/query/hooks";
import { dashboardKpis } from "@/lib/logic/dashboard";
import { SkeletonRows } from "@/components/patterns";
import { TodayDashboard } from "@/components/today/today-dashboard";

export default function TodayPage() {
  const { operator, viewAs, setViewAs } = useAuth();
  const orders = useWorkOrders();
  const quotes = useQuotes();
  const invoices = useInvoices();
  const certs = useCertifications();

  if (orders.isLoading || quotes.isLoading || invoices.isLoading || certs.isLoading) return <SkeletonRows />;

  const asOf = new Date().toISOString();
  const tiles = dashboardKpis(
    viewAs,
    {
      orders: orders.data ?? [],
      quotes: quotes.data ?? [],
      invoices: invoices.data ?? [],
      certifications: certs.data ?? [],
    },
    asOf,
  );
  const greeting = `Good day, ${operator?.name?.split(" ")[0] ?? "there"}`;

  return <TodayDashboard greeting={greeting} viewAs={viewAs} onViewAs={setViewAs} tiles={tiles} />;
}
```

- [ ] **Step 6: Write the integration smoke test `app/(app)/today/today-page.test.tsx`.** Proves the dashboard is wired to the seed end-to-end (page → hooks → `dashboardKpis` → `TodayDashboard` → `KpiTile`). `asOf` uses the real wall-clock, so **do not assert numeric tile values here** (Late Orders / On-Time % / Invoiced MTD all vary with the clock, and a stale clock can make two tiles share the same number, breaking `getByText`). Assert manager-only tile **labels** — they only render when `viewAs="manager"` tiles come back from real seed data. Exact values are already unit-tested in Task 2.

```tsx
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/tests/utils";
import TodayPage from "./page";

describe("TodayPage (integration)", () => {
  it("wires seed data through dashboardKpis into the manager dashboard", async () => {
    renderWithProviders(<TodayPage />);
    // default viewAs = manager (AuthProvider auto-logs in op-dana);
    // these two labels are manager-only and date-independent.
    expect(await screen.findByText("Open Orders")).toBeInTheDocument();
    expect(await screen.findByText("Certs Awaiting Release")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the integration test to verify it passes.**

Run: `npx vitest run app/\(app\)/today/today-page.test.tsx`
Expected: PASS. (AuthProvider auto-login sets `viewAs="manager"`; the manager tile labels render from seed-derived KPIs.)

- [ ] **Step 8: Run the full Verify Gate, then commit.**

```bash
npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build
git add components/today "app/(app)/today/page.tsx" "app/(app)/today/today-page.test.tsx"
git commit -m "feat(today): add role-aware Today dashboard with seed-computed KPIs"
```

---

## Self-Review

**1. Spec / scope coverage** (Plan 2 scope from the request → task):

| Scope item | Task(s) |
|---|---|
| Customers list | Task 11 |
| Customer detail tabs (Overview/Contacts/Parts/Orders/Documents/Pricing) | Task 12 |
| Parts list | Task 8 |
| Part editor | Task 9 |
| Process Master list | Task 6 |
| Process Master read-only detail | Task 7 |
| Specifications | Task 5 |
| Certifications | Task 10 |
| Today dashboard (Manager/Sales/Office KPIs from seed) | Tasks 2 (logic) + 13 (UI) |
| Remaining nav placeholder pages | Task 4 |
| Live sidebar badge counts | Tasks 2 (logic) + 3 (wiring) |
| Query hooks the screens need | Tasks 1, 9, 10 |
| Test harness for provider-backed component tests | Task 1 |

**2. Placeholder scan:** No `TBD`/`implement later`/"handle edge cases"/"write tests for the above" left in the plan — every test and implementation step contains complete code. Loading/error/empty states are shown explicitly in each `page.tsx`.

**3. Type consistency (checked against Plan 1 source):**
- `WriteRepo.update(id, patch, expectedVersion)` — used correctly by `useUpdatePart` / `useReleaseCertification` (patch is `Partial<Omit<T,"id"|"createdAt"|"updatedAt"|"version">>`, and version passed explicitly).
- Repo methods used exist: `processMasters.get`, `contacts.byCustomer`, `parts.byCustomer`, `priceKeys.list`, `pricingRules.byPriceKey`, `certifications.update`, `parts.update`.
- `certStatusMeta`, `customerStatusMeta`, `orderStatusMeta`, `basisLabel` exist in `lib/domain/enums.ts` with the shapes used.
- `customerBalanceCents(invoices, customerId)` and `agingBucket(invoice, asOf)` signatures match `lib/logic/ar.ts`.
- `quoteTotalCents(quote)` accepts `Pick<Quote,"parts"|"discount">` — full `Quote` objects satisfy it (used in `openQuoteValueCents`).
- `StatusTone` reused from `lib/domain/enums`; `KpiTile`/`StatusPill` accept `tone?: StatusTone` / `tone: StatusTone`.
- `formatMoney(cents)` / `formatDate(iso)` signatures match `lib/utils.ts`.
- Next.js 16 dynamic pages typed as `{ params: Promise<{ id: string }> }` and read via `use(params)` — matches the bundled docs.
- `AppShell` already accepts `badges?: Record<string, number>`; `Sidebar` reads `badges[it.key]` where nav keys are `quotes`/`orders`/`certifications` — matches `navBadgeCounts` output keys.

**4. Carry-forward follow-ups (from project memory):** `--radius-md: 9px` token added (Task 1) addresses the Plan 1 UI-polish note for square button/select corners. The A/R "current < 7 day" heuristic and A/R aging refinement remain **Plan 3** (this plan's `pastDueCents`/`openArCents` deliberately reuse the existing `agingBucket` as-is). Auth hardening (auto-login on `/login`, `logout()` not resetting `viewAs`) remains **Plan 3** — Task 13 only *uses* `viewAs`/`setViewAs`, it does not change `AuthProvider`.

**Interim gaps intentionally left for Plan 3:** `/quotes`, `/quotes/new`, `/orders`, `/invoicing`, `/ar` are placeholder pages (no dead nav/command-palette links); Plan 3 replaces them with the real Quote → Order → Invoice workflow. The `Document` entity is not modeled, so the customer Documents tab is an empty state.

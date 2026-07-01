# HeatSynQ Plan 3 — Quote → Order → Invoice Workflow + Playwright E2E — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interim `/quotes`, `/quotes/new`, `/orders`, `/invoicing`, `/ar` placeholders with the real Quote → Order → Invoice slice (multi-part quote builder, order detail with cert-gated ship, invoicing, A/R aging), backed by new create/transition mutations, and prove the whole happy path with a Playwright E2E.

**Architecture:** Build ON Plans 1+2. UI depends only on the async repository interfaces (`lib/data/repositories`) via TanStack Query hooks (`lib/query/hooks.ts`). All state transitions and money/date math live in pure functions in `lib/logic/*` (unit-tested first, TDD). Mutations orchestrate pure logic + repo I/O. Screens are presentational components (`components/<area>/*`) wired by thin `page.tsx` glue. The mock repository layer is the single source of numbering; the create/number seam and A/R aging model are fixed **before** the invoicing flow depends on them.

**Tech Stack:** Next.js 16 (App Router) + TypeScript, TanStack Query v5, Tailwind v4, Zod v4, Vitest + React Testing Library (unit/component), **Playwright (slice E2E, added in Task 1)**. npm. Node 20 (`.nvmrc`).

## Global Constraints

Copied verbatim from the spec + locked Plan 1/2 conventions. **Every task's requirements implicitly include this section.**

- **Money = integer cents.** Never store or compute money as floats. Display via `formatMoney(cents)` (whole-dollar, e.g. `842000 → "$8,420"`).
- **Dates = ISO strings**, domain date-only fields are midnight-UTC (`"2026-07-02T00:00:00.000Z"`). Display via `formatDate(iso)` (uses `timeZone:"UTC"`).
- **UI depends only on the async repository interfaces** (`Repositories` in `lib/data/repositories/index.ts`) via the Query hooks. No component imports `createMockRepositories` except the providers/test harness.
- **Every entity carries `id, createdAt, updatedAt, version`.** Writes are optimistic-concurrency: `update(id, patch, expectedVersion)`.
- **IBM Plex Mono for all ids / numbers / status pills / uppercase table headers** (use `<MonoId>`, `<StatusPill>`, `className="font-mono"`). Exact design tokens only (`text-status-*`, `bg-status-*-tint`, `bg-surface`, `border-border`, `rounded-card`, `rounded-pill`, `text-text-muted`, `text-primary`, etc.).
- **`any` is confined to the two approved mock generic-plumbing signatures** in `lib/data/mock/repositories.ts` (each already carries an `eslint-disable ... -- approved` comment). Introduce no new `any`.
- **Presentational components are pure** (data in via props, callbacks out). `page.tsx` is thin glue: call hooks, handle `isLoading`/`isError`/empty, pass data + callbacks to the component. Next 16 dynamic routes read params via `use(params)` (params is a `Promise`).
- **Permissions follow the authenticated `operator.role`, never `viewAs`.** Gate actions with `useCan(permission)`. Available permissions: `approve_over_limit` (manager), `apply_discount` (manager+sales), `release_cert` (manager), `close_period` (manager+office).
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit. Frequent commits. DRY, YAGNI.
- **The gate stays green at every commit:** `npx tsc --noEmit`, `npm run lint -- --max-warnings 0`, `npm run test`, `npm run build`. From Task 1 on, `npx playwright test` is also part of the gate (CI `verify` job). Branch protection requires the `verify` check.

---

## File Structure

**New files**

```
playwright.config.ts                              # Task 1 — Playwright config (testDir tests/e2e, webServer, chromium)
tests/e2e/smoke.spec.ts                           # Task 1 — app-boots smoke E2E
tests/e2e/quote-to-invoice.spec.ts                # Task 15 — full slice happy path
lib/logic/quote-builder.ts (+ .test.ts)           # Task 4 — rate lookup, buildQuoteDraft, quote dates, stub cost
components/quotes/quotes-list.tsx (+ .test.tsx)    # Task 8
components/quotes/quote-builder.tsx (+ .test.tsx)  # Task 9 — multi-part builder (native selects)
components/quotes/quote-view.tsx (+ .test.tsx)     # Task 10 — read-only quote + lifecycle actions
components/orders/orders-list.tsx (+ .test.tsx)    # Task 11
components/orders/order-detail.tsx (+ .test.tsx)   # Task 12 — pricing, traveler, cert+release, ship gate, activity
components/invoicing/invoicing-view.tsx (+ .test.tsx) # Task 13 — tabs + bill + record payment
components/ar/ar-view.tsx (+ .test.tsx)            # Task 14 — aging buckets + per-customer + close period
```

**Modified files**

```
package.json                                       # Task 1 — @playwright/test devDep + test:e2e script
vitest.config.ts                                   # Task 1 — exclude tests/e2e from Vitest
.github/workflows/ci.yml                           # Task 1 — install browsers + run E2E in `verify`
lib/data/repositories/index.ts                     # Task 2 — CreateInput<T>, NumberService, numbers on Repositories, retype create
lib/data/mock/repositories.ts                      # Task 2 — number-on-create fix + numbers service
lib/data/mock/repositories.test.ts                 # Task 2 — seam tests
lib/logic/order.ts (+ .test.ts)                    # Task 2 (drop WO number) + Task 4 (createCertForOrder, activityEntry)
lib/logic/invoice.ts (+ .test.ts)                  # Task 2 — NewInvoice = CreateInput<Invoice>
lib/logic/quote-state.ts (+ .test.ts)              # Task 2 — reviseQuote returns CreateInput<Quote> (drops number)
lib/logic/ar.ts (+ .test.ts)                       # Task 3 — net-terms aging rewrite
lib/logic/dashboard.ts (+ .test.ts)                # Task 3 — isLate end-of-day, pastDueCents(customers), DashboardData+customers
app/(app)/today/page.tsx                           # Task 3 — pass customers to dashboardKpis
lib/query/keys.ts                                  # Tasks 5-7 — (no new keys needed; documented)
lib/query/hooks.ts                                 # Tasks 5-7 — quote/order/invoice mutations
app/(app)/quotes/page.tsx                          # Task 8 — real Quotes list
app/(app)/quotes/new/page.tsx                      # Task 9 — builder (create)
app/(app)/quotes/[id]/page.tsx                     # Task 10 — NEW route (edit draft / read-only view)
app/(app)/orders/page.tsx                          # Task 11 — real Orders list
app/(app)/orders/[id]/page.tsx                     # Task 12 — NEW route (order detail)
app/(app)/invoicing/page.tsx                       # Task 13 — real Invoicing
app/(app)/ar/page.tsx                              # Task 14 — real A/R
```

---

## Task 1: Playwright scaffold + config + CI wiring

**Why first:** the E2E harness must exist and be green (on a smoke test) before any screen is built, so later tasks can add flows incrementally. Playwright is already half-installed (`@playwright/test ^1.51.1` is in `package-lock.json`; `.gitignore` already ignores `playwright-report/`, `test-results/`, `.playwright/`) but is **not** in `package.json`, **not** in `node_modules`, and has **no config**. This task formalizes it.

**Files:**
- Modify: `package.json` (add devDep + script)
- Create: `playwright.config.ts`
- Create: `tests/e2e/smoke.spec.ts`
- Modify: `vitest.config.ts` (exclude `tests/e2e` — Vitest's default glob matches `*.spec.ts` too, so without this it would try to run Playwright specs and fail)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `tests/e2e/**` runnable via `npm run test:e2e`; Playwright `webServer` boots `npm run dev` on `http://localhost:3000`; Vitest ignores `tests/e2e/**`.
- Consumes: nothing from later tasks.

- [ ] **Step 1: Add `@playwright/test` + script to `package.json`**

In `"devDependencies"` add (keep alphabetical): `"@playwright/test": "^1.51.1",`. In `"scripts"` add: `"test:e2e": "playwright test",`.

- [ ] **Step 2: Install**

Run: `npm install` then `npx playwright install --with-deps chromium`
Expected: `@playwright/test` appears in `node_modules`; Chromium downloads.

- [ ] **Step 3: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

Note: E2E runs against the Next **dev** server. This is correct here — the whole data layer is the in-memory mock created client-side per app boot, so there is no backend to build. The mock store persists across **in-app** navigation (the providers mount once in the root layout); a full `page.goto`/reload resets it. **E2E flows must navigate via in-app clicks/links, not repeated `page.goto`.**

- [ ] **Step 4: Exclude E2E from Vitest**

Edit `vitest.config.ts` — add `import { configDefaults } from "vitest/config";` and set `test.exclude`:

```ts
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
```

- [ ] **Step 5: Write the smoke E2E**

```ts
// tests/e2e/smoke.spec.ts
import { test, expect } from "@playwright/test";

test("app boots and shows the shell with the Quotes nav item", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("link", { name: "Quotes" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
```

- [ ] **Step 6: Run the smoke E2E — expect PASS**

Run: `npm run test:e2e`
Expected: `1 passed`. (Playwright boots the dev server, loads `/today`, sees the sidebar.)

- [ ] **Step 7: Confirm Vitest still green and ignores E2E**

Run: `npm run test`
Expected: all existing suites pass; no attempt to run `tests/e2e/smoke.spec.ts`.

- [ ] **Step 8: Wire CI — add browser install + E2E to the `verify` job**

Edit `.github/workflows/ci.yml`. After the existing `Build` step, append two steps (same `verify` job so the required check name is unchanged):

```yaml
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: E2E (Playwright)
        run: npm run test:e2e
```

- [ ] **Step 9: Full gate + commit**

Run: `npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build && npm run test:e2e`
Expected: all green.

```bash
git add package.json package-lock.json playwright.config.ts vitest.config.ts tests/e2e/smoke.spec.ts .github/workflows/ci.yml
git commit -m "test(e2e): scaffold Playwright + config + CI wiring"
```

---

## Task 2: create()/number seam + numbering service

**Why:** the mock's `create()` auto-assigns a number for any keyed entity (`numberPrefix`), which **clobbers** the `number: null` that a to-bill invoice must carry (`toBillInvoiceFromOrder` returns `number: null`, but `create` overwrites it with `INV-1`). And there is no seam to obtain the next `INV-#####` at **bill** time (the `Counter` is trapped inside the `createMockRepositories` closure). Fix create-input typing + null-number-on-create + number-assignment-at-bill together, before Invoicing depends on it.

**Files:**
- Modify: `lib/data/repositories/index.ts`
- Modify: `lib/data/mock/repositories.ts`
- Modify: `lib/data/mock/repositories.test.ts`
- Modify: `lib/logic/order.ts` (drop the WO `number` stopgap)
- Modify: `lib/logic/invoice.ts` (`NewInvoice = CreateInput<Invoice>`)
- Modify: `lib/logic/quote-state.ts` + `lib/logic/quote-state.test.ts` (`reviseQuote` drops number so a revision gets a fresh `Q-#`)

**Interfaces:**
- Produces:
  - `type CreateInput<T>` — base fields stripped and `number` (if the entity has one) made optional.
  - `type NumberedEntity = "quotes" | "workOrders" | "invoices" | "certifications"`.
  - `interface NumberService { next(entity: NumberedEntity): Promise<string> }`.
  - `Repositories.numbers: NumberService`.
  - `WriteRepo<T>.create(input: CreateInput<T>): Promise<T>`.
  - Rule: mock `create` auto-numbers a keyed entity **only when the input does not carry an explicit `number` property**. `createOrderFromQuote`/`reviseQuote` omit `number` (→ auto `WO-`/`Q-`); `toBillInvoiceFromOrder` passes `number: null` (→ preserved).
- Consumes: `Counter` (`lib/logic/numbering.ts`), seed `counters`.

- [ ] **Step 1: Write failing seam tests**

Append to `lib/data/mock/repositories.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockRepositories } from "./repositories";

describe("create()/number seam", () => {
  it("auto-numbers a work order on create (no explicit number in input)", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wo = await repos.workOrders.create({
      customerId: "cust-apex", customerPO: "PO-1", quoteId: null,
      processSummary: "Carburize", processMasterId: null, status: "received",
      orderedDate: "2026-06-30T00:00:00.000Z", due: "2026-07-10T00:00:00.000Z",
      certifyRequired: false, certSpecId: null, orderValueCents: 1000, progressPct: 0,
      lines: [], pricing: [], steps: [], activity: [],
    });
    expect(wo.number).toBe("WO-48212"); // seed counter WO- = 48211 → next 48212
  });

  it("preserves number:null on a to-bill invoice create (does NOT auto-assign INV-)", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const inv = await repos.invoices.create({
      number: null, customerId: "cust-apex", workOrderId: "wo-48211",
      amountCents: 5000, status: "to_bill",
      shippedDate: "2026-06-30T00:00:00.000Z", invoicedDate: null, paidDate: null,
    });
    expect(inv.number).toBeNull();
  });

  it("numbers.next assigns sequential INV- numbers from the seed counter", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    expect(await repos.numbers.next("invoices")).toBe("INV-30413"); // seed INV- = 30412 → next 30413
    expect(await repos.numbers.next("invoices")).toBe("INV-30414");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run lib/data/mock/repositories.test.ts`
Expected: FAIL — `repos.numbers` is undefined; the to-bill invoice gets `INV-...` instead of null.

- [ ] **Step 3: Add `CreateInput`, `NumberService`, `numbers` to the interfaces**

Edit `lib/data/repositories/index.ts`:

```ts
import type {
  Customer, Contact, Part, ProcessMaster, Specification, PriceKey, PricingRule,
  Quote, WorkOrder, Certification, Invoice, Operator,
} from "@/lib/domain";

/** Base fields are server-assigned; `number` (if the entity has one) is optional —
 *  omit it to let the number service assign one at create, or pass an explicit
 *  value (including `null`) to keep control (e.g. a to-bill invoice stays `null`). */
export type CreateInput<T> =
  Omit<T, "id" | "createdAt" | "updatedAt" | "version" | "number">
  & Partial<Pick<T, Extract<keyof T, "number">>>;

export interface ReadRepo<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
}

export interface WriteRepo<T extends { id: string }> extends ReadRepo<T> {
  create(input: CreateInput<T>): Promise<T>;
  update(id: string, patch: Partial<Omit<T, "id" | "createdAt" | "updatedAt" | "version">>, expectedVersion: number): Promise<T>;
}

export type NumberedEntity = "quotes" | "workOrders" | "invoices" | "certifications";
export interface NumberService {
  /** Returns the next sequential id/number for an entity type (e.g. "INV-30413"). */
  next(entity: NumberedEntity): Promise<string>;
}

export interface Repositories {
  customers: ReadRepo<Customer> & { byId(ids: string[]): Promise<Customer[]> };
  contacts: ReadRepo<Contact> & { byCustomer(customerId: string): Promise<Contact[]> };
  parts: WriteRepo<Part> & { byCustomer(customerId: string): Promise<Part[]> };
  processMasters: ReadRepo<ProcessMaster>;
  specifications: ReadRepo<Specification>;
  priceKeys: ReadRepo<PriceKey>;
  pricingRules: ReadRepo<PricingRule> & { byPriceKey(priceKeyId: string): Promise<PricingRule[]> };
  quotes: WriteRepo<Quote>;
  workOrders: WriteRepo<WorkOrder>;
  certifications: WriteRepo<Certification> & { byWorkOrder(workOrderId: string): Promise<Certification | null> };
  invoices: WriteRepo<Invoice>;
  operators: ReadRepo<Operator>;
  numbers: NumberService;
}
```

- [ ] **Step 4: Fix the mock `create()` + add the `numbers` service**

Edit `lib/data/mock/repositories.ts`. In `create`, only auto-number when the input has **no** explicit `number` property:

```ts
      async create(input) {
        await delay(latency, fail);
        const id = genId(key ?? "id");
        const explicitNumber = "number" in (input as object);
        const numbered = key && numberPrefix[key] && !explicitNumber
          ? { number: counter.next(numberPrefix[key]) }
          : {};
        const item = { ...(input as object), ...numbered, id, createdAt: NOW, updatedAt: NOW, version: 0 } as T;
        return col.insert(item);
      },
```

Add the `numbers` service to the returned object (the same `NumberedEntity` keys already exist in `numberPrefix`):

```ts
    invoices: write(cols.invoices, "invoices"),
    operators: read(cols.operators),
    numbers: {
      async next(entity) { await delay(latency, fail); return counter.next(numberPrefix[entity]); },
    },
  } as Repositories;
```

- [ ] **Step 5: Drop the WO number stopgap in `createOrderFromQuote`**

Edit `lib/logic/order.ts`:
- Change `export type NewWorkOrder = Omit<WorkOrder, "id" | "createdAt" | "updatedAt" | "version">;` to
  `import type { CreateInput } from "@/lib/data/repositories";` and `export type NewWorkOrder = CreateInput<WorkOrder>;`
- In the returned object, **remove** the `number: "",` line (so `create` auto-assigns `WO-`).

- [ ] **Step 6: Retype `NewInvoice` and confirm `toBillInvoiceFromOrder`**

Edit `lib/logic/invoice.ts`: change `export type NewInvoice = Omit<Invoice, "id" | "createdAt" | "updatedAt" | "version">;` to import `CreateInput` and `export type NewInvoice = CreateInput<Invoice>;`. Leave `toBillInvoiceFromOrder` returning `number: null` (explicit → preserved by `create`).

- [ ] **Step 7: `reviseQuote` drops number (fresh revision number)**

Edit `lib/logic/quote-state.ts`:

```ts
import type { Quote, Operator, QuoteStatus } from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { quoteTotalCents } from "./pricing";
// ... isEditable / requiresApproval / sendQuote / approveQuote / rejectQuote / winQuote / loseQuote unchanged ...

export function reviseQuote(quote: Quote): CreateInput<Quote> {
  const { id: _id, createdAt: _c, updatedAt: _u, version: _v, number: _n, ...rest } = quote;
  return { ...rest, status: "draft", rev: quote.rev + 1, wonOrderId: null };
}
```

Update `lib/logic/quote-state.test.ts` — the `reviseQuote` case must no longer expect a `number` key on the result (assert `expect("number" in result).toBe(false)` and `result.rev === quote.rev + 1`, `result.status === "draft"`, `result.wonOrderId === null`).

- [ ] **Step 8: Run — expect PASS**

Run: `npx vitest run lib/data/mock/repositories.test.ts lib/logic/quote-state.test.ts lib/logic/order.test.ts lib/logic/invoice.test.ts`
Expected: PASS. (If `order.test.ts` asserted `number === ""`, update it to assert the field is absent from `createOrderFromQuote`'s output.)

- [ ] **Step 9: Full gate + commit**

Run: `npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build`
Expected: all green.

```bash
git add lib/data/repositories/index.ts lib/data/mock/repositories.ts lib/data/mock/repositories.test.ts lib/logic/order.ts lib/logic/order.test.ts lib/logic/invoice.ts lib/logic/quote-state.ts lib/logic/quote-state.test.ts
git commit -m "feat(data): fix create/number seam + add numbering service"
```

---

## Task 3: A/R aging redesign (Net-terms, due-date based) + isLate end-of-day

**Why:** the current `agingBucket` uses a `< 7-day "current"` heuristic on invoice **age** (a documented stopgap), has a latent `NaN`-date path (a sent invoice with no valid ref date falls through to `d90_plus` = maximally past-due), and `isLate` flags an order due *today* as late from UTC midnight rather than end-of-business-day. Replace with proper Net-terms, **due-date-based** past-due aging with an end-of-day boundary and a NaN guard, before A/R (Task 14) is built.

**Files:**
- Modify: `lib/logic/ar.ts` + `lib/logic/ar.test.ts`
- Modify: `lib/logic/dashboard.ts` + `lib/logic/dashboard.test.ts`
- Modify: `app/(app)/today/page.tsx`

**Interfaces:**
- Produces (from `ar.ts`):
  - `parseNetDays(terms: string, fallback = 30): number` — `"Net 45" → 45`.
  - `netDaysByCustomer(customers: { id: string; terms: string }[]): Record<string, number>`.
  - `endOfDayUtcMs(iso: string): number` — end-of-day (23:59:59.999 UTC) of the date; `NaN` if unparseable.
  - `daysPastDue(invoice: Invoice, netDays: number, asOf: string): number` — 0 if not past due or ref date invalid.
  - `agingBucket(invoice: Invoice, netDays: number, asOf: string): Bucket` — **new 3-arg signature**.
  - `ageInvoices(invoices: Invoice[], netDaysByCustomerId: Record<string, number>, asOf: string): Record<Bucket, number>`.
  - `customerBalanceCents(invoices, customerId)` — unchanged.
  - `customerAging(invoices, customerId, netDays, asOf): { balanceCents; currentCents; pastDueCents; oldestDaysPastDue }`.
- Produces (from `dashboard.ts`): `isLate` (end-of-day), `pastDueCents(invoices, customers, asOf)`, `DashboardData` now includes `customers: Customer[]`.
- Consumes: `Invoice`, `Customer`.

- [ ] **Step 1: Write failing `ar.test.ts` cases**

Replace `lib/logic/ar.test.ts` contents with net-terms cases (keep the file's existing imports style):

```ts
import { describe, it, expect } from "vitest";
import type { Invoice } from "@/lib/domain";
import {
  parseNetDays, agingBucket, ageInvoices, customerAging, netDaysByCustomer,
} from "./ar";

const base = { id: "i", createdAt: "", updatedAt: "", version: 0, paidDate: null };
function sent(over: Partial<Invoice>): Invoice {
  return { ...base, number: "INV-1", customerId: "c1", workOrderId: "w1", amountCents: 10000,
    status: "sent", shippedDate: "2026-01-01T00:00:00.000Z", invoicedDate: "2026-01-01T00:00:00.000Z",
    ...over } as Invoice;
}

describe("parseNetDays", () => {
  it("parses Net terms", () => {
    expect(parseNetDays("Net 30")).toBe(30);
    expect(parseNetDays("Net 45")).toBe(45);
    expect(parseNetDays("weird")).toBe(30); // fallback
  });
});

describe("agingBucket (net-terms, due-date based)", () => {
  const inv = sent({ invoicedDate: "2026-01-01T00:00:00.000Z" }); // Net 30 → due 2026-01-31
  it("is current on/before the due date (end-of-day boundary)", () => {
    expect(agingBucket(inv, 30, "2026-01-31T00:00:00.000Z")).toBe("current"); // due today, not past
    expect(agingBucket(inv, 30, "2026-01-15T00:00:00.000Z")).toBe("current");
  });
  it("buckets by days past due", () => {
    expect(agingBucket(inv, 30, "2026-02-05T00:00:00.000Z")).toBe("d1_30");   // 5 days past
    expect(agingBucket(inv, 30, "2026-03-05T00:00:00.000Z")).toBe("d31_60");  // ~33 past
    expect(agingBucket(inv, 30, "2026-04-05T00:00:00.000Z")).toBe("d61_90");  // ~64 past
    expect(agingBucket(inv, 30, "2026-06-05T00:00:00.000Z")).toBe("d90_plus");
  });
  it("guards a NaN ref date as current (never maximally past-due)", () => {
    const bad = sent({ invoicedDate: null, shippedDate: "" });
    expect(agingBucket(bad, 30, "2026-06-05T00:00:00.000Z")).toBe("current");
  });
});

describe("ageInvoices + customerAging", () => {
  const invoices = [
    sent({ id: "a", customerId: "c1", amountCents: 10000, invoicedDate: "2026-01-01T00:00:00.000Z" }),
    sent({ id: "b", customerId: "c1", amountCents: 20000, invoicedDate: "2026-05-01T00:00:00.000Z" }),
    { ...sent({ id: "c", customerId: "c1" }), status: "to_bill" } as Invoice, // excluded
  ];
  const netDays = netDaysByCustomer([{ id: "c1", terms: "Net 30" }]);
  it("sums sent invoices into buckets, ignores non-sent", () => {
    const totals = ageInvoices(invoices, netDays, "2026-06-05T00:00:00.000Z");
    expect(totals.d90_plus).toBe(10000);
    expect(totals.d31_60).toBe(20000); // due 2026-05-31, ~5 days past on 2026-06-05 → wait: recompute
  });
  it("per-customer balance + oldest days past due", () => {
    const a = customerAging(invoices, "c1", 30, "2026-06-05T00:00:00.000Z");
    expect(a.balanceCents).toBe(30000);
    expect(a.pastDueCents).toBeGreaterThan(0);
    expect(a.oldestDaysPastDue).toBeGreaterThan(90);
  });
});
```

> Implementer note: the exact bucket in the `ageInvoices` case depends on `asOf` arithmetic — compute the expected values from your implementation's `daysPastDue` and pin them. The **behaviors** to lock are: due-today = current; NaN ref = current; non-sent excluded; `oldestDaysPastDue` reflects the oldest sent invoice.

- [ ] **Step 2: Run — expect FAIL** (`agingBucket` still 2-arg).

Run: `npx vitest run lib/logic/ar.test.ts` → FAIL.

- [ ] **Step 3: Rewrite `lib/logic/ar.ts`**

```ts
import type { Invoice } from "@/lib/domain";

export type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

const DAY = 86_400_000;

export function parseNetDays(terms: string, fallback = 30): number {
  const m = /(\d+)/.exec(terms);
  return m ? parseInt(m[1], 10) : fallback;
}

export function netDaysByCustomer(customers: { id: string; terms: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of customers) out[c.id] = parseNetDays(c.terms);
  return out;
}

/** End-of-day (23:59:59.999 UTC) of an ISO date; NaN if unparseable. */
export function endOfDayUtcMs(iso: string): number {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return NaN;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999);
}

function dueMs(invoice: Invoice, netDays: number): number {
  const ref = invoice.invoicedDate ?? invoice.shippedDate;
  const t = new Date(ref).getTime();
  return Number.isNaN(t) ? NaN : t + netDays * DAY;
}

export function daysPastDue(invoice: Invoice, netDays: number, asOf: string): number {
  const due = dueMs(invoice, netDays);
  if (Number.isNaN(due)) return 0; // NaN-date guard: never treat as past due
  const diff = endOfDayUtcMs(asOf) - due;
  return diff <= 0 ? 0 : Math.floor(diff / DAY);
}

export function agingBucket(invoice: Invoice, netDays: number, asOf: string): Bucket {
  const d = daysPastDue(invoice, netDays, asOf);
  if (d <= 0) return "current";
  if (d <= 30) return "d1_30";
  if (d <= 60) return "d31_60";
  if (d <= 90) return "d61_90";
  return "d90_plus";
}

export function ageInvoices(
  invoices: Invoice[], netDaysByCustomerId: Record<string, number>, asOf: string,
): Record<Bucket, number> {
  const totals: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const inv of invoices) {
    if (inv.status !== "sent") continue;
    const nd = netDaysByCustomerId[inv.customerId] ?? 30;
    totals[agingBucket(inv, nd, asOf)] += inv.amountCents;
  }
  return totals;
}

export function customerBalanceCents(invoices: Invoice[], customerId: string): number {
  return invoices.filter((i) => i.customerId === customerId && i.status === "sent")
    .reduce((s, i) => s + i.amountCents, 0);
}

export function customerAging(
  invoices: Invoice[], customerId: string, netDays: number, asOf: string,
): { balanceCents: number; currentCents: number; pastDueCents: number; oldestDaysPastDue: number } {
  const sent = invoices.filter((i) => i.customerId === customerId && i.status === "sent");
  let currentCents = 0, pastDueCents = 0, oldestDaysPastDue = 0;
  for (const inv of sent) {
    const d = daysPastDue(inv, netDays, asOf);
    if (d <= 0) currentCents += inv.amountCents;
    else { pastDueCents += inv.amountCents; oldestDaysPastDue = Math.max(oldestDaysPastDue, d); }
  }
  return { balanceCents: currentCents + pastDueCents, currentCents, pastDueCents, oldestDaysPastDue };
}
```

- [ ] **Step 4: Update `dashboard.ts` for the new signatures + end-of-day `isLate`**

Edit `lib/logic/dashboard.ts`:
- Import: `import { agingBucket, netDaysByCustomer, endOfDayUtcMs } from "./ar";` and add `Customer` to the domain import.
- Replace `isLate`:

```ts
export function isLate(order: WorkOrder, asOf: string): boolean {
  if (order.status === "shipped") return false;
  return endOfDayUtcMs(order.due) < new Date(asOf).getTime();
}
```

- Replace `pastDueCents` (now needs customers for net terms):

```ts
export function pastDueCents(invoices: Invoice[], customers: Customer[], asOf: string): number {
  const nd = netDaysByCustomer(customers);
  return invoices
    .filter((i) => i.status === "sent" && agingBucket(i, nd[i.customerId] ?? 30, asOf) !== "current")
    .reduce((s, i) => s + i.amountCents, 0);
}
```

- Add `customers` to `DashboardData`:

```ts
export type DashboardData = {
  orders: WorkOrder[]; quotes: Quote[]; invoices: Invoice[]; certifications: Certification[]; customers: Customer[];
};
```

- In `dashboardKpis`, destructure `customers` and change the office branch's Past-Due tile to `formatMoney(pastDueCents(invoices, customers, asOf))`.

- [ ] **Step 5: Update `dashboard.test.ts`**

Update the office-role KPI test and any `pastDueCents`/`isLate` cases to the new signatures. Add an `isLate` boundary case: an order `due` at `T00:00:00Z` on the same UTC day as `asOf` is **not** late (end-of-day). Add `customers` to the `DashboardData` fixtures.

- [ ] **Step 6: Thread `customers` into the Today page**

Edit `app/(app)/today/page.tsx`: add `useCustomers` to the imports and hook calls, include it in the loading/error guards, and pass `customers: customers.data ?? []` inside the `dashboardKpis(...)` data object.

- [ ] **Step 7: Run — expect PASS**

Run: `npx vitest run lib/logic/ar.test.ts lib/logic/dashboard.test.ts app/\(app\)/today/today-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Full gate + commit**

Run: `npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build`

```bash
git add lib/logic/ar.ts lib/logic/ar.test.ts lib/logic/dashboard.ts lib/logic/dashboard.test.ts "app/(app)/today/page.tsx"
git commit -m "feat(logic): net-terms A/R aging + end-of-day isLate"
```

---

## Task 4: Quote-builder pure logic + cert-from-order helper

**Why:** the multi-part builder (Task 9) and the win→order flow (Task 5) need pure, unit-tested helpers so the screens stay thin: rate lookup from pricing rules, assembling a `CreateInput<Quote>` draft, quote date math, the margin cost stub, the cert entity created alongside a won order, and a small activity-entry helper.

**Files:**
- Create: `lib/logic/quote-builder.ts` + `lib/logic/quote-builder.test.ts`
- Modify: `lib/logic/order.ts` + `lib/logic/order.test.ts` (add `createCertForOrder`, `activityEntry`)

**Interfaces:**
- Produces (from `quote-builder.ts`):
  - `rateForLine(rules: PricingRule[], process: string, basis: PricingBasis): { rateCents: number; minChargeCents: number | null }` — first matching rule by process+basis; `{ rateCents: 0, minChargeCents: null }` if none.
  - `quoteDates(todayIso: string): { date: string; validUntil: string }` — `validUntil = date + 30 days`.
  - `STUB_COST_RATIO = 0.58` and `buildQuoteDraft(args, todayIso): CreateInput<Quote>` where
    `args = { customerId; customerPO; salespersonId; requiredBy: string | null; discount: Discount | null; notes: string; parts: QuotePart[] }`.
    Sets `status: "draft"`, `rev: 0`, `wonOrderId: null`, `estCostCents = round(total * STUB_COST_RATIO)` (so margin displays ~42%), dates from `quoteDates`.
- Produces (from `order.ts`):
  - `createCertForOrder(order: WorkOrder, customer: Customer): CreateInput<Certification>` — `status: "pending"`, `copies: customer.defaultCertCopies`, `specificationId: order.certSpecId`, `type: order.processSummary`.
  - `activityEntry(actor: string, message: string, at: string): ActivityEntry`.
- Consumes: `quoteSubtotalCents`, `quoteTotalCents`, `applyDiscountCents` (pricing), `CreateInput`, domain types.

- [ ] **Step 1: Write failing `quote-builder.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { PricingRule, QuotePart } from "@/lib/domain";
import { rateForLine, quoteDates, buildQuoteDraft, STUB_COST_RATIO } from "./quote-builder";

const rules: PricingRule[] = [
  { id: "r1", createdAt: "", updatedAt: "", version: 0, priceKeyId: "pk", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
  { id: "r2", createdAt: "", updatedAt: "", version: 0, priceKeyId: "pk", process: "Temper", basis: "per_lot", rateCents: 144000, minChargeCents: null },
];

describe("rateForLine", () => {
  it("finds the rule by process + basis", () => {
    expect(rateForLine(rules, "Carburize", "per_lb")).toEqual({ rateCents: 1030, minChargeCents: 25000 });
  });
  it("returns zero rate when no rule matches", () => {
    expect(rateForLine(rules, "Nitride", "per_lb")).toEqual({ rateCents: 0, minChargeCents: null });
  });
});

describe("quoteDates", () => {
  it("sets validUntil 30 days after date", () => {
    const { date, validUntil } = quoteDates("2026-07-01T00:00:00.000Z");
    expect(date).toBe("2026-07-01T00:00:00.000Z");
    expect(validUntil).toBe("2026-07-31T00:00:00.000Z");
  });
});

describe("buildQuoteDraft", () => {
  const parts: QuotePart[] = [{
    id: "qp1", partId: "part-ts4471", material: "4140 steel", quantity: 480,
    lines: [
      { id: "l1", process: "Carburize", basis: "per_lb", qtyOrWeight: 600, rateCents: 1030, minChargeCents: 25000 }, // 618000
      { id: "l2", process: "Temper", basis: "per_lot", qtyOrWeight: 1, rateCents: 144000, minChargeCents: null },     // 144000
    ],
  }];
  it("assembles a draft with computed stub cost and no number field", () => {
    const draft = buildQuoteDraft(
      { customerId: "cust-apex", customerPO: "PO-1", salespersonId: "op-vance", requiredBy: null, discount: null, notes: "", parts },
      "2026-07-01T00:00:00.000Z",
    );
    expect(draft.status).toBe("draft");
    expect(draft.rev).toBe(0);
    expect(draft.wonOrderId).toBeNull();
    expect("number" in draft).toBe(false); // create() assigns Q-#
    expect(draft.estCostCents).toBe(Math.round((618000 + 144000) * STUB_COST_RATIO));
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run lib/logic/quote-builder.test.ts` → module not found.

- [ ] **Step 3: Implement `lib/logic/quote-builder.ts`**

```ts
import type { CreateInput } from "@/lib/data/repositories";
import type { Quote, QuotePart, PricingRule, PricingBasis, Discount } from "@/lib/domain";
import { quoteTotalCents } from "./pricing";

const DAY = 86_400_000;
export const STUB_COST_RATIO = 0.58; // margin display stub (~42%); real cost model is a later spec

export function rateForLine(
  rules: PricingRule[], process: string, basis: PricingBasis,
): { rateCents: number; minChargeCents: number | null } {
  const r = rules.find((x) => x.process === process && x.basis === basis);
  return r ? { rateCents: r.rateCents, minChargeCents: r.minChargeCents } : { rateCents: 0, minChargeCents: null };
}

export function quoteDates(todayIso: string): { date: string; validUntil: string } {
  const t = new Date(todayIso).getTime();
  return { date: todayIso, validUntil: new Date(t + 30 * DAY).toISOString() };
}

export function buildQuoteDraft(
  args: {
    customerId: string; customerPO: string; salespersonId: string;
    requiredBy: string | null; discount: Discount | null; notes: string; parts: QuotePart[];
  },
  todayIso: string,
): CreateInput<Quote> {
  const { date, validUntil } = quoteDates(todayIso);
  const total = quoteTotalCents({ parts: args.parts, discount: args.discount });
  return {
    rev: 0, customerId: args.customerId, customerPO: args.customerPO, status: "draft",
    salespersonId: args.salespersonId, date, validUntil, requiredBy: args.requiredBy,
    discount: args.discount, estCostCents: Math.round(total * STUB_COST_RATIO),
    notes: args.notes, parts: args.parts, wonOrderId: null,
  };
}
```

- [ ] **Step 4: Add `createCertForOrder` + `activityEntry` failing test to `order.test.ts`**

```ts
import { createCertForOrder, activityEntry } from "./order";
// ...
describe("createCertForOrder", () => {
  it("builds a pending cert from the order + customer default copies", () => {
    const order = { id: "wo-x", customerId: "cust-apex", processSummary: "Carburize + Temper", certSpecId: "spec-ams2759-3", certifyRequired: true } as any;
    const customer = { defaultCertCopies: 2 } as any;
    const cert = createCertForOrder(order, customer);
    expect(cert).toMatchObject({ customerId: "cust-apex", workOrderId: "wo-x", specificationId: "spec-ams2759-3", status: "pending", copies: 2, type: "Carburize + Temper" });
    expect("number" in cert).toBe(false); // create() assigns C-#
  });
});
describe("activityEntry", () => {
  it("builds an activity entry", () => {
    expect(activityEntry("Dana", "Shipped", "2026-07-01T00:00:00.000Z"))
      .toEqual({ actor: "Dana", message: "Shipped", at: "2026-07-01T00:00:00.000Z" });
  });
});
```

- [ ] **Step 5: Implement in `lib/logic/order.ts`**

Add imports `Certification`, `ActivityEntry` to the domain import, then:

```ts
export function createCertForOrder(order: WorkOrder, customer: Customer): CreateInput<Certification> {
  return {
    customerId: order.customerId,
    workOrderId: order.id,
    specificationId: order.certSpecId,
    type: order.processSummary,
    status: "pending",
    copies: customer.defaultCertCopies,
  };
}

export function activityEntry(actor: string, message: string, at: string): ActivityEntry {
  return { actor, message, at };
}
```

(Add `import type { CreateInput } from "@/lib/data/repositories";` if not already present from Task 2.)

- [ ] **Step 6: Run — expect PASS.** `npx vitest run lib/logic/quote-builder.test.ts lib/logic/order.test.ts`

- [ ] **Step 7: Full gate + commit**

```bash
git add lib/logic/quote-builder.ts lib/logic/quote-builder.test.ts lib/logic/order.ts lib/logic/order.test.ts
git commit -m "feat(logic): quote-builder helpers + createCertForOrder"
```

---

## Task 5: Quote mutations

**Why:** wire the quote lifecycle write paths into TanStack Query. Win auto-creates the WorkOrder **and** its Certification (a `certifyRequired` order with no cert can never pass the ship gate) and stamps `wonOrderId` on the quote.

**Files:**
- Modify: `lib/query/hooks.ts`
- Create: append to `tests/mutation-hooks.test.tsx` (probe components, same pattern as the existing `useUpdatePart` probe)

**Interfaces:**
- Produces:
  - `useCreateQuoteDraft()` → `mutate(input: CreateInput<Quote>)`.
  - `useUpdateQuote()` → `mutate({ id, patch, version })`.
  - `useSendQuote()` → `mutate({ quote, operator })` (applies `sendQuote` → status `sent`|`approve`).
  - `useApproveQuote()` / `useRejectQuote()` → `mutate({ quote })`.
  - `useWinQuote()` → `mutate(quote)` (creates WO from `createOrderFromQuote`; if `certifyRequired`, creates cert from `createCertForOrder`; updates quote `{status:"won", wonOrderId}`).
  - `useLoseQuote()` → `mutate({ quote })`.
  - `useReviseQuote()` → `mutate(quote)` (creates a fresh draft revision).
- Consumes: repos, pure fns from `quote-state.ts`/`order.ts`, `queryKeys`.

- [ ] **Step 1: Write failing probe tests** in `tests/mutation-hooks.test.tsx`:

```ts
import { useQuotes, useWorkOrders, useCertifications } from "@/lib/query/hooks";
import { useWinQuote } from "@/lib/query/hooks";

function WinQuoteProbe() {
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const win = useWinQuote();
  const q = quotes.data?.find((x) => x.id === "q-2840"); // sent, Midwest, certifyRequired via customer? Midwest defaultCertSpecId null → cert not required
  const orderCount = orders.data?.length ?? 0;
  return (
    <div>
      <div data-testid="status">{q?.status ?? "loading"}</div>
      <div data-testid="orders">{orderCount}</div>
      <button onClick={() => q && win.mutate(q)} disabled={!q}>Win</button>
    </div>
  );
}

describe("quote mutations", () => {
  it("useWinQuote: creates an order and marks the quote won", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WinQuoteProbe />);
    await screen.findByText("sent");
    const before = Number(screen.getByTestId("orders").textContent);
    await user.click(screen.getByRole("button", { name: "Win" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("won"));
    await waitFor(() => expect(Number(screen.getByTestId("orders").textContent)).toBe(before + 1));
  });
});
```

> Use `q-2840` (status `sent`, customer Midwest whose `defaultCertSpecId` is `null` → `certifyRequired` false → no cert created, simplest win-path assertion). A cert-creating win is covered by the E2E (Apex).

- [ ] **Step 2: Run — expect FAIL** (`useWinQuote` undefined).

- [ ] **Step 3: Implement the quote mutations** in `lib/query/hooks.ts`. Add imports:

```ts
import type { Quote, Operator, WorkOrder, OrderStatus, Certification, Invoice } from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { sendQuote, approveQuote, rejectQuote, loseQuote, reviseQuote } from "@/lib/logic/quote-state";
import { createOrderFromQuote, createCertForOrder, canTransitionOrder, canShipOrder, activityEntry } from "@/lib/logic/order";
import { toBillInvoiceFromOrder, billInvoice, payInvoice } from "@/lib/logic/invoice";
import { orderStatusMeta } from "@/lib/domain/enums";
```

Then:

```ts
export function useCreateQuoteDraft() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInput<Quote>) => r.quotes.create(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.quotes }); },
  });
}

export function useUpdateQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Omit<Quote, "id" | "createdAt" | "updatedAt" | "version">>; version: number }) =>
      r.quotes.update(vars.id, vars.patch, vars.version),
    onSuccess: (u) => { qc.invalidateQueries({ queryKey: queryKeys.quotes }); qc.invalidateQueries({ queryKey: queryKeys.quote(u.id) }); },
  });
}

function invalidateQuote(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: queryKeys.quotes });
  qc.invalidateQueries({ queryKey: queryKeys.quote(id) });
}

export function useSendQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote; operator: Operator }) => {
      const { status } = sendQuote(vars.quote, vars.operator);
      return r.quotes.update(vars.quote.id, { status }, vars.quote.version);
    },
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useApproveQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote }) => r.quotes.update(vars.quote.id, { status: approveQuote(vars.quote).status }, vars.quote.version),
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useRejectQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote }) => r.quotes.update(vars.quote.id, { status: rejectQuote(vars.quote).status }, vars.quote.version),
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useLoseQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { quote: Quote }) => r.quotes.update(vars.quote.id, { status: loseQuote(vars.quote).status }, vars.quote.version),
    onSuccess: (u) => invalidateQuote(qc, u.id),
  });
}

export function useWinQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (quote: Quote) => {
      const [parts, pms, customer] = await Promise.all([
        r.parts.list(), r.processMasters.list(), r.customers.get(quote.customerId),
      ]);
      if (!customer) throw new Error("Customer not found: " + quote.customerId);
      const partsById = Object.fromEntries(parts.map((p) => [p.id, p]));
      const processMastersById = Object.fromEntries(pms.map((m) => [m.id, m]));
      const order = await r.workOrders.create(createOrderFromQuote(quote, { partsById, processMastersById, customer }));
      if (order.certifyRequired) await r.certifications.create(createCertForOrder(order, customer));
      return r.quotes.update(quote.id, { status: "won", wonOrderId: order.id }, quote.version);
    },
    onSuccess: (u) => {
      invalidateQuote(qc, u.id);
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.certifications });
    },
  });
}

export function useReviseQuote() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (quote: Quote) => r.quotes.create(reviseQuote(quote)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.quotes }); },
  });
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run tests/mutation-hooks.test.tsx`

- [ ] **Step 5: Full gate + commit**

```bash
git add lib/query/hooks.ts tests/mutation-hooks.test.tsx
git commit -m "feat(query): quote lifecycle mutations (create/send/approve/win/lose/revise)"
```

---

## Task 6: Order mutations (transition + ship)

**Files:** Modify `lib/query/hooks.ts`; append probes to `tests/mutation-hooks.test.tsx`.

**Interfaces:**
- Produces:
  - `useTransitionOrder()` → `mutate({ order, to, actor, at })` — guarded by `canTransitionOrder`; appends an activity entry.
  - `useShipOrder()` → `mutate({ order, cert, actor, at })` — guarded by `canShipOrder`; creates the to-bill invoice, sets `status:"shipped"`, `progressPct:100`, appends activity. Throws (with `gate.reason`) when blocked.
- Consumes: `canTransitionOrder`, `canShipOrder`, `toBillInvoiceFromOrder`, `activityEntry`, `orderStatusMeta`.

- [ ] **Step 1: Failing probe** — render an order (`wo-48120`, `ready_to_ship`, cert `cert-9910` released), click Ship, assert status → `shipped` and invoices count increments.

```ts
function ShipProbe() {
  const orders = useWorkOrders();
  const certs = useCertifications();
  const invoices = useInvoices();
  const ship = useShipOrder();
  const order = orders.data?.find((o) => o.id === "wo-48120");
  const cert = certs.data?.find((c) => c.workOrderId === "wo-48120") ?? null;
  return (
    <div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <div data-testid="invoices">{invoices.data?.length ?? 0}</div>
      <button disabled={!order} onClick={() => order && ship.mutate({ order, cert, actor: "Test", at: "2026-07-01T00:00:00.000Z" })}>Ship</button>
    </div>
  );
}
// asserts: status "ready_to_ship" → click → "shipped"; invoices length +1
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```ts
export function useTransitionOrder() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { order: WorkOrder; to: OrderStatus; actor: string; at: string }) => {
      if (!canTransitionOrder(vars.order.status, vars.to)) {
        throw new Error(`Illegal transition ${vars.order.status} → ${vars.to}`);
      }
      const activity = [...vars.order.activity, activityEntry(vars.actor, `Status → ${orderStatusMeta[vars.to].label}`, vars.at)];
      return r.workOrders.update(vars.order.id, { status: vars.to, activity }, vars.order.version);
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
    },
  });
}

export function useShipOrder() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { order: WorkOrder; cert: Certification | null; actor: string; at: string }) => {
      const gate = canShipOrder(vars.order, vars.cert);
      if (!gate.ok) throw new Error(gate.reason ?? "Cannot ship");
      await r.invoices.create(toBillInvoiceFromOrder(vars.order, vars.at));
      const activity = [...vars.order.activity, activityEntry(vars.actor, "Shipped — to-bill invoice created", vars.at)];
      return r.workOrders.update(vars.order.id, { status: "shipped", progressPct: 100, activity }, vars.order.version);
    },
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: queryKeys.workOrders });
      qc.invalidateQueries({ queryKey: queryKeys.workOrder(u.id) });
      qc.invalidateQueries({ queryKey: queryKeys.invoices });
    },
  });
}
```

- [ ] **Step 4: Run — expect PASS. Step 5: gate + commit.**

```bash
git add lib/query/hooks.ts tests/mutation-hooks.test.tsx
git commit -m "feat(query): order transition + cert-gated ship mutations"
```

---

## Task 7: Invoice mutations (bill + record payment)

**Files:** Modify `lib/query/hooks.ts`; append probes to `tests/mutation-hooks.test.tsx`.

**Interfaces:**
- Produces:
  - `useBillInvoice()` → `mutate({ invoice, at })` — obtains `INV-#####` via `r.numbers.next("invoices")`, applies `billInvoice`, updates `{status:"sent", number, invoicedDate}`.
  - `usePayInvoice()` → `mutate({ invoice, at })` — applies `payInvoice`, updates `{status:"paid", paidDate}`.
- Consumes: `r.numbers`, `billInvoice`, `payInvoice`.

- [ ] **Step 1: Failing probe** — a to-bill invoice (`inv-summit-48120`, `number:null`): click Bill → number becomes `INV-30413`, status `sent`.

```ts
function BillProbe() {
  const invoices = useInvoices();
  const bill = useBillInvoice();
  const inv = invoices.data?.find((i) => i.id === "inv-summit-48120");
  return (
    <div>
      <div data-testid="num">{inv?.number ?? "null"}</div>
      <div data-testid="status">{inv?.status ?? "loading"}</div>
      <button disabled={!inv} onClick={() => inv && bill.mutate({ invoice: inv, at: "2026-07-01T00:00:00.000Z" })}>Bill</button>
    </div>
  );
}
// asserts: num "null" & status "to_bill" → click → num "INV-30413" & status "sent"
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement**

```ts
export function useBillInvoice() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { invoice: Invoice; at: string }) => {
      const number = await r.numbers.next("invoices");
      const billed = billInvoice(vars.invoice, number, vars.at);
      return r.invoices.update(vars.invoice.id, { status: billed.status, number: billed.number, invoicedDate: billed.invoicedDate }, vars.invoice.version);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.invoices }); },
  });
}

export function usePayInvoice() {
  const r = useRepositories(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invoice: Invoice; at: string }) => {
      const paid = payInvoice(vars.invoice, vars.at);
      return r.invoices.update(vars.invoice.id, { status: paid.status, paidDate: paid.paidDate }, vars.invoice.version);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.invoices }); },
  });
}
```

- [ ] **Step 4: Run — expect PASS. Step 5: gate + commit.**

```bash
git add lib/query/hooks.ts tests/mutation-hooks.test.tsx
git commit -m "feat(query): invoice bill (assign INV#) + record-payment mutations"
```

---

## Task 8: Quotes list screen

**Files:** Create `components/quotes/quotes-list.tsx` (+ `.test.tsx`); replace `app/(app)/quotes/page.tsx`.

**Interfaces:**
- Produces: `QuotesList({ quotes, customers, onSelect })` — renders a `ListCard`; row click → `onSelect(id)`.
- Consumes: `useQuotes`, `useCustomers`, `quoteStatusMeta`, `quoteTotalCents`, `formatMoney`, `formatDate`.

- [ ] **Step 1: Failing component test**

```tsx
// components/quotes/quotes-list.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuotesList } from "./quotes-list";
import type { Quote, Customer } from "@/lib/domain";

const customers = [{ id: "c1", name: "Apex Aerospace" } as Customer];
const quotes = [{
  id: "q1", number: "Q-2841", rev: 0, customerId: "c1", customerPO: "PO", status: "sent",
  salespersonId: "op", date: "2026-06-30T00:00:00.000Z", validUntil: "2026-07-30T00:00:00.000Z",
  requiredBy: null, discount: null, estCostCents: 0, notes: "", wonOrderId: null,
  parts: [{ id: "p", partId: "part", material: "4140", quantity: 1,
    lines: [{ id: "l", process: "Carburize", basis: "flat", qtyOrWeight: 1, rateCents: 80000, minChargeCents: null }] }],
  createdAt: "", updatedAt: "", version: 0,
} as Quote];

describe("QuotesList", () => {
  it("renders quote number, customer, total, status and fires onSelect", async () => {
    const onSelect = vi.fn();
    render(<QuotesList quotes={quotes} customers={customers} onSelect={onSelect} />);
    expect(screen.getByText("Q-2841")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("$800")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Q-2841"));
    expect(onSelect).toHaveBeenCalledWith("q1");
  });
});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement `components/quotes/quotes-list.tsx`**

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { quoteStatusMeta } from "@/lib/domain/enums";
import { quoteTotalCents } from "@/lib/logic/pricing";
import { formatMoney, formatDate } from "@/lib/utils";
import type { Quote, Customer } from "@/lib/domain";

export function QuotesList({ quotes, customers, onSelect }: {
  quotes: Quote[]; customers: Customer[]; onSelect?: (id: string) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  return (
    <ListCard
      headers={["QUOTE", "CUSTOMER", "DATE", "PARTS", "TOTAL", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(quotes[i].id) : undefined}
      rows={quotes.map((q) => {
        const meta = quoteStatusMeta[q.status];
        const label = q.rev > 0 ? `${q.number} · rev ${q.rev}` : q.number;
        return [
          <MonoId key="q">{label}</MonoId>,
          custById.get(q.customerId)?.name ?? "—",
          <span key="d" className="text-text-muted">{formatDate(q.date)}</span>,
          <span key="p" className="font-mono">{q.parts.length}</span>,
          <span key="t" className="font-mono">{formatMoney(quoteTotalCents(q))}</span>,
          <StatusPill key="s" tone={meta.tone}>{meta.label}</StatusPill>,
        ];
      })}
    />
  );
}
```

- [ ] **Step 4: Replace `app/(app)/quotes/page.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useQuotes, useCustomers } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { QuotesList } from "@/components/quotes/quotes-list";

export default function QuotesPage() {
  const router = useRouter();
  const quotes = useQuotes();
  const customers = useCustomers();
  return (
    <div>
      <PageHeader
        title="Quotes"
        subtitle="Estimates in flight — draft, sent, awaiting approval, won and lost."
        action={<Button onClick={() => router.push("/quotes/new")}>New quote</Button>}
      />
      {quotes.isLoading ? <SkeletonRows />
        : quotes.isError ? <ErrorPanel message="Failed to load quotes." onRetry={() => quotes.refetch()} />
        : !quotes.data || quotes.data.length === 0 ? <EmptyState title="No quotes" />
        : <QuotesList quotes={quotes.data} customers={customers.data ?? []} onSelect={(id) => router.push(`/quotes/${id}`)} />}
    </div>
  );
}
```

- [ ] **Step 5: Run component test + gate + commit**

```bash
git add components/quotes/quotes-list.tsx components/quotes/quotes-list.test.tsx "app/(app)/quotes/page.tsx"
git commit -m "feat(quotes): Quotes list screen"
```

---

## Task 9: Quote builder (create) screen

**Why:** the multi-part builder is the workflow's front door. Uses **native `<select>`** elements (Radix Select needs `hasPointerCapture`, unreliable in jsdom; native selects are fully testable in jsdom + Playwright and keep token styling via className). Local controlled state (not react-hook-form) because the form is a dynamic tree of parts→lines; validation is a simple guard on submit.

**Files:** Create `components/quotes/quote-builder.tsx` (+ `.test.tsx`); replace `app/(app)/quotes/new/page.tsx`.

**Interfaces:**
- Produces: `QuoteBuilder({ customers, parts, pricingRules, salespersonId, canDiscount, todayIso, initial, submitting, onSaveDraft, onSend })`:
  - `pricingRules: PricingRule[]` — rules for the **selected customer's** price key (the page refetches on customer change).
  - `initial?: BuilderState | null` — for edit prefill (Task 10 reuses this component).
  - `onSaveDraft(input: CreateInput<Quote>)`, `onSend(input: CreateInput<Quote>)` — both receive the assembled draft.
  - Renders a live `SummaryRail` (subtotal / discount / total / margin) via `quoteSubtotalCents`/`quoteTotalCents`/`marginPct`; the total carries `data-testid="quote-total"`.
  - Exposes `export type BuilderState` and `export function stateToDraft(state, args, todayIso): CreateInput<Quote>` for reuse/testing.
- Consumes: `rateForLine`, `buildQuoteDraft`, pricing pure fns, `PricingBasis` enum, `basisLabel`.

- [ ] **Step 1: Failing component test** (add a part, add a line, live total reflects min-charge floor, Save fires with assembled parts):

```tsx
// components/quotes/quote-builder.test.tsx (essentials)
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuoteBuilder } from "./quote-builder";
import type { Customer, Part, PricingRule } from "@/lib/domain";

const customers = [{ id: "cust-apex", name: "Apex Aerospace", priceKeyId: "pk", customerNumber: "1042" } as Customer];
const parts = [{ id: "part-ts4471", partNumber: "TS-4471", description: "Turbine shaft", material: "4140 steel", customerId: "cust-apex" } as Part];
const rules: PricingRule[] = [
  { id: "r", createdAt: "", updatedAt: "", version: 0, priceKeyId: "pk", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
];

function setup(onSaveDraft = vi.fn(), onSend = vi.fn()) {
  render(<QuoteBuilder customers={customers} parts={parts} pricingRules={rules}
    salespersonId="op-vance" canDiscount todayIso="2026-07-01T00:00:00.000Z"
    submitting={false} onSaveDraft={onSaveDraft} onSend={onSend} />);
  return { onSaveDraft, onSend };
}

describe("QuoteBuilder", () => {
  it("adds a part + line, computes a live total honoring the min-charge floor, and saves the draft", async () => {
    const user = userEvent.setup();
    const { onSaveDraft } = setup();
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-apex");
    await user.click(screen.getByRole("button", { name: /add part/i }));
    const block = screen.getByTestId("part-block-0");
    await user.selectOptions(within(block).getByLabelText("Part"), "part-ts4471");
    await user.type(within(block).getByLabelText("Quantity"), "480");
    await user.click(within(block).getByRole("button", { name: /add line/i }));
    const line = within(block).getByTestId("line-0");
    await user.selectOptions(within(line).getByLabelText("Process"), "Carburize");
    await user.selectOptions(within(line).getByLabelText("Basis"), "per_lb");
    // rate prefilled from the rule (1030); enter a below-floor weight (10 lb → 10300 < 25000 min)
    await user.type(within(line).getByLabelText("Qty / weight"), "10");
    expect(screen.getByTestId("quote-total")).toHaveTextContent("$250"); // min-charge floor
    await user.click(screen.getByRole("button", { name: /save draft/i }));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    const draft = onSaveDraft.mock.calls[0][0];
    expect(draft.customerId).toBe("cust-apex");
    expect(draft.parts[0].lines[0]).toMatchObject({ process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement `components/quotes/quote-builder.tsx`**

Full component (native selects; ids generated with a monotonic ref counter; rate/minCharge prefill from `rateForLine` when process+basis are set; live summary via pricing pure fns):

```tsx
"use client";
import { useRef, useState } from "react";
import type { CreateInput } from "@/lib/data/repositories";
import type { Customer, Part, PricingRule, PricingBasis, Discount, Quote } from "@/lib/domain";
import { PRICING_BASES, basisLabel } from "@/lib/domain/enums";
import { rateForLine, buildQuoteDraft } from "@/lib/logic/quote-builder";
import { quoteSubtotalCents, quoteTotalCents, lineAmountCents, marginPct } from "@/lib/logic/pricing";
import { PageHeader, SummaryRail, FormField } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { formatMoney } from "@/lib/utils";

type LineState = { id: string; process: string; basis: PricingBasis; qtyOrWeight: number; rateCents: number; minChargeCents: number | null };
type PartState = { id: string; partId: string; material: string; quantity: number; lines: LineState[] };
export type BuilderState = { customerPO: string; requiredBy: string; notes: string; discount: Discount | null; parts: PartState[] };

const PROCESS_OPTIONS = ["Carburize", "Carbonitride", "Nitride", "Neutral harden", "Vacuum harden", "Temper", "Anneal", "Certification"];
const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm";

export function QuoteBuilder({
  customers, parts, pricingRules, salespersonId, canDiscount, todayIso, initial,
  initialCustomerId, submitting, onSaveDraft, onSend,
}: {
  customers: Customer[]; parts: Part[]; pricingRules: PricingRule[];
  salespersonId: string; canDiscount: boolean; todayIso: string;
  initial?: BuilderState | null; initialCustomerId?: string; submitting: boolean;
  onSaveDraft: (input: CreateInput<Quote>) => void; onSend: (input: CreateInput<Quote>) => void;
}) {
  const seq = useRef(0);
  const nid = (p: string) => `${p}-${(seq.current += 1)}`;
  const [customerId, setCustomerId] = useState(initialCustomerId ?? "");
  const [state, setState] = useState<BuilderState>(initial ?? { customerPO: "", requiredBy: "", notes: "", discount: null, parts: [] });

  const customerParts = parts.filter((p) => p.customerId === customerId);

  function addPart() {
    setState((s) => ({ ...s, parts: [...s.parts, { id: nid("qp"), partId: "", material: "", quantity: 0, lines: [] }] }));
  }
  function removePart(pi: number) {
    setState((s) => ({ ...s, parts: s.parts.filter((_, i) => i !== pi) }));
  }
  function patchPart(pi: number, patch: Partial<PartState>) {
    setState((s) => ({ ...s, parts: s.parts.map((p, i) => (i === pi ? { ...p, ...patch } : p)) }));
  }
  function addLine(pi: number) {
    patchPart(pi, { lines: [...state.parts[pi].lines, { id: nid("ql"), process: "", basis: "per_lb", qtyOrWeight: 0, rateCents: 0, minChargeCents: null }] });
  }
  function patchLine(pi: number, li: number, patch: Partial<LineState>) {
    const lines = state.parts[pi].lines.map((l, i) => (i === li ? { ...l, ...patch } : l));
    // when process/basis change, prefill rate + min-charge from the price key rules
    if ("process" in patch || "basis" in patch) {
      const l = lines[li];
      const r = rateForLine(pricingRules, l.process, l.basis);
      lines[li] = { ...l, rateCents: r.rateCents, minChargeCents: r.minChargeCents };
    }
    patchPart(pi, { lines });
  }
  function removeLine(pi: number, li: number) {
    patchPart(pi, { lines: state.parts[pi].lines.filter((_, i) => i !== li) });
  }

  const pricingParts = state.parts.map((p) => ({ id: p.id, partId: p.partId, material: p.material, quantity: p.quantity, lines: p.lines }));
  const subtotal = quoteSubtotalCents(pricingParts);
  const total = quoteTotalCents({ parts: pricingParts, discount: state.discount });
  const margin = marginPct(total, Math.round(total * 0.58));

  const valid = customerId !== "" && state.parts.length > 0 &&
    state.parts.every((p) => p.partId !== "" && p.lines.length > 0 && p.lines.every((l) => l.process !== ""));

  function assemble(): CreateInput<Quote> {
    return buildQuoteDraft({
      customerId, customerPO: state.customerPO, salespersonId,
      requiredBy: state.requiredBy ? new Date(state.requiredBy).toISOString() : null,
      discount: state.discount, notes: state.notes, parts: pricingParts,
    }, todayIso);
  }

  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <PageHeader title="New quote" subtitle="Build a multi-part estimate. Rates default from the customer's price key." />
        <div className="space-y-4 rounded-card border border-border bg-surface p-4">
          <FormField label="Customer" htmlFor="cust">
            <select id="cust" aria-label="Customer" className={selectCls} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormField>
          <FormField label="Customer PO" htmlFor="po">
            <Input id="po" value={state.customerPO} onChange={(e) => setState((s) => ({ ...s, customerPO: e.target.value }))} />
          </FormField>
          <FormField label="Required by" htmlFor="req">
            <Input id="req" type="date" value={state.requiredBy} onChange={(e) => setState((s) => ({ ...s, requiredBy: e.target.value }))} />
          </FormField>
        </div>

        {state.parts.map((p, pi) => (
          <div key={p.id} data-testid={`part-block-${pi}`} className="mt-4 rounded-card border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">Part {pi + 1}</span>
              <Button size="sm" variant="ghost" onClick={() => removePart(pi)}>Remove part</Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Part" htmlFor={`part-${pi}`}>
                <select id={`part-${pi}`} aria-label="Part" className={selectCls} value={p.partId}
                  onChange={(e) => { const pt = parts.find((x) => x.id === e.target.value); patchPart(pi, { partId: e.target.value, material: pt?.material ?? "" }); }}>
                  <option value="">Select part…</option>
                  {customerParts.map((pt) => <option key={pt.id} value={pt.id}>{pt.partNumber} — {pt.description}</option>)}
                </select>
              </FormField>
              <FormField label="Quantity" htmlFor={`qty-${pi}`}>
                <Input id={`qty-${pi}`} aria-label="Quantity" type="number" value={p.quantity || ""} onChange={(e) => patchPart(pi, { quantity: Number(e.target.value) })} />
              </FormField>
            </div>

            <table className="mt-3 w-full text-[13px]">
              <thead><tr className="text-left font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">
                <th className="py-1">Process</th><th>Basis</th><th>Qty / weight</th><th>Rate</th><th className="text-right">Amount</th><th></th>
              </tr></thead>
              <tbody>
                {p.lines.map((l, li) => (
                  <tr key={l.id} data-testid={`line-${li}`} className="border-t border-border-faint">
                    <td className="py-1 pr-2">
                      <select aria-label="Process" className={selectCls} value={l.process} onChange={(e) => patchLine(pi, li, { process: e.target.value })}>
                        <option value="">…</option>
                        {PROCESS_OPTIONS.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
                      </select>
                    </td>
                    <td className="pr-2">
                      <select aria-label="Basis" className={selectCls} value={l.basis} onChange={(e) => patchLine(pi, li, { basis: e.target.value as PricingBasis })}>
                        {PRICING_BASES.map((b) => <option key={b} value={b}>{basisLabel[b]}</option>)}
                      </select>
                    </td>
                    <td className="pr-2"><Input aria-label="Qty / weight" type="number" value={l.qtyOrWeight || ""} onChange={(e) => patchLine(pi, li, { qtyOrWeight: Number(e.target.value) })} /></td>
                    <td className="pr-2"><Input aria-label="Rate (cents)" type="number" value={l.rateCents || ""} onChange={(e) => patchLine(pi, li, { rateCents: Number(e.target.value) })} /></td>
                    <td className="text-right font-mono">{formatMoney(lineAmountCents(l))}</td>
                    <td><Button size="sm" variant="ghost" onClick={() => removeLine(pi, li)}>×</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => addLine(pi)}>+ Add line</Button>
          </div>
        ))}

        <Button variant="outline" className="mt-4" onClick={addPart}>+ Add part</Button>
      </div>

      <SummaryRail title="Quote summary">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Subtotal</dt><dd className="font-mono">{formatMoney(subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Discount</dt>
            <dd className="font-mono">{canDiscount ? (
              <Input aria-label="Discount %" type="number" className="h-6 w-16 text-right"
                value={state.discount?.kind === "percent" ? state.discount.value : ""}
                onChange={(e) => setState((s) => ({ ...s, discount: e.target.value ? { kind: "percent", value: Number(e.target.value) } : null }))} />
            ) : "—"}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-2"><dt className="font-semibold">Total</dt><dd data-testid="quote-total" className="font-mono font-semibold">{formatMoney(total)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Est. margin</dt><dd className="font-mono">{margin}%</dd></div>
        </dl>
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="outline" disabled={!valid || submitting} onClick={() => onSaveDraft(assemble())}>Save draft</Button>
          <Button disabled={!valid || submitting} onClick={() => onSend(assemble())}>Send quote</Button>
        </div>
      </SummaryRail>
    </div>
  );
}
```

- [ ] **Step 4: Replace `app/(app)/quotes/new/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useCan } from "@/lib/auth/provider";
import { useCustomers, useParts, usePricingRulesByPriceKey, useCreateQuoteDraft, useSendQuote } from "@/lib/query/hooks";
import { SkeletonRows } from "@/components/patterns";
import { QuoteBuilder } from "@/components/quotes/quote-builder";

export default function QuoteBuilderPage() {
  const router = useRouter();
  const { operator } = useAuth();
  const canDiscount = useCan("apply_discount");
  const customers = useCustomers();
  const parts = useParts();
  const [priceKeyId, setPriceKeyId] = useState(""); // selected customer's price key drives the rule query
  const rules = usePricingRulesByPriceKey(priceKeyId);
  const createDraft = useCreateQuoteDraft();
  const send = useSendQuote();

  if (customers.isLoading || parts.isLoading) return <SkeletonRows />;

  // The builder owns customer selection; we mirror the chosen customer's priceKey into `priceKeyId`
  // via onCustomerChange is not exposed, so the page passes ALL parts + rules for the current key.
  // Simpler: pass rules for whichever customer the builder currently shows by lifting price-key here.
  return (
    <QuoteBuilder
      customers={customers.data ?? []}
      parts={parts.data ?? []}
      pricingRules={rules.data ?? []}
      salespersonId={operator?.id ?? ""}
      canDiscount={canDiscount}
      todayIso={new Date().toISOString()}
      submitting={createDraft.isPending || send.isPending}
      onSaveDraft={async (input) => { const q = await createDraft.mutateAsync(input); router.push(`/quotes/${q.id}`); }}
      onSend={async (input) => {
        const q = await createDraft.mutateAsync(input);
        if (operator) await send.mutateAsync({ quote: q, operator });
        router.push(`/quotes/${q.id}`);
      }}
      onCustomerChange={(cid) => { const c = (customers.data ?? []).find((x) => x.id === cid); setPriceKeyId(c?.priceKeyId ?? ""); }}
    />
  );
}
```

> **Wiring note for the implementer:** add an `onCustomerChange?(customerId: string)` prop to `QuoteBuilder` and call it inside the Customer `<select>`'s `onChange` (alongside `setCustomerId`). This lets the page load the selected customer's price-key rules (`usePricingRulesByPriceKey`). Keep the prop optional so the component test (which passes rules directly) doesn't need it. Update the builder's prop type + the customer select handler accordingly; the component test still passes.

- [ ] **Step 5: Run component test + gate + commit**

```bash
git add components/quotes/quote-builder.tsx components/quotes/quote-builder.test.tsx "app/(app)/quotes/new/page.tsx"
git commit -m "feat(quotes): multi-part quote builder (create)"
```

---

## Task 10: Quote detail / edit screen (`/quotes/[id]`)

**Why:** the route the list + builder push to. A **draft** renders the builder prefilled (Save → `update`; Send → `update` then `send`). A **sent/approve/won/lost** quote renders read-only with the lifecycle actions: `approve`/`reject` (when `approve` + `useCan("approve_over_limit")`), `Mark won`/`Mark lost`/`Revise` (when `sent`).

**Files:** Create `components/quotes/quote-view.tsx` (+ `.test.tsx`); create `app/(app)/quotes/[id]/page.tsx`.

**Interfaces:**
- Produces: `QuoteView({ quote, customer, parts, canApprove, onApprove, onReject, onWin, onLose, onRevise, busy })` — read-only quote summary (header, parts/lines, totals via pricing) + `DetailHeader` actions gated by status.
- Consumes: `useQuote`, `useCustomer`, `useParts`, `usePricingRulesByPriceKey`, the quote mutations, `useCan`, `isEditable`.

- [ ] **Step 1: Failing test for `QuoteView`** — a `sent` quote shows `Mark won`/`Mark lost`/`Revise`; an `approve` quote with `canApprove` shows `Approve`/`Reject`; clicking `Mark won` fires `onWin`.

```tsx
// essentials
it("sent quote exposes won/lost/revise and fires onWin", async () => {
  const onWin = vi.fn();
  render(<QuoteView quote={sentQuote} customer={cust} parts={[]} canApprove={false}
    onApprove={vi.fn()} onReject={vi.fn()} onWin={onWin} onLose={vi.fn()} onRevise={vi.fn()} busy={false} />);
  await userEvent.click(screen.getByRole("button", { name: /mark won/i }));
  expect(onWin).toHaveBeenCalled();
});
it("approve quote with canApprove exposes approve/reject", () => {
  render(<QuoteView quote={approveQuote} customer={cust} parts={[]} canApprove
    onApprove={vi.fn()} onReject={vi.fn()} onWin={vi.fn()} onLose={vi.fn()} onRevise={vi.fn()} busy={false} />);
  expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement `components/quotes/quote-view.tsx`**

```tsx
import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { quoteStatusMeta, basisLabel } from "@/lib/domain/enums";
import { quoteSubtotalCents, quoteTotalCents, lineAmountCents, marginPct } from "@/lib/logic/pricing";
import { formatMoney, formatDate } from "@/lib/utils";
import type { Quote, Customer, Part } from "@/lib/domain";

export function QuoteView({ quote, customer, parts, canApprove, onApprove, onReject, onWin, onLose, onRevise, busy }: {
  quote: Quote; customer: Customer | null; parts: Part[]; canApprove: boolean;
  onApprove: () => void; onReject: () => void; onWin: () => void; onLose: () => void; onRevise: () => void; busy: boolean;
}) {
  const meta = quoteStatusMeta[quote.status];
  const partById = new Map(parts.map((p) => [p.id, p]));
  const total = quoteTotalCents(quote);
  const actions = (
    <>
      {quote.status === "approve" && canApprove && <>
        <Button size="sm" variant="outline" disabled={busy} onClick={onReject}>Reject</Button>
        <Button size="sm" disabled={busy} onClick={onApprove}>Approve</Button>
      </>}
      {quote.status === "sent" && <>
        <Button size="sm" variant="outline" disabled={busy} onClick={onRevise}>Revise</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onLose}>Mark lost</Button>
        <Button size="sm" disabled={busy} onClick={onWin}>Mark won</Button>
      </>}
    </>
  );
  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/quotes" backLabel="Quotes"
          title={<MonoId>{quote.rev > 0 ? `${quote.number} · rev ${quote.rev}` : quote.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · PO ${quote.customerPO || "—"}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>} actions={actions} />
        {quote.parts.map((p) => (
          <div key={p.id} className="mb-4 rounded-card border border-border bg-surface p-4">
            <div className="mb-2 font-semibold">{partById.get(p.partId)?.partNumber ?? p.partId} · {p.material} · qty {p.quantity}</div>
            <table className="w-full text-[13px]">
              <thead><tr className="text-left font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">
                <th className="py-1">Process</th><th>Basis</th><th>Qty/Wt</th><th className="text-right">Amount</th></tr></thead>
              <tbody>{p.lines.map((l) => (
                <tr key={l.id} className="border-t border-border-faint">
                  <td className="py-1">{l.process}</td><td>{basisLabel[l.basis]}</td>
                  <td className="font-mono">{l.qtyOrWeight}</td>
                  <td className="text-right font-mono">{formatMoney(lineAmountCents(l))}</td>
                </tr>))}</tbody>
            </table>
          </div>
        ))}
      </div>
      <SummaryRail title="Summary">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Subtotal</dt><dd className="font-mono">{formatMoney(quoteSubtotalCents(quote.parts))}</dd></div>
          <div className="flex justify-between border-t border-border pt-2"><dt className="font-semibold">Total</dt><dd className="font-mono font-semibold">{formatMoney(total)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Est. margin</dt><dd className="font-mono">{marginPct(total, quote.estCostCents)}%</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Valid until</dt><dd className="font-mono">{formatDate(quote.validUntil)}</dd></div>
        </dl>
      </SummaryRail>
    </div>
  );
}
```

- [ ] **Step 4: Create `app/(app)/quotes/[id]/page.tsx`** (draft → builder edit; else → `QuoteView`)

```tsx
"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useQuote, useCustomer, useParts, usePricingRulesByPriceKey,
  useUpdateQuote, useSendQuote, useApproveQuote, useRejectQuote, useWinQuote, useLoseQuote, useReviseQuote,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { QuoteBuilder, type BuilderState } from "@/components/quotes/quote-builder";
import { QuoteView } from "@/components/quotes/quote-view";
import { isEditable } from "@/lib/logic/quote-state";

export default function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { operator } = useAuth();
  const canApprove = useCan("approve_over_limit");
  const canDiscount = useCan("apply_discount");
  const quote = useQuote(id);
  const customer = useCustomer(quote.data?.customerId ?? "");
  const parts = useParts();
  const rules = usePricingRulesByPriceKey(customer.data?.priceKeyId ?? "");
  const update = useUpdateQuote();
  const send = useSendQuote();
  const approve = useApproveQuote();
  const reject = useRejectQuote();
  const win = useWinQuote();
  const lose = useLoseQuote();
  const revise = useReviseQuote();

  if (quote.isLoading) return <SkeletonRows />;
  if (quote.isError) return <ErrorPanel message="Failed to load quote." onRetry={() => quote.refetch()} />;
  if (!quote.data) return <EmptyState title="Quote not found" />;
  const q = quote.data;

  if (isEditable(q)) {
    const initial: BuilderState = {
      customerPO: q.customerPO, requiredBy: q.requiredBy ? q.requiredBy.slice(0, 10) : "", notes: q.notes,
      discount: q.discount,
      parts: q.parts.map((p) => ({ id: p.id, partId: p.partId, material: p.material, quantity: p.quantity, lines: p.lines })),
    };
    const toPatch = (input: import("@/lib/data/repositories").CreateInput<typeof q>) =>
      ({ customerId: input.customerId, customerPO: input.customerPO, requiredBy: input.requiredBy, discount: input.discount, notes: input.notes, parts: input.parts, estCostCents: input.estCostCents });
    return (
      <QuoteBuilder
        customers={customer.data ? [customer.data] : []}
        parts={parts.data ?? []}
        pricingRules={rules.data ?? []}
        salespersonId={q.salespersonId} canDiscount={canDiscount} todayIso={new Date().toISOString()}
        initial={initial} initialCustomerId={q.customerId}
        submitting={update.isPending || send.isPending}
        onSaveDraft={async (input) => { await update.mutateAsync({ id: q.id, patch: toPatch(input), version: q.version }); }}
        onSend={async (input) => {
          const saved = await update.mutateAsync({ id: q.id, patch: toPatch(input), version: q.version });
          if (operator) await send.mutateAsync({ quote: saved, operator });
        }}
        onCustomerChange={() => {}}
      />
    );
  }

  return (
    <QuoteView
      quote={q} customer={customer.data ?? null} parts={parts.data ?? []} canApprove={canApprove}
      busy={approve.isPending || reject.isPending || win.isPending || lose.isPending || revise.isPending}
      onApprove={() => approve.mutate({ quote: q })}
      onReject={() => reject.mutate({ quote: q })}
      onWin={() => win.mutate(q)}
      onLose={() => lose.mutate({ quote: q })}
      onRevise={async () => { const r = await revise.mutateAsync(q); router.push(`/quotes/${r.id}`); }}
    />
  );
}
```

> Note: editing a draft here shows only the quote's own customer in the builder's customer select (the customer is fixed once a quote exists). `onCustomerChange` is a no-op in edit mode.

- [ ] **Step 5: Run tests + gate + commit**

```bash
git add components/quotes/quote-view.tsx components/quotes/quote-view.test.tsx "app/(app)/quotes/[id]/page.tsx"
git commit -m "feat(quotes): quote detail/edit route with lifecycle actions"
```

---

## Task 11: Orders list screen

**Files:** Create `components/orders/orders-list.tsx` (+ `.test.tsx`); replace `app/(app)/orders/page.tsx`.

**Interfaces:**
- Produces: `OrdersList({ orders, customers, onSelect })` — `ListCard` with WO#, customer, process, due, value, status; row → `onSelect(id)`.

- [ ] **Step 1: Failing test** (renders `WO-48211`, `Apex Aerospace`, status pill, fires onSelect). **Step 2: FAIL.**

- [ ] **Step 3: Implement `components/orders/orders-list.tsx`**

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { orderStatusMeta } from "@/lib/domain/enums";
import { formatMoney, formatDate } from "@/lib/utils";
import type { WorkOrder, Customer } from "@/lib/domain";

export function OrdersList({ orders, customers, onSelect }: {
  orders: WorkOrder[]; customers: Customer[]; onSelect?: (id: string) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  return (
    <ListCard
      headers={["WORK ORDER", "CUSTOMER", "PROCESS", "DUE", "VALUE", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(orders[i].id) : undefined}
      rows={orders.map((o) => {
        const meta = orderStatusMeta[o.status];
        return [
          <MonoId key="w">{o.number}</MonoId>,
          custById.get(o.customerId)?.name ?? "—",
          o.processSummary,
          <span key="d" className="text-text-muted">{formatDate(o.due)}</span>,
          <span key="v" className="font-mono">{formatMoney(o.orderValueCents)}</span>,
          <StatusPill key="s" tone={meta.tone}>{meta.label}</StatusPill>,
        ];
      })}
    />
  );
}
```

- [ ] **Step 4: Replace `app/(app)/orders/page.tsx`** (mirror `quotes/page.tsx`: `useWorkOrders`+`useCustomers`, `PageHeader` "Orders" subtitle "Work orders in production, on hold, ready to ship and shipped.", loading/error/empty, `OrdersList` → `router.push('/orders/'+id)`; no primary action — orders are created from won quotes).

- [ ] **Step 5: gate + commit**

```bash
git add components/orders/orders-list.tsx components/orders/orders-list.test.tsx "app/(app)/orders/page.tsx"
git commit -m "feat(orders): Orders list screen"
```

---

## Task 12: Order detail screen (`/orders/[id]`)

**Why:** the workflow's operational heart — carried pricing, read-only traveler from the Process Master, cert card + Release, status actions + **Ship gated on cert Released**, activity feed.

**Files:** Create `components/orders/order-detail.tsx` (+ `.test.tsx`); create `app/(app)/orders/[id]/page.tsx`.

**Interfaces:**
- Produces: `OrderDetail({ order, customer, processMaster, cert, canRelease, busy, onRelease, onTransition, onShip })`:
  - Pricing card from `order.pricing` (read-only, carried from the quote).
  - Traveler from `processMaster.steps` (read-only: n, op, equip, params, track).
  - Cert card: cert number/spec/status pill; `Release` button when `cert.status === "pending"` **and** `canRelease`.
  - Status actions: a button per legal target in `ORDER_TRANSITIONS[order.status]` (excluding `shipped`), plus a **Ship** button. Ship is **disabled** with the reason shown when `canShipOrder(order, cert).ok === false`.
  - Activity feed from `order.activity`.
- Consumes: `useWorkOrder`, `useCustomer`, `useProcessMaster`, `useCertifications`, `useReleaseCertification`, `useTransitionOrder`, `useShipOrder`, `useCan`, `canShipOrder`, `ORDER_TRANSITIONS`, `orderStatusMeta`.

- [ ] **Step 1: Failing test** — cover the ship gate both ways:

```tsx
// essentials
it("blocks ship when a required cert is pending, with the reason", () => {
  render(<OrderDetail order={certReqOrder} customer={cust} processMaster={pm} cert={pendingCert}
    canRelease busy={false} onRelease={vi.fn()} onTransition={vi.fn()} onShip={vi.fn()} />);
  const ship = screen.getByRole("button", { name: /ship/i });
  expect(ship).toBeDisabled();
  expect(screen.getByText(/certification must be released before ship/i)).toBeInTheDocument();
});
it("allows ship when cert released and fires onShip", async () => {
  const onShip = vi.fn();
  render(<OrderDetail order={{ ...certReqOrder, status: "ready_to_ship" }} customer={cust} processMaster={pm}
    cert={releasedCert} canRelease={false} busy={false} onRelease={vi.fn()} onTransition={vi.fn()} onShip={onShip} />);
  await userEvent.click(screen.getByRole("button", { name: /^ship$/i }));
  expect(onShip).toHaveBeenCalled();
});
it("shows Release for a pending cert when canRelease", () => {
  render(<OrderDetail order={certReqOrder} customer={cust} processMaster={pm} cert={pendingCert}
    canRelease busy={false} onRelease={vi.fn()} onTransition={vi.fn()} onShip={vi.fn()} />);
  expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: FAIL. Step 3: Implement `components/orders/order-detail.tsx`**

```tsx
import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { orderStatusMeta, certStatusMeta } from "@/lib/domain/enums";
import { ORDER_TRANSITIONS, canShipOrder } from "@/lib/logic/order";
import { formatMoney, formatDate } from "@/lib/utils";
import type { WorkOrder, Customer, ProcessMaster, Certification, OrderStatus } from "@/lib/domain";

export function OrderDetail({ order, customer, processMaster, cert, canRelease, busy, onRelease, onTransition, onShip }: {
  order: WorkOrder; customer: Customer | null; processMaster: ProcessMaster | null; cert: Certification | null;
  canRelease: boolean; busy: boolean; onRelease: () => void; onTransition: (to: OrderStatus) => void; onShip: () => void;
}) {
  const meta = orderStatusMeta[order.status];
  const gate = canShipOrder(order, cert);
  const targets = ORDER_TRANSITIONS[order.status].filter((t) => t !== "shipped");
  const canShipStatus = order.status === "ready_to_ship"; // ship is offered from ready_to_ship
  const actions = (
    <>
      {targets.map((t) => (
        <Button key={t} size="sm" variant="outline" disabled={busy} onClick={() => onTransition(t)}>
          {orderStatusMeta[t].label}
        </Button>
      ))}
      {canShipStatus && <Button size="sm" disabled={busy || !gate.ok} onClick={onShip}>Ship</Button>}
    </>
  );
  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/orders" backLabel="Orders" title={<MonoId>{order.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · PO ${order.customerPO || "—"} · ${order.processSummary}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>} actions={actions} />

        {canShipStatus && !gate.ok && (
          <p className="mb-4 rounded-card border border-status-warn-tint bg-status-warn-tint px-3 py-2 text-xs text-status-warn">{gate.reason}</p>
        )}

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
          {processMaster ? (
            <ol className="space-y-2 text-[13px]">
              {processMaster.steps.map((s) => (
                <li key={s.n} className="flex gap-3 border-t border-border-faint pt-2 first:border-0 first:pt-0">
                  <span className="font-mono text-text-muted">{s.n}</span>
                  <div>
                    <div className="font-medium">{s.op} <span className="text-text-muted">· {s.equip}</span></div>
                    {s.params.length > 0 && <div className="font-mono text-xs text-text-muted">{s.params.join(" · ")}</div>}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="text-text-muted text-xs">No process master assigned.</p>}
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
```

- [ ] **Step 4: Create `app/(app)/orders/[id]/page.tsx`**

```tsx
"use client";
import { use } from "react";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useWorkOrder, useCustomer, useProcessMaster, useCertifications,
  useReleaseCertification, useTransitionOrder, useShipOrder,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OrderDetail } from "@/components/orders/order-detail";
import type { OrderStatus } from "@/lib/domain";

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

  if (order.isLoading) return <SkeletonRows />;
  if (order.isError) return <ErrorPanel message="Failed to load order." onRetry={() => order.refetch()} />;
  if (!order.data) return <EmptyState title="Order not found" />;
  const o = order.data;
  const cert = (certs.data ?? []).find((c) => c.workOrderId === o.id) ?? null;
  const now = () => new Date().toISOString();
  const actor = operator?.name ?? "System";
  const busy = release.isPending || transition.isPending || ship.isPending;

  return (
    <OrderDetail
      order={o} customer={customer.data ?? null} processMaster={pm.data ?? null} cert={cert}
      canRelease={canRelease} busy={busy}
      onRelease={() => cert && release.mutate({ id: cert.id, version: cert.version })}
      onTransition={(to: OrderStatus) => transition.mutate({ order: o, to, actor, at: now() })}
      onShip={() => ship.mutate({ order: o, cert, actor, at: now() })}
    />
  );
}
```

> Note: `useReleaseCertification` currently invalidates only `certifications`. That is sufficient here (Order detail reads the cert from `useCertifications()` and re-derives the ship gate on refetch). No change needed.

- [ ] **Step 5: Run tests + gate + commit**

```bash
git add components/orders/order-detail.tsx components/orders/order-detail.test.tsx "app/(app)/orders/[id]/page.tsx"
git commit -m "feat(orders): order detail — traveler, cert release, cert-gated ship, activity"
```

---

## Task 13: Invoicing screen (`/invoicing`)

**Why:** the To-bill → Sent → Paid finance flow. To-bill rows carry `number: null` and a **Bill** action (assigns `INV-#####`); Sent rows carry a **Record payment** action.

**Files:** Create `components/invoicing/invoicing-view.tsx` (+ `.test.tsx`); replace `app/(app)/invoicing/page.tsx`.

**Interfaces:**
- Produces: `InvoicingView({ invoices, customers, orders, busy, onBill, onPay })` — three `Tabs` (`To-bill` / `Sent` / `Paid`); each tab a `ListCard`; To-bill rows → `Bill`, Sent rows → `Record payment`. Uses Radix `Tabs` (triggers are buttons, testable).
- Consumes: `useInvoices`, `useCustomers`, `useWorkOrders`, `useBillInvoice`, `usePayInvoice`, `invoiceStatusMeta`.

- [ ] **Step 1: Failing test** — To-bill tab shows the two seeded to-bill rows with a `Bill` button; clicking fires `onBill`; switching to Sent shows `Record payment`.

```tsx
// essentials
it("To-bill tab lists to-bill invoices and fires onBill", async () => {
  const onBill = vi.fn();
  render(<InvoicingView invoices={invoices} customers={customers} orders={orders} busy={false} onBill={onBill} onPay={vi.fn()} />);
  expect(screen.getByText("WO-48120")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: /^bill$/i })[0]);
  expect(onBill).toHaveBeenCalled();
});
it("Sent tab exposes Record payment", async () => {
  render(<InvoicingView invoices={invoices} customers={customers} orders={orders} busy={false} onBill={vi.fn()} onPay={vi.fn()} />);
  await userEvent.click(screen.getByRole("tab", { name: /sent/i }));
  expect(screen.getByRole("button", { name: /record payment/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: FAIL. Step 3: Implement `components/invoicing/invoicing-view.tsx`**

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/lib/ui/tabs";
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { invoiceStatusMeta } from "@/lib/domain/enums";
import { formatMoney, formatDate } from "@/lib/utils";
import type { Invoice, Customer, WorkOrder, InvoiceStatus } from "@/lib/domain";

export function InvoicingView({ invoices, customers, orders, busy, onBill, onPay }: {
  invoices: Invoice[]; customers: Customer[]; orders: WorkOrder[]; busy: boolean;
  onBill: (inv: Invoice) => void; onPay: (inv: Invoice) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const woById = new Map(orders.map((o) => [o.id, o]));
  const by = (s: InvoiceStatus) => invoices.filter((i) => i.status === s);
  const toBill = by("to_bill"), sent = by("sent"), paid = by("paid");

  function rows(list: Invoice[], action: (inv: Invoice) => React.ReactNode) {
    return list.map((i) => [
      <MonoId key="n">{i.number ?? "—"}</MonoId>,
      custById.get(i.customerId)?.name ?? "—",
      <MonoId key="w">{woById.get(i.workOrderId)?.number ?? "—"}</MonoId>,
      <span key="a" className="font-mono">{formatMoney(i.amountCents)}</span>,
      <StatusPill key="s" tone={invoiceStatusMeta[i.status].tone}>{invoiceStatusMeta[i.status].label}</StatusPill>,
      action(i),
    ]);
  }
  const headers = ["INVOICE", "CUSTOMER", "WORK ORDER", "AMOUNT", "STATUS", ""];

  return (
    <Tabs defaultValue="to_bill">
      <TabsList>
        <TabsTrigger value="to_bill">To-bill ({toBill.length})</TabsTrigger>
        <TabsTrigger value="sent">Sent ({sent.length})</TabsTrigger>
        <TabsTrigger value="paid">Paid ({paid.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="to_bill">
        <ListCard headers={headers} rows={rows(toBill, (i) => (
          <Button key="b" size="sm" disabled={busy} onClick={() => onBill(i)}>Bill</Button>
        ))} />
      </TabsContent>
      <TabsContent value="sent">
        <ListCard headers={headers} rows={rows(sent, (i) => (
          <Button key="p" size="sm" variant="outline" disabled={busy} onClick={() => onPay(i)}>Record payment</Button>
        ))} />
      </TabsContent>
      <TabsContent value="paid">
        <ListCard headers={[...headers.slice(0, 5), "PAID"]} rows={paid.map((i) => [
          <MonoId key="n">{i.number ?? "—"}</MonoId>,
          custById.get(i.customerId)?.name ?? "—",
          <MonoId key="w">{woById.get(i.workOrderId)?.number ?? "—"}</MonoId>,
          <span key="a" className="font-mono">{formatMoney(i.amountCents)}</span>,
          <StatusPill key="s" tone={invoiceStatusMeta[i.status].tone}>{invoiceStatusMeta[i.status].label}</StatusPill>,
          <span key="pd" className="font-mono text-text-muted">{i.paidDate ? formatDate(i.paidDate) : "—"}</span>,
        ])} />
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 4: Replace `app/(app)/invoicing/page.tsx`**

```tsx
"use client";
import { useInvoices, useCustomers, useWorkOrders, useBillInvoice, usePayInvoice } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { InvoicingView } from "@/components/invoicing/invoicing-view";

export default function InvoicingPage() {
  const invoices = useInvoices();
  const customers = useCustomers();
  const orders = useWorkOrders();
  const bill = useBillInvoice();
  const pay = usePayInvoice();
  const now = () => new Date().toISOString();

  if (invoices.isLoading) return <SkeletonRows />;
  if (invoices.isError) return <ErrorPanel message="Failed to load invoices." onRetry={() => invoices.refetch()} />;
  const data = invoices.data ?? [];

  return (
    <div>
      <PageHeader title="Invoicing" subtitle="Shipped work to bill, invoices sent, and payments recorded." />
      {data.length === 0 ? <EmptyState title="No invoices" /> : (
        <InvoicingView
          invoices={data} customers={customers.data ?? []} orders={orders.data ?? []}
          busy={bill.isPending || pay.isPending}
          onBill={(inv) => bill.mutate({ invoice: inv, at: now() })}
          onPay={(inv) => pay.mutate({ invoice: inv, at: now() })}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run tests + gate + commit**

```bash
git add components/invoicing/invoicing-view.tsx components/invoicing/invoicing-view.test.tsx "app/(app)/invoicing/page.tsx"
git commit -m "feat(invoicing): To-bill/Sent/Paid tabs with bill + record-payment"
```

---

## Task 14: A/R screen (`/ar`)

**Why:** aging buckets + per-customer balances (Net-terms model from Task 3) + advisory Close-period.

**Files:** Create `components/ar/ar-view.tsx` (+ `.test.tsx`); replace `app/(app)/ar/page.tsx`.

**Interfaces:**
- Produces: `ARView({ invoices, customers, asOf, canClose, onClosePeriod, closedNote })`:
  - Aging summary tiles (Current / 1–30 / 31–60 / 61–90 / 90+) from `ageInvoices(invoices, netDaysByCustomer(customers), asOf)`.
  - Per-customer table (customers with a non-zero sent balance): Customer, Balance, Current, Past Due, Oldest (days) from `customerAging`.
  - "Close period" button (gated by `canClose`) → `ConfirmDialog` → `onClosePeriod()`; advisory only (shows `closedNote` acknowledgement after).
- Consumes: `useInvoices`, `useCustomers`, `useCan`, `ageInvoices`, `netDaysByCustomer`, `customerAging`, `parseNetDays`.

- [ ] **Step 1: Failing test** — renders bucket tiles + a per-customer row with a balance; Close-period is shown only when `canClose`; confirming fires `onClosePeriod`.

```tsx
// essentials
it("shows aging tiles and a per-customer balance", () => {
  render(<ARView invoices={invoices} customers={customers} asOf="2026-07-01T00:00:00.000Z"
    canClose onClosePeriod={vi.fn()} closedNote={null} />);
  expect(screen.getByText(/Current/)).toBeInTheDocument();
  expect(screen.getByText("Delta Turbine")).toBeInTheDocument();
});
it("Close period confirms then fires onClosePeriod", async () => {
  const onClose = vi.fn();
  render(<ARView invoices={invoices} customers={customers} asOf="2026-07-01T00:00:00.000Z"
    canClose onClosePeriod={onClose} closedNote={null} />);
  await userEvent.click(screen.getByRole("button", { name: /close period/i }));
  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: FAIL. Step 3: Implement `components/ar/ar-view.tsx`**

```tsx
"use client";
import { useState } from "react";
import { ListCard } from "@/components/patterns";
import { ConfirmDialog } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { ageInvoices, netDaysByCustomer, customerAging, parseNetDays, type Bucket } from "@/lib/logic/ar";
import { formatMoney } from "@/lib/utils";
import type { Invoice, Customer } from "@/lib/domain";

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "current", label: "Current" }, { key: "d1_30", label: "1–30" },
  { key: "d31_60", label: "31–60" }, { key: "d61_90", label: "61–90" }, { key: "d90_plus", label: "90+" },
];

export function ARView({ invoices, customers, asOf, canClose, onClosePeriod, closedNote }: {
  invoices: Invoice[]; customers: Customer[]; asOf: string; canClose: boolean;
  onClosePeriod: () => void; closedNote: string | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const nd = netDaysByCustomer(customers);
  const totals = ageInvoices(invoices, nd, asOf);
  const rows = customers
    .map((c) => ({ c, a: customerAging(invoices, c.id, parseNetDays(c.terms), asOf) }))
    .filter((x) => x.a.balanceCents > 0);

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">A/R aging</h1>
          <p className="text-text-muted text-xs">Open receivables by age, per customer. Net terms drive the due date.</p>
        </div>
        {canClose && <Button variant="outline" onClick={() => setConfirm(true)}>Close period</Button>}
      </div>

      {closedNote && <p className="mb-4 rounded-card border border-status-success-tint bg-status-success-tint px-3 py-2 text-xs text-status-success">{closedNote}</p>}

      <div className="mb-5 grid grid-cols-5 gap-3">
        {BUCKETS.map((b) => (
          <div key={b.key} className="rounded-card border border-border bg-surface p-3">
            <div className="font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">{b.label}</div>
            <div className="font-mono text-[20px] font-semibold">{formatMoney(totals[b.key])}</div>
          </div>
        ))}
      </div>

      <ListCard headers={["CUSTOMER", "BALANCE", "CURRENT", "PAST DUE", "OLDEST"]}
        rows={rows.map(({ c, a }) => [
          c.name,
          <span key="b" className="font-mono">{formatMoney(a.balanceCents)}</span>,
          <span key="cu" className="font-mono">{formatMoney(a.currentCents)}</span>,
          <span key="pd" className="font-mono text-status-warn">{formatMoney(a.pastDueCents)}</span>,
          <span key="o" className="font-mono">{a.oldestDaysPastDue > 0 ? `${a.oldestDaysPastDue}d` : "—"}</span>,
        ])} />

      <ConfirmDialog open={confirm} onOpenChange={setConfirm}
        title="Close period" description="This locks the current period's invoices from edits (advisory in this slice)."
        confirmLabel="Close" onConfirm={onClosePeriod} />
    </div>
  );
}
```

- [ ] **Step 4: Replace `app/(app)/ar/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useInvoices, useCustomers } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ARView } from "@/components/ar/ar-view";

export default function ArPage() {
  const invoices = useInvoices();
  const customers = useCustomers();
  const canClose = useCan("close_period");
  const [closedNote, setClosedNote] = useState<string | null>(null);

  if (invoices.isLoading || customers.isLoading) return <SkeletonRows />;
  if (invoices.isError) return <ErrorPanel message="Failed to load A/R." onRetry={() => invoices.refetch()} />;

  return (
    <ARView
      invoices={invoices.data ?? []} customers={customers.data ?? []} asOf={new Date().toISOString()}
      canClose={canClose} closedNote={closedNote}
      onClosePeriod={() => setClosedNote("Period closed — invoices are locked from edits (advisory).")}
    />
  );
}
```

- [ ] **Step 5: Run tests + gate + commit**

```bash
git add components/ar/ar-view.tsx components/ar/ar-view.test.tsx "app/(app)/ar/page.tsx"
git commit -m "feat(ar): aging buckets + per-customer balances + close period"
```

---

## Task 15: E2E happy-path slice

**Why:** prove the whole slice end-to-end exactly as the spec's §13 E2E line requires: create multi-part quote → send → won → order auto-created → release cert → ship → bill → invoice Sent → appears in A/R.

**Files:** Create `tests/e2e/quote-to-invoice.spec.ts`.

**Interfaces:**
- Consumes: the full app. Auto-login is the demo manager (`op-dana`, limit $100k) — no login step; sending stays under the limit → straight to `sent` (no approval branch in the happy path).
- **Constraint:** navigate via **in-app clicks/links only** (the mock store resets on full reload). Use `baseURL`; a single `page.goto("/quotes")` at the start is fine, then click through.

- [ ] **Step 1: Write the E2E**

```ts
import { test, expect } from "@playwright/test";

test("multi-part quote → send → won → order → release cert → ship → bill → A/R", async ({ page }) => {
  await page.goto("/quotes");
  await page.getByRole("button", { name: "New quote" }).click();

  // Build a 2-part quote for Apex Aerospace (price key AERO-1)
  await page.getByLabel("Customer").selectOption({ label: "Apex Aerospace" });

  // Part 1: TS-4471 with Carburize / Temper / Certification
  await page.getByRole("button", { name: /add part/i }).click();
  const p0 = page.getByTestId("part-block-0");
  await p0.getByLabel("Part").selectOption({ label: /TS-4471/ });
  await p0.getByLabel("Quantity").fill("480");
  await p0.getByRole("button", { name: /add line/i }).click();
  const l0 = p0.getByTestId("line-0");
  await l0.getByLabel("Process").selectOption("Carburize");
  await l0.getByLabel("Basis").selectOption("per_lb");
  await l0.getByLabel("Qty / weight").fill("600");
  await p0.getByRole("button", { name: /add line/i }).click();
  const l1 = p0.getByTestId("line-1");
  await l1.getByLabel("Process").selectOption("Temper");
  await l1.getByLabel("Basis").selectOption("per_lot");
  await l1.getByLabel("Qty / weight").fill("1");

  // Part 2: SP-119 with a Carburize line
  await page.getByRole("button", { name: /add part/i }).click();
  const p1 = page.getByTestId("part-block-1");
  await p1.getByLabel("Part").selectOption({ label: /SP-119/ });
  await p1.getByLabel("Quantity").fill("120");
  await p1.getByRole("button", { name: /add line/i }).click();
  const l2 = p1.getByTestId("line-0");
  await l2.getByLabel("Process").selectOption("Carburize");
  await l2.getByLabel("Basis").selectOption("per_lb");
  await l2.getByLabel("Qty / weight").fill("150");

  await expect(page.getByTestId("quote-total")).not.toHaveText("$0");

  // Send → lands on the read-only quote view as "Sent" (manager under limit)
  await page.getByRole("button", { name: "Send quote" }).click();
  await expect(page.getByText("Sent")).toBeVisible();

  // Won → auto-creates the order + cert
  await page.getByRole("button", { name: /mark won/i }).click();
  await expect(page.getByText("Won")).toBeVisible();

  // Go to Orders, open the newest order (Received). It is WO-48212 (seed counter 48211 → next).
  await page.getByRole("link", { name: "Orders" }).click();
  await page.getByText("WO-48212").click();

  // Ship is blocked until the cert is released
  await expect(page.getByText(/certification must be released before ship/i)).toBeVisible();

  // Drive the order to ready_to_ship and release the cert
  await page.getByRole("button", { name: "Scheduled" }).click();
  await page.getByRole("button", { name: "In Process" }).click();
  await page.getByRole("button", { name: "Ready to ship" }).click();
  await page.getByRole("button", { name: "Release" }).click();
  await expect(page.getByText("Released")).toBeVisible();

  // Ship → creates the To-bill invoice; order becomes Shipped
  await page.getByRole("button", { name: /^Ship$/ }).click();
  await expect(page.getByText("Shipped")).toBeVisible();

  // Invoicing → To-bill has the new invoice (no number). Bill it → INV-30413, moves to Sent.
  await page.getByRole("link", { name: "Invoicing" }).click();
  await page.getByRole("button", { name: /^Bill$/ }).first().click();
  await page.getByRole("tab", { name: /sent/i }).click();
  await expect(page.getByText(/INV-\d+/).first()).toBeVisible();

  // A/R → Apex Aerospace now carries a balance
  await page.getByRole("link", { name: "A/R" }).click();
  await expect(page.getByText("Apex Aerospace")).toBeVisible();
});
```

> Implementer notes: (1) the order-detail status buttons render only the **legal next** transitions, so click them in order (`Scheduled` → `In Process` → `Ready to ship`); each click refetches and re-renders the next set. (2) `Release` appears because auto-login is a manager (`release_cert`). (3) If a status label collides with a pill of the same text, scope the click with `getByRole("button", { name })` (pills are `span`s, not buttons). (4) Keep every step an **in-app** click so the mock store persists.

- [ ] **Step 2: Run — expect PASS**

Run: `npm run test:e2e`
Expected: `2 passed` (smoke + full slice).

- [ ] **Step 3: Full gate + commit**

Run: `npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build && npm run test:e2e`

```bash
git add tests/e2e/quote-to-invoice.spec.ts
git commit -m "test(e2e): quote → order → ship → invoice → A/R happy path"
```

---

## Task 16: Whole-branch review + verification + PR

**Why:** same close-out as Plans 1 & 2 — a whole-branch adversarial review, a final green gate, then a PR into `main` (branch protection requires the `verify` check).

- [ ] **Step 1: Run the full gate one more time, capture output**

Run: `npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run test && npm run build && npm run test:e2e`
Expected: all green. Paste the tail of each command's output into the review notes (evidence before assertions — superpowers:verification-before-completion).

- [ ] **Step 2: Whole-branch adversarial review** (superpowers:requesting-code-review). Review the full diff `main..HEAD` across these dimensions, then adversarially verify each finding before acting on it (superpowers:receiving-code-review):
  - **Seam correctness:** no path auto-assigns a number to a to-bill invoice; `numbers.next` is the only INV# source at bill; `CreateInput<T>` leaves no entity requiring a bogus `number`.
  - **State-machine integrity:** every order transition goes through `canTransitionOrder`; ship goes through `canShipOrder`; won creates exactly one WO + (conditionally) one cert; optimistic-concurrency `version` is threaded on every `update`.
  - **A/R math:** due-date/net-terms buckets; end-of-day boundary; NaN guard; `pastDueCents`/`isLate` consistency with `agingBucket`.
  - **Layering:** no component imports `createMockRepositories`; all writes go through hooks; pages stay thin; no new `any`.
  - **Tokens/mono:** ids/numbers/pills use `MonoId`/`StatusPill`/`font-mono`; only token classes.
  - **E2E robustness:** in-app navigation only; selectors resilient (roles/labels/testids, not brittle text).
  - **Carry-forwards resolved:** confirm the two memory-flagged Plan 1/2 items this slice owns are closed (create/number seam; A/R aging heuristic + NaN guard + isLate end-of-day).
- [ ] **Step 3: Fix confirmed findings** (each as its own small TDD commit). Re-run the gate after fixes.
- [ ] **Step 4: Finish the branch** (superpowers:finishing-a-development-branch) — push the feature branch and open a PR into `main`:

```bash
git push -u origin <feature-branch>
gh pr create --base main --title "Plan 3 — Quote → Order → Invoice workflow + Playwright E2E" --body "<summary + verification evidence>"
```

Wait for the required `verify` check to pass before merge.

---

## Self-Review (author's checklist against the spec + reference)

**1. Spec coverage** — every in-scope §9 slice screen + §8 rule has a task:
- Quotes list → T8. Quote builder (multi-part, new+edit, save/send/over-limit→approve, won→auto-order, lost, revise) → T4/T5/T9/T10. Orders list → T11. Order detail (carried pricing, read-only traveler from Process Master, cert card + Release, status actions + ship gated on cert Released, activity) → T6/T12. Invoicing (To-bill/Sent/Paid; bill assigns INV#; record payment) → T7/T13. A/R (aging buckets + per-customer + close period) → T3/T14. E2E happy path → T1/T15. Placeholders replaced: `/quotes`, `/quotes/new`, `/orders` (+`[id]`), `/invoicing`, `/ar` (+ new `/quotes/[id]`, `/orders/[id]`).
- §8.1 pricing (rate×qty, min floor, discount, totals, margin) — reused pure fns + T4 lookup. §8.2 lifecycle incl. limit routing — T5 (`sendQuote`). §8.3 won→order (copy customer/PO/parts/pricing/cert flag/traveler + activity) — `createOrderFromQuote` + T5. §8.4 ship gate — T6/T12. §8.5 invoice+A/R — T7/T13/T14. §8.6 numbering — T2.
- Business rules: over-$25k approval (T5, manager `approve_over_limit`); Sent immutable / Revise clones (T2 `reviseQuote` + T10); discount role-gated (T9/T10 `apply_discount`); margin display-only stub (T4); cert gating manual release (T6/T12, `release_cert`); tax-exempt (no tax line — omitted per Q14(a)); numbering sequential no reset (T2).
- **Deferred/interpreted (called out, not gaps):** partial ship/invoice → whole-WO (Q7a); per-lb weight entered manually (Q3a); credit-hold enforcement (customer `hold`) — the spec lists it (§2) but it is **not** in the Plan 3 scope line; **not** implemented here (flag for a follow-up). Today dashboard is Plan 2 (auto-updates via hooks; only its `isLate`/`pastDueCents` math changed in T3).

**2. Placeholder scan** — no "TBD/handle edge cases/similar to Task N". Every code step shows the code; every run step shows the command + expected result. Two explicit **implementer wiring notes** (builder `onCustomerChange`; E2E status-button ordering) are design guidance, not missing code.

**3. Type consistency** — `CreateInput<T>` (T2) is used identically by `createOrderFromQuote`/`reviseQuote`/`buildQuoteDraft`/`toBillInvoiceFromOrder`/mutations. `agingBucket(invoice, netDays, asOf)` (3-arg) is used consistently in `ar.ts` + `dashboard.ts` (T3). Mutation var shapes match between hooks (T5–T7) and their callers (T9–T14): `useSendQuote({quote,operator})`, `useWinQuote(quote)`, `useTransitionOrder({order,to,actor,at})`, `useShipOrder({order,cert,actor,at})`, `useBillInvoice({invoice,at})`, `usePayInvoice({invoice,at})`. `orderStatusMeta`/`quoteStatusMeta`/`invoiceStatusMeta`/`certStatusMeta` labels drive both pills and E2E text.

# HeatSynQ Foundation & Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the HeatSynQ application foundation — a themed, navigable Next.js app with a fully tested domain core, a backend-ready mock data layer, mocked auth, a reusable pattern-component library, the app shell + command palette, and a live design-system page.

**Architecture:** Next.js (App Router) + TypeScript single deployable. The UI depends only on async **repository interfaces**; this phase ships an in-memory **mock** implementation (seeded, with simulated latency) so a real on-prem Postgres/API can drop in later behind the same interfaces. All business logic lives in **pure functions** in `lib/logic`, unit-tested first (TDD). Data access in components goes through **TanStack Query** hooks.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind CSS v4, shadcn/ui (Radix), TanStack Query v5, Zod, react-hook-form, cmdk, lucide-react, IBM Plex Sans/Mono (via `next/font`), Vitest + React Testing Library, Playwright (E2E lands in Plan 3).

## Global Constraints

- **Package manager:** npm. **Node:** ≥ 20.
- **TypeScript strict mode** on; no `any` in committed code (use `unknown` + narrowing).
- **Money is stored as integer cents** (`number`); whole-dollar display via the shared `formatMoney` helper.
- **Every persisted entity extends `BaseEntity`** (`id, createdAt, updatedAt, version`) for optimistic concurrency.
- **All repository methods are async** (return `Promise`).
- **Dates** are stored/passed as ISO strings (`string`), formatted at the edge.
- **Design tokens are exact** (from `docs/superpowers/reference/2026-06-30-heatsynq-grounded-reference.md` §1): primary `#3d63dd`, canvas `#f6f7f9`, surface `#ffffff`; IBM Plex Sans 13px base; **IBM Plex Mono for IDs, numbers, timestamps, status pills, uppercase group labels** (the brand signature).
- **Status-pill tone map (5 tones):** success=green, info=blue, warn=amber, danger=red, neutral=gray (exact hex in the token task).
- **App name:** HeatSynQ. **Demo shop:** Heritage Heat Treat.
- **Commit after every task** with a conventional-commit message; never leave the tree red.
- Test commands: `npm run test` (Vitest, watchless via `vitest run`), `npm run dev` (manual checks).

## File Structure (this phase)

```
app/
  layout.tsx                      # root: fonts, providers, <html>
  globals.css                     # Tailwind v4 + @theme tokens
  (auth)/login/page.tsx           # mocked login
  (app)/layout.tsx                # AppShell (sidebar+topbar+content)
  (app)/patterns/page.tsx         # design-system catalog
  (app)/today/page.tsx            # placeholder until Plan 2
lib/
  domain/
    base.ts          # BaseEntity, money/date helpers
    enums.ts         # status unions + Zod enums + tone/label meta
    entities.ts      # Zod schemas + inferred types for all slice entities
    index.ts
  logic/
    pricing.ts       # line amount, subtotal, discount, margin
    quote-state.ts   # quote lifecycle transitions
    order.ts         # createOrderFromQuote, ship gate, order transitions
    invoice.ts       # invoice lifecycle
    ar.ts            # aging buckets + customer balances
    numbering.ts     # sequential id/number service
  data/
    repositories/index.ts   # repository interfaces
    mock/store.ts           # in-memory store + latency/fault injection
    mock/repositories.ts    # mock impls
    seed/index.ts           # Heritage Heat Treat seed dataset
    provider.tsx            # RepositoriesProvider + useRepositories()
  query/
    keys.ts                 # query key factory
    hooks.ts                # TanStack Query hooks per entity
    provider.tsx            # QueryClientProvider
  auth/
    types.ts                # Session, permissions
    provider.tsx            # AuthProvider + useAuth + useCan
  ui/                       # shadcn primitives (generated, themed)
  utils.ts                  # cn() + formatMoney + formatDate
components/
  patterns/                 # StatusPill, MonoId, KpiTile, EmptyState, ErrorPanel,
                            # SkeletonRows, PageHeader, ListCard, DetailHeader,
                            # SummaryRail, FormField, ErrorSummary, ConfirmDialog
  shell/                    # AppShell, Sidebar, Topbar, CommandPalette, nav-config
tests/
  setup.ts
```

---

### Task 1: Scaffold the Next.js app + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `tests/setup.ts`, `app/layout.tsx`, `app/page.tsx`, `lib/utils.ts`
- Create: `.nvmrc`

**Interfaces:**
- Produces: `cn(...classes)` and `formatMoney(cents: number): string`, `formatDate(iso: string): string` in `lib/utils.ts`.

- [ ] **Step 1: Scaffold with create-next-app**

Run (in the repo root, which already has git + docs):
```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir=false --import-alias "@/*" --use-npm --no-turbopack --yes
```
If it refuses because the directory isn't empty, scaffold in a temp dir and copy in:
```bash
npx create-next-app@latest /tmp/heatsynq-scaffold --typescript --tailwind --eslint --app --src-dir=false --import-alias "@/*" --use-npm --no-turbopack --yes
cp -rn /tmp/heatsynq-scaffold/. .   # -n: do not overwrite existing docs/README/.gitignore
rm -rf /tmp/heatsynq-scaffold
```

- [ ] **Step 2: Install runtime + dev dependencies**

```bash
npm install @tanstack/react-query zod react-hook-form @hookform/resolvers cmdk lucide-react class-variance-authority clsx tailwind-merge
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 3: Add `lib/utils.ts`**

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** cents -> whole-dollar display, e.g. 842000 -> "$8,420" */
export function formatMoney(cents: number): string {
  return USD.format(Math.round(cents) / 100);
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}
```

- [ ] **Step 4: Configure Vitest** — create `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
```

Create `tests/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

Add scripts to `package.json` (`"scripts"` block):
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Add a smoke test** — create `lib/utils.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { formatMoney, formatDate, cn } from "@/lib/utils";

describe("utils", () => {
  it("formats cents to whole dollars", () => {
    expect(formatMoney(842000)).toBe("$8,420");
    expect(formatMoney(58400 * 100)).toBe("$58,400");
  });
  it("merges classes", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("formats ISO dates", () => {
    expect(formatDate("2026-06-30T00:00:00.000Z")).toMatch(/Jun .*2026/);
  });
});
```

- [ ] **Step 6: Run tests + dev server**

Run: `npm run test`
Expected: PASS (3 tests).
Run: `npm run dev` then open `http://localhost:3000` — Next.js default page renders. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold Next.js app + test tooling + utils"
```

---

### Task 2: Design tokens, fonts, and status-tone helper

**Files:**
- Modify: `app/globals.css`, `app/layout.tsx`
- Create: `lib/domain/enums.ts` (tone helper lives here; entity enums added in Task 4 — create the file now with enums + tone map)
- Create: `lib/domain/enums.test.ts`

**Interfaces:**
- Produces: `StatusTone = "success"|"info"|"warn"|"danger"|"neutral"`, and `toneClasses(tone): string` returning Tailwind classes for pill text+bg.

- [ ] **Step 1: Write the failing test** — `lib/domain/enums.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { toneClasses, type StatusTone } from "@/lib/domain/enums";

describe("toneClasses", () => {
  it("returns text+bg utility classes per tone", () => {
    const tones: StatusTone[] = ["success", "info", "warn", "danger", "neutral"];
    for (const t of tones) {
      const c = toneClasses(t);
      expect(c).toContain("text-status-" + t);
      expect(c).toContain("bg-status-" + t + "-tint");
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`toneClasses` not defined). `npm run test -- enums`

- [ ] **Step 3: Create `lib/domain/enums.ts`**

```ts
export type StatusTone = "success" | "info" | "warn" | "danger" | "neutral";

export function toneClasses(tone: StatusTone): string {
  return `text-status-${tone} bg-status-${tone}-tint`;
}
```

- [ ] **Step 4: Run it — expect PASS.** `npm run test -- enums`

- [ ] **Step 5: Add tokens to `app/globals.css`** (Tailwind v4 `@theme`)

```css
@import "tailwindcss";

@theme {
  --color-canvas: #f6f7f9;
  --color-canvas-alt: #eef0f4;
  --color-surface: #ffffff;
  --color-surface-sidebar: #fbfbfd;
  --color-surface-subtle: #f0f1f5;

  --color-text: #1d2330;
  --color-text-secondary: #5b637a;
  --color-text-muted: #8a92a3;
  --color-text-faint: #aab0bd;
  --color-text-nav-idle: #6b7280;

  --color-border: #e7e9ee;
  --color-border-alt: #e2e5ec;
  --color-border-faint: #f5f6f8;

  --color-primary: #3d63dd;
  --color-primary-tint: #eef1fd;
  --color-primary-dark: #2c4db0;

  --color-status-success: #1f9d6b;
  --color-status-success-tint: #e8f5ef;
  --color-status-info: #3d63dd;
  --color-status-info-tint: #eef1fd;
  --color-status-warn: #c98a16;
  --color-status-warn-tint: #fbf2e0;
  --color-status-danger: #d4503e;
  --color-status-danger-tint: #fcebe8;
  --color-status-neutral: #6b7280;
  --color-status-neutral-tint: #f0f1f5;

  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;

  --radius-pill: 6px;
  --radius-card: 10px;
  --radius-modal: 16px;
}

html, body { height: 100%; }
body {
  background: var(--color-canvas);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}

@keyframes vsPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
@keyframes vsShimmer { 0% { background-position: -468px 0 } 100% { background-position: 468px 0 } }
```

- [ ] **Step 6: Wire fonts in `app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400","500","600","700"], variable: "--font-plex-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400","500","600"], variable: "--font-plex-mono" });

export const metadata: Metadata = { title: "HeatSynQ", description: "Heat-treat ERP" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

In `@theme`, point the font tokens at the next/font variables:
```css
--font-sans: var(--font-plex-sans), system-ui, sans-serif;
--font-mono: var(--font-plex-mono), ui-monospace, monospace;
```

- [ ] **Step 7: Manual check** — `npm run dev`, confirm the page uses IBM Plex Sans and the canvas is `#f6f7f9`. Stop server.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: design tokens, IBM Plex fonts, status-tone helper"
```

---

### Task 3: Initialize shadcn/ui and generate base primitives

**Files:**
- Create (generated): `lib/ui/button.tsx`, `lib/ui/input.tsx`, `lib/ui/dialog.tsx`, `lib/ui/dropdown-menu.tsx`, `lib/ui/tabs.tsx`, `lib/ui/badge.tsx`, `lib/ui/skeleton.tsx`, `lib/ui/label.tsx`, `lib/ui/select.tsx`, `lib/ui/table.tsx`, `components.json`

**Interfaces:**
- Produces: shadcn primitives importable from `@/lib/ui/*`, themed via the CSS tokens.

- [ ] **Step 1: Init shadcn**

```bash
npx shadcn@latest init -d
```
When prompted (or via flags), set the components dir to `lib/ui` (edit `components.json` `"aliases": { "components": "@/lib", "ui": "@/lib/ui", "utils": "@/lib/utils" }`).

- [ ] **Step 2: Add the primitives**

```bash
npx shadcn@latest add button input dialog dropdown-menu tabs badge skeleton label select table
```

- [ ] **Step 3: Verify build** — `npm run dev`, confirm no import errors; stop server.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: init shadcn/ui + base primitives"
```

---

### Task 4: Domain base types + entity schemas

**Files:**
- Create: `lib/domain/base.ts`, `lib/domain/entities.ts`, `lib/domain/index.ts`
- Modify: `lib/domain/enums.ts` (add entity status unions + Zod enums + label/tone meta)
- Create: `lib/domain/entities.test.ts`

**Interfaces:**
- Produces: `BaseEntity`; Zod schemas + inferred types for `Customer, Contact, Part, ProcessMaster, ProcessStep, Quote, QuotePart, QuoteLine, WorkOrder, OrderLine, Certification, Specification, PriceKey, PricingRule, Invoice, Operator, Role`; status unions `QuoteStatus, OrderStatus, InvoiceStatus, CertStatus, CustomerStatus, PricingBasis, RoleKey`; meta maps `quoteStatusMeta`, `orderStatusMeta`, `invoiceStatusMeta`, `certStatusMeta`, `customerStatusMeta` each `{ label: string; tone: StatusTone }`.

- [ ] **Step 1: Add enums + meta to `lib/domain/enums.ts`** (append below `toneClasses`)

```ts
export const QUOTE_STATUSES = ["draft","sent","approve","won","lost"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const ORDER_STATUSES = ["received","scheduled","in_process","on_hold","ready_to_ship","shipped"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const INVOICE_STATUSES = ["to_bill","sent","paid"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const CERT_STATUSES = ["pending","released"] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];

export const CUSTOMER_STATUSES = ["active","hold","dormant"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const PRICING_BASES = ["per_lb","per_lot","per_piece","flat"] as const;
export type PricingBasis = (typeof PRICING_BASES)[number];

export const ROLE_KEYS = ["manager","sales","office"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

type Meta<T extends string> = Record<T, { label: string; tone: StatusTone }>;

export const quoteStatusMeta: Meta<QuoteStatus> = {
  draft: { label: "Draft", tone: "warn" },
  sent: { label: "Sent", tone: "info" },
  approve: { label: "Approve", tone: "warn" },
  won: { label: "Won", tone: "success" },
  lost: { label: "Lost", tone: "neutral" },
};
export const orderStatusMeta: Meta<OrderStatus> = {
  received: { label: "Received", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "neutral" },
  in_process: { label: "In Process", tone: "info" },
  on_hold: { label: "On Hold", tone: "warn" },
  ready_to_ship: { label: "Ready to ship", tone: "success" },
  shipped: { label: "Shipped", tone: "success" },
};
export const invoiceStatusMeta: Meta<InvoiceStatus> = {
  to_bill: { label: "To bill", tone: "warn" },
  sent: { label: "Sent", tone: "info" },
  paid: { label: "Paid", tone: "success" },
};
export const certStatusMeta: Meta<CertStatus> = {
  pending: { label: "Pending", tone: "warn" },
  released: { label: "Released", tone: "success" },
};
export const customerStatusMeta: Meta<CustomerStatus> = {
  active: { label: "Active", tone: "success" },
  hold: { label: "Hold", tone: "warn" },
  dormant: { label: "Dormant", tone: "neutral" },
};
export const basisLabel: Record<PricingBasis, string> = {
  per_lb: "per lb", per_lot: "per lot", per_piece: "per piece", flat: "flat",
};
```

- [ ] **Step 2: Create `lib/domain/base.ts`**

```ts
import { z } from "zod";

export const baseEntitySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative(),
});
export type BaseEntity = z.infer<typeof baseEntitySchema>;

/** Discount applied at quote level. */
export const discountSchema = z.object({
  kind: z.enum(["amount", "percent"]),
  value: z.number().nonnegative(), // cents (amount) or whole-percent (percent)
});
export type Discount = z.infer<typeof discountSchema>;
```

- [ ] **Step 3: Create `lib/domain/entities.ts`** (Zod schemas; all money fields are integer cents)

```ts
import { z } from "zod";
import { baseEntitySchema, discountSchema } from "./base";
import {
  QUOTE_STATUSES, ORDER_STATUSES, INVOICE_STATUSES, CERT_STATUSES,
  CUSTOMER_STATUSES, PRICING_BASES, ROLE_KEYS,
} from "./enums";

export const operatorSchema = baseEntitySchema.extend({
  name: z.string(),
  initials: z.string(),
  title: z.string(),
  role: z.enum(ROLE_KEYS),
  quoteAuthLimitCents: z.number().int().nonnegative(),
});
export type Operator = z.infer<typeof operatorSchema>;

export const contactSchema = baseEntitySchema.extend({
  customerId: z.string(),
  name: z.string(),
  role: z.string(),
  email: z.string(),
  phone: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const customerSchema = baseEntitySchema.extend({
  customerNumber: z.string(),       // "1042"
  name: z.string(),
  initials: z.string(),
  city: z.string(),
  billingAddress: z.string(),
  phone: z.string(),
  terms: z.string(),                // "Net 30"
  status: z.enum(CUSTOMER_STATUSES),
  priceKeyId: z.string().nullable(),
  taxExempt: z.boolean(),
  defaultCertSpecId: z.string().nullable(),
  defaultCertCopies: z.number().int().nonnegative(),
  ytdSalesCents: z.number().int(),
});
export type Customer = z.infer<typeof customerSchema>;

export const specificationSchema = baseEntitySchema.extend({
  code: z.string(),                 // "AMS 2759/3"
  title: z.string(),
  rev: z.string(),
  owner: z.string(),                // SAE / DoD / Customer
});
export type Specification = z.infer<typeof specificationSchema>;

export const pricingRuleSchema = baseEntitySchema.extend({
  priceKeyId: z.string(),
  process: z.string(),              // "Carburize"
  basis: z.enum(PRICING_BASES),
  rateCents: z.number().int().nonnegative(),
  minChargeCents: z.number().int().nonnegative().nullable(),
});
export type PricingRule = z.infer<typeof pricingRuleSchema>;

export const priceKeySchema = baseEntitySchema.extend({
  code: z.string(),                 // "AERO-1"
  description: z.string(),
});
export type PriceKey = z.infer<typeof priceKeySchema>;

export const processStepSchema = z.object({
  n: z.number().int().positive(),
  op: z.string(),                   // "Carburize"
  equip: z.string(),                // work-center label
  instr: z.string(),
  params: z.array(z.string()),
  track: z.enum(["track_in","track_in_out","track_out","inspect","none"]),
});
export type ProcessStep = z.infer<typeof processStepSchema>;

export const processMasterSchema = baseEntitySchema.extend({
  code: z.string(),                 // "PM-CARB-58"
  name: z.string(),                 // "Carburize & temper"
  description: z.string(),
  rev: z.string(),
  status: z.literal("active"),
  steps: z.array(processStepSchema),
  surfaceHardness: z.string(),
  caseDepth: z.string(),
  hardnessScale: z.string(),
});
export type ProcessMaster = z.infer<typeof processMasterSchema>;

export const partSchema = baseEntitySchema.extend({
  partNumber: z.string(),           // "TS-4471"
  description: z.string(),
  customerId: z.string(),
  material: z.string(),
  drawingRev: z.string(),
  hardness: z.string(),
  caseDepth: z.string(),
  specificationId: z.string().nullable(),
  processMasterId: z.string().nullable(),
  priceKeyId: z.string().nullable(),
  inspectionScale: z.string(),
  inspectionSample: z.string(),
});
export type Part = z.infer<typeof partSchema>;

export const quoteLineSchema = z.object({
  id: z.string(),
  process: z.string(),
  basis: z.enum(PRICING_BASES),
  qtyOrWeight: z.number().nonnegative(),
  rateCents: z.number().int().nonnegative(),
  minChargeCents: z.number().int().nonnegative().nullable(),
});
export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const quotePartSchema = z.object({
  id: z.string(),
  partId: z.string(),
  material: z.string(),
  quantity: z.number().int().nonnegative(),
  lines: z.array(quoteLineSchema),
});
export type QuotePart = z.infer<typeof quotePartSchema>;

export const quoteSchema = baseEntitySchema.extend({
  number: z.string(),               // "Q-2841"
  rev: z.number().int().nonnegative(),
  customerId: z.string(),
  customerPO: z.string(),
  status: z.enum(QUOTE_STATUSES),
  salespersonId: z.string(),
  date: z.string(),
  validUntil: z.string(),
  requiredBy: z.string().nullable(),
  discount: discountSchema.nullable(),
  estCostCents: z.number().int().nonnegative(), // stub cost for margin
  notes: z.string(),
  parts: z.array(quotePartSchema),
  wonOrderId: z.string().nullable(),
});
export type Quote = z.infer<typeof quoteSchema>;

export const orderLineSchema = z.object({
  id: z.string(),
  partId: z.string(),
  description: z.string(),
  quantity: z.number().int().nonnegative(),
  spec: z.string(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderPricingLineSchema = z.object({
  process: z.string(),
  detail: z.string(),               // "600 lb"
  amountCents: z.number().int(),
});
export type OrderPricingLine = z.infer<typeof orderPricingLineSchema>;

export const activityEntrySchema = z.object({
  at: z.string(),
  actor: z.string(),
  message: z.string(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const workOrderSchema = baseEntitySchema.extend({
  number: z.string(),               // "WO-48211"
  customerId: z.string(),
  customerPO: z.string(),
  quoteId: z.string().nullable(),
  processSummary: z.string(),       // "Carburize + Temper"
  processMasterId: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  orderedDate: z.string(),
  due: z.string(),
  certifyRequired: z.boolean(),
  certSpecId: z.string().nullable(),
  orderValueCents: z.number().int().nonnegative(),
  progressPct: z.number().int().min(0).max(100),
  lines: z.array(orderLineSchema),
  pricing: z.array(orderPricingLineSchema),
  steps: z.array(processStepSchema),
  activity: z.array(activityEntrySchema),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

export const certificationSchema = baseEntitySchema.extend({
  number: z.string(),               // "C-9921"
  customerId: z.string(),
  workOrderId: z.string(),
  specificationId: z.string().nullable(),
  type: z.string(),
  status: z.enum(CERT_STATUSES),
  copies: z.number().int().nonnegative(),
});
export type Certification = z.infer<typeof certificationSchema>;

export const invoiceSchema = baseEntitySchema.extend({
  number: z.string().nullable(),    // null while "to_bill"
  customerId: z.string(),
  workOrderId: z.string(),
  amountCents: z.number().int().nonnegative(),
  status: z.enum(INVOICE_STATUSES),
  shippedDate: z.string(),
  invoicedDate: z.string().nullable(),
  paidDate: z.string().nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;
```

- [ ] **Step 4: Create `lib/domain/index.ts`**

```ts
export * from "./base";
export * from "./enums";
export * from "./entities";
```

- [ ] **Step 5: Write the test** — `lib/domain/entities.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { quoteSchema, customerSchema } from "@/lib/domain";

const base = { id: "x", createdAt: "2026-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z", version: 0 };

describe("entity schemas", () => {
  it("parses a valid customer", () => {
    const c = customerSchema.parse({
      ...base, customerNumber: "1042", name: "Apex Aerospace", initials: "AA",
      city: "Wichita, KS", billingAddress: "4120 Industrial Pkwy", phone: "(316) 555-0142",
      terms: "Net 30", status: "active", priceKeyId: "pk1", taxExempt: true,
      defaultCertSpecId: "s1", defaultCertCopies: 2, ytdSalesCents: 21400000,
    });
    expect(c.status).toBe("active");
  });
  it("rejects an invalid quote status", () => {
    expect(() => quoteSchema.parse({ ...base, number: "Q-1", rev: 0, customerId: "c1",
      customerPO: "", status: "bogus", salespersonId: "o1", date: base.createdAt,
      validUntil: base.createdAt, requiredBy: null, discount: null, estCostCents: 0,
      notes: "", parts: [], wonOrderId: null })).toThrow();
  });
});
```

- [ ] **Step 6: Run — expect PASS.** `npm run test -- entities enums`

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: domain base types, enums+meta, entity Zod schemas"
```

---

### Task 5: Pure logic — pricing

**Files:**
- Create: `lib/logic/pricing.ts`, `lib/logic/pricing.test.ts`

**Interfaces:**
- Produces:
  - `lineAmountCents(line: { qtyOrWeight: number; rateCents: number; minChargeCents: number | null }): number`
  - `quoteSubtotalCents(parts: QuotePart[]): number`
  - `applyDiscountCents(subtotalCents: number, discount: Discount | null): number`
  - `quoteTotalCents(quote: Pick<Quote,"parts"|"discount">): number`
  - `marginPct(totalCents: number, costCents: number): number`

- [ ] **Step 1: Write the failing tests** — `lib/logic/pricing.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { lineAmountCents, quoteSubtotalCents, applyDiscountCents, quoteTotalCents, marginPct } from "@/lib/logic/pricing";
import type { QuotePart } from "@/lib/domain";

describe("pricing", () => {
  it("multiplies rate by qty/weight", () => {
    expect(lineAmountCents({ qtyOrWeight: 600, rateCents: 1030, minChargeCents: null })).toBe(618000);
  });
  it("applies the min charge floor", () => {
    expect(lineAmountCents({ qtyOrWeight: 1, rateCents: 10000, minChargeCents: 25000 })).toBe(25000);
  });
  it("sums all line amounts across parts", () => {
    const parts = [{ id:"p", partId:"x", material:"4140", quantity:480, lines: [
      { id:"l1", process:"Carburize", basis:"per_lb", qtyOrWeight:600, rateCents:1030, minChargeCents:null },
      { id:"l2", process:"Temper", basis:"per_lot", qtyOrWeight:1, rateCents:144000, minChargeCents:null },
      { id:"l3", process:"Certification", basis:"flat", qtyOrWeight:1, rateCents:80000, minChargeCents:null },
    ]}] as unknown as QuotePart[];
    expect(quoteSubtotalCents(parts)).toBe(842000);
  });
  it("applies amount and percent discounts", () => {
    expect(applyDiscountCents(842000, { kind:"amount", value:42000 })).toBe(800000);
    expect(applyDiscountCents(800000, { kind:"percent", value:10 })).toBe(720000);
    expect(applyDiscountCents(842000, null)).toBe(842000);
  });
  it("computes whole-percent margin", () => {
    expect(marginPct(842000, 488360)).toBe(42); // (842000-488360)/842000 = 0.42
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- pricing`

- [ ] **Step 3: Implement `lib/logic/pricing.ts`**

```ts
import type { Discount, QuotePart, Quote } from "@/lib/domain";

export function lineAmountCents(line: { qtyOrWeight: number; rateCents: number; minChargeCents: number | null }): number {
  const raw = Math.round(line.qtyOrWeight * line.rateCents);
  return line.minChargeCents != null ? Math.max(raw, line.minChargeCents) : raw;
}

export function quoteSubtotalCents(parts: QuotePart[]): number {
  return parts.reduce((sum, p) => sum + p.lines.reduce((s, l) => s + lineAmountCents(l), 0), 0);
}

export function applyDiscountCents(subtotalCents: number, discount: Discount | null): number {
  if (!discount) return subtotalCents;
  if (discount.kind === "amount") return Math.max(0, subtotalCents - discount.value);
  return Math.round(subtotalCents * (1 - discount.value / 100));
}

export function quoteTotalCents(quote: Pick<Quote, "parts" | "discount">): number {
  return applyDiscountCents(quoteSubtotalCents(quote.parts), quote.discount);
}

export function marginPct(totalCents: number, costCents: number): number {
  if (totalCents <= 0) return 0;
  return Math.round(((totalCents - costCents) / totalCents) * 100);
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- pricing`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pricing logic (line amount, subtotal, discount, total, margin)"
```

---

### Task 6: Pure logic — quote lifecycle

**Files:**
- Create: `lib/logic/quote-state.ts`, `lib/logic/quote-state.test.ts`

**Interfaces:**
- Produces:
  - `sendQuote(quote: Quote, operator: Operator): { status: QuoteStatus }` — returns `won`? no: returns `sent` if total ≤ limit else `approve`.
  - `requiresApproval(quote: Quote, operator: Operator): boolean`
  - `approveQuote(quote: Quote): Quote` (approve → sent), `rejectQuote(quote): Quote` (approve → draft)
  - `winQuote(quote): Quote`, `loseQuote(quote): Quote`
  - `reviseQuote(quote: Quote): Omit<Quote,"id"|"createdAt"|"updatedAt"|"version">` (clone as draft, rev+1)
  - `isEditable(quote: Quote): boolean` (true only when draft)
- Consumes: `quoteTotalCents` from Task 5.

- [ ] **Step 1: Write failing tests** — `lib/logic/quote-state.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { requiresApproval, sendQuote, approveQuote, rejectQuote, winQuote, reviseQuote, isEditable } from "@/lib/logic/quote-state";
import type { Quote, Operator } from "@/lib/domain";

const op = (limit: number): Operator => ({ id:"o1", createdAt:"", updatedAt:"", version:0,
  name:"Dana", initials:"DM", title:"PM", role:"sales", quoteAuthLimitCents: limit });

const draft = (totalLine: number): Quote => ({ id:"q1", createdAt:"", updatedAt:"", version:0,
  number:"Q-2841", rev:0, customerId:"c1", customerPO:"", status:"draft", salespersonId:"o1",
  date:"", validUntil:"", requiredBy:null, discount:null, estCostCents:0, notes:"", wonOrderId:null,
  parts:[{ id:"p", partId:"x", material:"4140", quantity:1, lines:[
    { id:"l", process:"Carburize", basis:"flat", qtyOrWeight:1, rateCents: totalLine, minChargeCents:null }]}] });

describe("quote lifecycle", () => {
  it("only drafts are editable", () => {
    expect(isEditable(draft(1))).toBe(true);
    expect(isEditable({ ...draft(1), status:"sent" })).toBe(false);
  });
  it("under limit sends directly", () => {
    expect(requiresApproval(draft(2000000), op(2500000))).toBe(false);
    expect(sendQuote(draft(2000000), op(2500000)).status).toBe("sent");
  });
  it("over limit routes to approval", () => {
    expect(requiresApproval(draft(3000000), op(2500000))).toBe(true);
    expect(sendQuote(draft(3000000), op(2500000)).status).toBe("approve");
  });
  it("approve -> sent, reject -> draft", () => {
    expect(approveQuote({ ...draft(1), status:"approve" }).status).toBe("sent");
    expect(rejectQuote({ ...draft(1), status:"approve" }).status).toBe("draft");
  });
  it("win sets won", () => {
    expect(winQuote({ ...draft(1), status:"sent" }).status).toBe("won");
  });
  it("revise clones as a new draft revision", () => {
    const r = reviseQuote({ ...draft(1), status:"sent", rev:0 });
    expect(r.status).toBe("draft");
    expect(r.rev).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- quote-state`

- [ ] **Step 3: Implement `lib/logic/quote-state.ts`**

```ts
import type { Quote, Operator, QuoteStatus } from "@/lib/domain";
import { quoteTotalCents } from "./pricing";

export function isEditable(quote: Quote): boolean {
  return quote.status === "draft";
}

export function requiresApproval(quote: Quote, operator: Operator): boolean {
  return quoteTotalCents(quote) > operator.quoteAuthLimitCents;
}

export function sendQuote(quote: Quote, operator: Operator): { status: QuoteStatus } {
  return { status: requiresApproval(quote, operator) ? "approve" : "sent" };
}

export function approveQuote(quote: Quote): Quote {
  return { ...quote, status: "sent" };
}
export function rejectQuote(quote: Quote): Quote {
  return { ...quote, status: "draft" };
}
export function winQuote(quote: Quote): Quote {
  return { ...quote, status: "won" };
}
export function loseQuote(quote: Quote): Quote {
  return { ...quote, status: "lost" };
}

export function reviseQuote(quote: Quote): Omit<Quote, "id" | "createdAt" | "updatedAt" | "version"> {
  const { id: _id, createdAt: _c, updatedAt: _u, version: _v, ...rest } = quote;
  return { ...rest, status: "draft", rev: quote.rev + 1, wonOrderId: null };
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- quote-state`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: quote lifecycle logic (send/approve/reject/win/lose/revise)"
```

---

### Task 7: Pure logic — order creation, ship gate, transitions

**Files:**
- Create: `lib/logic/order.ts`, `lib/logic/order.test.ts`

**Interfaces:**
- Produces:
  - `createOrderFromQuote(quote: Quote, ctx: { partsById: Record<string, Part>; processMastersById: Record<string, ProcessMaster>; customer: Customer }): NewWorkOrder` where `NewWorkOrder = Omit<WorkOrder,"id"|"createdAt"|"updatedAt"|"version"|"number">`.
  - `canShipOrder(order: WorkOrder, cert: Certification | null): { ok: boolean; reason?: string }`
  - `ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]>` and `canTransitionOrder(from, to): boolean`
- Consumes: `quoteTotalCents`, `lineAmountCents` (Task 5); domain types (Task 4).

- [ ] **Step 1: Write failing tests** — `lib/logic/order.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { createOrderFromQuote, canShipOrder, canTransitionOrder } from "@/lib/logic/order";
import type { Quote, Part, ProcessMaster, Customer, WorkOrder, Certification } from "@/lib/domain";

const part: Part = { id:"pt1", createdAt:"", updatedAt:"", version:0, partNumber:"TS-4471",
  description:"Turbine shaft", customerId:"c1", material:"4140 steel", drawingRev:"C",
  hardness:"Rc 58-62", caseDepth:".020-.030 in", specificationId:"s1", processMasterId:"pm1",
  priceKeyId:"pk1", inspectionScale:"Rockwell C", inspectionSample:"3 pc / lot" };

const pm: ProcessMaster = { id:"pm1", createdAt:"", updatedAt:"", version:0, code:"PM-CARB-58",
  name:"Carburize & temper", description:"", rev:"C", status:"active", surfaceHardness:"Rc 58-62",
  caseDepth:".020-.030 in", hardnessScale:"Rockwell C", steps:[
    { n:1, op:"Receive & verify", equip:"Receiving", instr:"", params:[], track:"track_in" }] };

const customer: Customer = { id:"c1", createdAt:"", updatedAt:"", version:0, customerNumber:"1042",
  name:"Apex Aerospace", initials:"AA", city:"", billingAddress:"", phone:"", terms:"Net 30",
  status:"active", priceKeyId:"pk1", taxExempt:true, defaultCertSpecId:"s1", defaultCertCopies:2, ytdSalesCents:0 };

const quote: Quote = { id:"q1", createdAt:"", updatedAt:"", version:0, number:"Q-2841", rev:0,
  customerId:"c1", customerPO:"7741-A", status:"won", salespersonId:"o1", date:"", validUntil:"",
  requiredBy:null, discount:null, estCostCents:0, notes:"", wonOrderId:null, parts:[
  { id:"qp1", partId:"pt1", material:"4140 steel", quantity:480, lines:[
    { id:"l1", process:"Carburize", basis:"per_lb", qtyOrWeight:600, rateCents:1030, minChargeCents:null },
    { id:"l2", process:"Temper", basis:"per_lot", qtyOrWeight:1, rateCents:144000, minChargeCents:null }]}] };

describe("order creation", () => {
  const order = createOrderFromQuote(quote, { partsById:{ pt1: part }, processMastersById:{ pm1: pm }, customer });
  it("carries the quote total into orderValue", () => {
    expect(order.orderValueCents).toBe(618000 + 144000);
  });
  it("links the quote and copies customer PO", () => {
    expect(order.quoteId).toBe("q1");
    expect(order.customerPO).toBe("7741-A");
  });
  it("instantiates traveler steps from the part's process master", () => {
    expect(order.steps[0].op).toBe("Receive & verify");
  });
  it("sets cert flag from the customer default cert spec", () => {
    expect(order.certifyRequired).toBe(true);
    expect(order.certSpecId).toBe("s1");
  });
  it("starts at received with an activity entry", () => {
    expect(order.status).toBe("received");
    expect(order.activity[0].message).toContain("Q-2841");
  });
  it("creates one order line per quote part", () => {
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].quantity).toBe(480);
  });
});

describe("ship gate", () => {
  const base = { ...(quote as unknown as WorkOrder) };
  it("blocks ship when a required cert is not released", () => {
    const o = { certifyRequired:true } as WorkOrder;
    expect(canShipOrder(o, { status:"pending" } as Certification).ok).toBe(false);
  });
  it("allows ship when cert released", () => {
    const o = { certifyRequired:true } as WorkOrder;
    expect(canShipOrder(o, { status:"released" } as Certification).ok).toBe(true);
  });
  it("allows ship when no cert required", () => {
    expect(canShipOrder({ certifyRequired:false } as WorkOrder, null).ok).toBe(true);
  });
});

describe("order transitions", () => {
  it("permits received -> scheduled but not received -> shipped", () => {
    expect(canTransitionOrder("received","scheduled")).toBe(true);
    expect(canTransitionOrder("received","shipped")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- order`

- [ ] **Step 3: Implement `lib/logic/order.ts`**

```ts
import type {
  Quote, Part, ProcessMaster, Customer, WorkOrder, OrderStatus, Certification,
} from "@/lib/domain";
import { quoteTotalCents, lineAmountCents } from "./pricing";

export type NewWorkOrder = Omit<WorkOrder, "id" | "createdAt" | "updatedAt" | "version" | "number">;

export function createOrderFromQuote(
  quote: Quote,
  ctx: { partsById: Record<string, Part>; processMastersById: Record<string, ProcessMaster>; customer: Customer },
): NewWorkOrder {
  const firstPart = ctx.partsById[quote.parts[0]?.partId];
  const pm = firstPart?.processMasterId ? ctx.processMastersById[firstPart.processMasterId] : undefined;
  const processNames = Array.from(new Set(quote.parts.flatMap((p) => p.lines.map((l) => l.process))))
    .filter((p) => p.toLowerCase() !== "certification");

  return {
    customerId: quote.customerId,
    customerPO: quote.customerPO,
    quoteId: quote.id,
    processSummary: processNames.join(" + "),
    processMasterId: pm?.id ?? null,
    status: "received",
    orderedDate: quote.date,
    due: quote.requiredBy ?? quote.date,
    certifyRequired: ctx.customer.defaultCertSpecId != null,
    certSpecId: ctx.customer.defaultCertSpecId,
    orderValueCents: quoteTotalCents(quote),
    progressPct: 0,
    lines: quote.parts.map((qp) => {
      const part = ctx.partsById[qp.partId];
      return { id: qp.id, partId: qp.partId, description: part?.description ?? "", quantity: qp.quantity, spec: part?.hardness ?? "" };
    }),
    pricing: quote.parts.flatMap((qp) =>
      qp.lines.map((l) => ({ process: l.process, detail: detailFor(l.basis, l.qtyOrWeight), amountCents: lineAmountCents(l) })),
    ),
    steps: pm?.steps ?? [],
    activity: [{ at: quote.date, actor: "System", message: `Order created from ${quote.number}` }],
  };
}

function detailFor(basis: string, qty: number): string {
  if (basis === "per_lb") return `${qty} lb`;
  if (basis === "per_piece") return `${qty} pc`;
  return "";
}

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  received: ["scheduled", "on_hold"],
  scheduled: ["in_process", "on_hold"],
  in_process: ["ready_to_ship", "on_hold"],
  on_hold: ["received", "scheduled", "in_process"],
  ready_to_ship: ["shipped", "on_hold"],
  shipped: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function canShipOrder(order: WorkOrder, cert: Certification | null): { ok: boolean; reason?: string } {
  if (!order.certifyRequired) return { ok: true };
  if (cert?.status === "released") return { ok: true };
  return { ok: false, reason: "Certification must be released before ship" };
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- order`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: order creation from quote, ship gate, order transitions"
```

---

### Task 8: Pure logic — invoice lifecycle, A/R aging, numbering

**Files:**
- Create: `lib/logic/invoice.ts`, `lib/logic/ar.ts`, `lib/logic/numbering.ts`
- Create: `lib/logic/invoice.test.ts`, `lib/logic/ar.test.ts`, `lib/logic/numbering.test.ts`

**Interfaces:**
- Produces:
  - `invoice.ts`: `toBillInvoiceFromOrder(order: WorkOrder, shippedDate: string): NewInvoice` (`NewInvoice = Omit<Invoice,"id"|"createdAt"|"updatedAt"|"version">`); `billInvoice(inv: Invoice, number: string, invoicedDate: string): Invoice`; `payInvoice(inv: Invoice, paidDate: string): Invoice`.
  - `ar.ts`: `agingBucket(invoice: Invoice, asOf: string): "current"|"d1_30"|"d31_60"|"d61_90"|"d90_plus"`; `ageInvoices(invoices: Invoice[], asOf: string): Record<Bucket, number>`; `customerBalanceCents(invoices: Invoice[], customerId: string): number`.
  - `numbering.ts`: `formatNumber(prefix: string, seq: number): string`; `class Counter { next(prefix): string }`.

- [ ] **Step 1: Write failing tests**

`lib/logic/invoice.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toBillInvoiceFromOrder, billInvoice, payInvoice } from "@/lib/logic/invoice";
import type { WorkOrder, Invoice } from "@/lib/domain";

const order = { id:"wo1", customerId:"c1", orderValueCents: 842000 } as WorkOrder;

describe("invoice lifecycle", () => {
  it("creates a to_bill invoice on ship with no number", () => {
    const inv = toBillInvoiceFromOrder(order, "2026-07-02T00:00:00.000Z");
    expect(inv.status).toBe("to_bill");
    expect(inv.number).toBeNull();
    expect(inv.amountCents).toBe(842000);
  });
  it("bills -> sent with a number + date", () => {
    const inv = billInvoice({ status:"to_bill", number:null, invoicedDate:null } as Invoice, "INV-30412", "2026-07-03T00:00:00.000Z");
    expect(inv.status).toBe("sent");
    expect(inv.number).toBe("INV-30412");
  });
  it("pays -> paid", () => {
    expect(payInvoice({ status:"sent" } as Invoice, "2026-07-20T00:00:00.000Z").status).toBe("paid");
  });
});
```

`lib/logic/ar.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { agingBucket, ageInvoices, customerBalanceCents } from "@/lib/logic/ar";
import type { Invoice } from "@/lib/domain";

const inv = (id: string, customerId: string, amountCents: number, status: Invoice["status"], invoicedDate: string | null): Invoice =>
  ({ id, createdAt:"", updatedAt:"", version:0, number:"INV-"+id, customerId, workOrderId:"w",
    amountCents, status, shippedDate:"", invoicedDate, paidDate:null });

const asOf = "2026-07-31T00:00:00.000Z";

describe("AR aging", () => {
  it("buckets by age of invoice date", () => {
    expect(agingBucket(inv("1","c1",100,"sent","2026-07-25T00:00:00.000Z"), asOf)).toBe("current");
    expect(agingBucket(inv("2","c1",100,"sent","2026-07-10T00:00:00.000Z"), asOf)).toBe("d1_30");
    expect(agingBucket(inv("3","c1",100,"sent","2026-06-15T00:00:00.000Z"), asOf)).toBe("d31_60");
  });
  it("only ages unpaid (sent) invoices", () => {
    const totals = ageInvoices([
      inv("1","c1",5000,"sent","2026-07-25T00:00:00.000Z"),
      inv("2","c1",9999,"paid","2026-07-25T00:00:00.000Z"),
    ], asOf);
    expect(totals.current).toBe(5000);
  });
  it("sums a customer's open balance", () => {
    expect(customerBalanceCents([
      inv("1","c1",5000,"sent","2026-07-25T00:00:00.000Z"),
      inv("2","c1",3000,"sent","2026-07-10T00:00:00.000Z"),
      inv("3","c2",1000,"sent","2026-07-10T00:00:00.000Z"),
    ], "c1")).toBe(8000);
  });
});
```

`lib/logic/numbering.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatNumber, Counter } from "@/lib/logic/numbering";

describe("numbering", () => {
  it("formats prefix + sequence", () => {
    expect(formatNumber("WO-", 48211)).toBe("WO-48211");
  });
  it("increments per prefix independently", () => {
    const c = new Counter({ "Q-": 2840, "WO-": 48210 });
    expect(c.next("Q-")).toBe("Q-2841");
    expect(c.next("WO-")).toBe("WO-48211");
    expect(c.next("Q-")).toBe("Q-2842");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- invoice ar numbering`

- [ ] **Step 3: Implement the three modules**

`lib/logic/invoice.ts`:
```ts
import type { WorkOrder, Invoice } from "@/lib/domain";

export type NewInvoice = Omit<Invoice, "id" | "createdAt" | "updatedAt" | "version">;

export function toBillInvoiceFromOrder(order: WorkOrder, shippedDate: string): NewInvoice {
  return {
    number: null, customerId: order.customerId, workOrderId: order.id,
    amountCents: order.orderValueCents, status: "to_bill",
    shippedDate, invoicedDate: null, paidDate: null,
  };
}
export function billInvoice(inv: Invoice, number: string, invoicedDate: string): Invoice {
  return { ...inv, status: "sent", number, invoicedDate };
}
export function payInvoice(inv: Invoice, paidDate: string): Invoice {
  return { ...inv, status: "paid", paidDate };
}
```

`lib/logic/ar.ts`:
```ts
import type { Invoice } from "@/lib/domain";

export type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

const DAY = 86_400_000;

export function agingBucket(invoice: Invoice, asOf: string): Bucket {
  const ref = invoice.invoicedDate ?? invoice.shippedDate;
  const days = Math.floor((new Date(asOf).getTime() - new Date(ref).getTime()) / DAY);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function ageInvoices(invoices: Invoice[], asOf: string): Record<Bucket, number> {
  const totals: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const inv of invoices) {
    if (inv.status !== "sent") continue;
    totals[agingBucket(inv, asOf)] += inv.amountCents;
  }
  return totals;
}

export function customerBalanceCents(invoices: Invoice[], customerId: string): number {
  return invoices.filter((i) => i.customerId === customerId && i.status === "sent")
    .reduce((s, i) => s + i.amountCents, 0);
}
```

`lib/logic/numbering.ts`:
```ts
export function formatNumber(prefix: string, seq: number): string {
  return `${prefix}${seq}`;
}

export class Counter {
  private seqs: Record<string, number>;
  constructor(initial: Record<string, number> = {}) { this.seqs = { ...initial }; }
  next(prefix: string): string {
    const n = (this.seqs[prefix] ?? 0) + 1;
    this.seqs[prefix] = n;
    return formatNumber(prefix, n);
  }
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- invoice ar numbering`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: invoice lifecycle, AR aging, sequential numbering"
```

---

### Task 9: Repository interfaces

**Files:**
- Create: `lib/data/repositories/index.ts`

**Interfaces:**
- Produces: `Repositories` (a bag of per-entity repos). Each read repo has `list(): Promise<T[]>` and `get(id): Promise<T | null>`. Mutating repos add `create`, `update`, `save` as needed. Exact shape below — later tasks consume this verbatim.

- [ ] **Step 1: Create `lib/data/repositories/index.ts`**

```ts
import type {
  Customer, Contact, Part, ProcessMaster, Specification, PriceKey, PricingRule,
  Quote, WorkOrder, Certification, Invoice, Operator,
} from "@/lib/domain";

export interface ReadRepo<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
}

export interface WriteRepo<T extends { id: string }> extends ReadRepo<T> {
  create(input: Omit<T, "id" | "createdAt" | "updatedAt" | "version">): Promise<T>;
  update(id: string, patch: Partial<T>, expectedVersion: number): Promise<T>;
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
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` (expect no errors).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: repository interfaces"
```

---

### Task 10: Seed dataset (Heritage Heat Treat)

**Files:**
- Create: `lib/data/seed/index.ts`

**Interfaces:**
- Produces: `buildSeed(): { customers: Customer[]; contacts: Contact[]; parts: Part[]; processMasters: ProcessMaster[]; specifications: Specification[]; priceKeys: PriceKey[]; pricingRules: PricingRule[]; quotes: Quote[]; workOrders: WorkOrder[]; certifications: Certification[]; invoices: Invoice[]; operators: Operator[]; counters: Record<string, number> }`.

> Use the concrete values from the grounded reference §11 and §2. Provide the records below verbatim, then add the remaining list rows following the exact same object shape (values listed in the grounded reference) so every list/dashboard is populated. All `createdAt/updatedAt` use a fixed ISO timestamp; `version: 0`.

- [ ] **Step 1: Create `lib/data/seed/index.ts`** (core records; extend the arrays with the remaining reference rows)

```ts
import type {
  Customer, Contact, Part, ProcessMaster, Specification, PriceKey, PricingRule,
  Quote, WorkOrder, Certification, Invoice, Operator,
} from "@/lib/domain";

const T = "2026-06-01T00:00:00.000Z";
const meta = { createdAt: T, updatedAt: T, version: 0 };

export function buildSeed() {
  const operators: Operator[] = [
    { ...meta, id: "op-dana", name: "Dana Mercer", initials: "DM", title: "Plant Manager", role: "manager", quoteAuthLimitCents: 100_000_00 },
    { ...meta, id: "op-vance", name: "S. Vance", initials: "SV", title: "Estimator", role: "sales", quoteAuthLimitCents: 25_000_00 },
    { ...meta, id: "op-office", name: "R. Office", initials: "RO", title: "A/R Clerk", role: "office", quoteAuthLimitCents: 0 },
  ];

  const specifications: Specification[] = [
    { ...meta, id: "spec-ams2759-3", code: "AMS 2759/3", title: "Carburize & harden", rev: "K", owner: "SAE" },
    { ...meta, id: "spec-ams2759-2", code: "AMS 2759/2", title: "Low-alloy heat treat", rev: "M", owner: "SAE" },
    // + remaining specs from reference (AMS 2759/7, /10, MIL-S-6090, ...)
  ];

  const priceKeys: PriceKey[] = [
    { ...meta, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" },
  ];
  const pricingRules: PricingRule[] = [
    { ...meta, id: "pr-carb", priceKeyId: "pk-aero1", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
    { ...meta, id: "pr-temper", priceKeyId: "pk-aero1", process: "Temper", basis: "per_lot", rateCents: 144000, minChargeCents: null },
    { ...meta, id: "pr-cert", priceKeyId: "pk-aero1", process: "Certification", basis: "flat", rateCents: 80000, minChargeCents: null },
  ];

  const customers: Customer[] = [
    { ...meta, id: "cust-apex", customerNumber: "1042", name: "Apex Aerospace", initials: "AA",
      city: "Wichita, KS", billingAddress: "4120 Industrial Pkwy, Wichita, KS 67226", phone: "(316) 555-0142",
      terms: "Net 30", status: "active", priceKeyId: "pk-aero1", taxExempt: true,
      defaultCertSpecId: "spec-ams2759-3", defaultCertCopies: 2, ytdSalesCents: 214_000_00 },
    { ...meta, id: "cust-vulcan", customerNumber: "1051", name: "Vulcan Forge", initials: "VF",
      city: "", billingAddress: "", phone: "", terms: "Net 45", status: "hold", priceKeyId: null,
      taxExempt: false, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0 },
    // + Titan Fasteners, Delta Turbine, Midwest Gear & Axle, ... from reference
  ];

  const contacts: Contact[] = [
    { ...meta, id: "ct-sara", customerId: "cust-apex", name: "Sara Lin", role: "Buyer", email: "sara.lin@apexaero.com", phone: "(316) 555-0142" },
  ];

  const processMasters: ProcessMaster[] = [
    { ...meta, id: "pm-carb58", code: "PM-CARB-58", name: "Carburize & temper", description: "Case hardened, Rc 58-62",
      rev: "C", status: "active", surfaceHardness: "Rc 58-62", caseDepth: ".020-.030 in", hardnessScale: "Rockwell C",
      steps: [
        { n:1, op:"Receive & verify", equip:"Receiving", instr:"Count pieces, verify PO and part number, visual inspection for damage.", params:[], track:"track_in" },
        { n:2, op:"Wash & rack", equip:"Wash station", instr:"Degrease and load onto fixtures — 2 racks of 240.", params:[], track:"track_in_out" },
        { n:3, op:"Carburize", equip:"Batch IQ #3", instr:"", params:["1700°F","8.0 hr","0.90% C","Oil quench"], track:"track_in_out" },
        { n:4, op:"Temper", equip:"Temper Oven #4", instr:"", params:["350°F","2.0 hr"], track:"track_in_out" },
        { n:5, op:"Final inspect", equip:"Inspection", instr:"Hardness + case depth check.", params:[], track:"inspect" },
        { n:6, op:"Certify & ship", equip:"Shipping", instr:"", params:[], track:"track_out" },
      ] },
    // + PM-NIT-09, PM-VAC-44, PM-CN-21, PM-NH-15, PM-ANN-03 from reference
  ];

  const parts: Part[] = [
    { ...meta, id: "part-ts4471", partNumber: "TS-4471", description: "Turbine shaft", customerId: "cust-apex",
      material: "4140 steel", drawingRev: "C", hardness: "Rc 58-62", caseDepth: ".020-.030 in",
      specificationId: "spec-ams2759-3", processMasterId: "pm-carb58", priceKeyId: "pk-aero1",
      inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot" },
    { ...meta, id: "part-sp119", partNumber: "SP-119", description: "Spacer ring", customerId: "cust-apex",
      material: "8620 steel", drawingRev: "A", hardness: "Rc 58-62", caseDepth: ".010-.020 in",
      specificationId: "spec-ams2759-3", processMasterId: "pm-carb58", priceKeyId: "pk-aero1",
      inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot" },
    // + CS-88, BR-12, RG-440, ... from reference
  ];

  const quotes: Quote[] = [
    { ...meta, id: "q-2841", number: "Q-2841", rev: 0, customerId: "cust-apex", customerPO: "7741-A",
      status: "draft", salespersonId: "op-vance", date: "2026-06-30T00:00:00.000Z", validUntil: "2026-07-30T00:00:00.000Z",
      requiredBy: "2026-07-08T00:00:00.000Z", discount: null, estCostCents: 488360, notes: "", wonOrderId: null,
      parts: [{ id:"qp-1", partId:"part-ts4471", material:"4140 steel", quantity:480, lines:[
        { id:"ql-1", process:"Carburize", basis:"per_lb", qtyOrWeight:600, rateCents:1030, minChargeCents:25000 },
        { id:"ql-2", process:"Temper", basis:"per_lot", qtyOrWeight:1, rateCents:144000, minChargeCents:null },
        { id:"ql-3", process:"Certification", basis:"flat", qtyOrWeight:1, rateCents:80000, minChargeCents:null }]}] },
    // + additional quotes so the Quotes list shows ~12 (mix of draft/sent/won/lost) from reference
  ];

  const workOrders: WorkOrder[] = [
    { ...meta, id: "wo-48211", number: "WO-48211", customerId: "cust-apex", customerPO: "7741-A", quoteId: null,
      processSummary: "Carburize + Temper", processMasterId: "pm-carb58", status: "in_process",
      orderedDate: "2026-06-26T00:00:00.000Z", due: "2026-07-02T00:00:00.000Z", certifyRequired: true,
      certSpecId: "spec-ams2759-3", orderValueCents: 842000, progressPct: 68,
      lines: [
        { id:"ol-1", partId:"part-ts4471", description:"Turbine shaft, 4140 steel", quantity:480, spec:"Rc 58-62" },
        { id:"ol-2", partId:"part-sp119", description:"Spacer ring, 8620", quantity:120, spec:"Rc 58-62" }],
      pricing: [
        { process:"Carburize", detail:"600 lb", amountCents:618000 },
        { process:"Temper", detail:"", amountCents:144000 },
        { process:"Certification", detail:"", amountCents:80000 }],
      steps: [], activity: [{ at:"2026-06-26T00:00:00.000Z", actor:"System", message:"Order received" }] },
    // + WO-48205, WO-48190, ... so Orders list shows ~86 open (a representative subset is fine)
  ];

  const certifications: Certification[] = [
    { ...meta, id: "cert-9921", number: "C-9921", customerId: "cust-apex", workOrderId: "wo-48211",
      specificationId: "spec-ams2759-3", type: "Carburize", status: "pending", copies: 2 },
  ];

  const invoices: Invoice[] = [
    { ...meta, id: "inv-30408", number: "INV-30408", customerId: "cust-apex", workOrderId: "wo-48211",
      amountCents: 1120000, status: "sent", shippedDate: "2026-06-26T00:00:00.000Z",
      invoicedDate: "2026-06-26T00:00:00.000Z", paidDate: null },
    // + paid + to_bill invoices so Invoicing tabs + A/R aging populate from reference
  ];

  const counters: Record<string, number> = { "Q-": 2841, "WO-": 48211, "INV-": 30412, "C-": 9921 };

  return { operators, specifications, priceKeys, pricingRules, customers, contacts, processMasters, parts, quotes, workOrders, certifications, invoices, counters };
}
```

- [ ] **Step 2: Add a seed sanity test** — `lib/data/seed/seed.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { quoteSchema, customerSchema, workOrderSchema } from "@/lib/domain";

describe("seed", () => {
  const s = buildSeed();
  it("validates against schemas", () => {
    s.quotes.forEach((q) => expect(() => quoteSchema.parse(q)).not.toThrow());
    s.customers.forEach((c) => expect(() => customerSchema.parse(c)).not.toThrow());
    s.workOrders.forEach((w) => expect(() => workOrderSchema.parse(w)).not.toThrow());
  });
  it("has the Apex multi-part order", () => {
    expect(s.workOrders.find((w) => w.number === "WO-48211")?.lines.length).toBe(2);
  });
});
```

- [ ] **Step 3: Run — expect PASS.** `npm run test -- seed`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Heritage Heat Treat seed dataset"
```

---

### Task 11: Mock store, repositories, and provider

**Files:**
- Create: `lib/data/mock/store.ts`, `lib/data/mock/repositories.ts`, `lib/data/provider.tsx`
- Create: `lib/data/mock/repositories.test.ts`

**Interfaces:**
- Produces: `createMockRepositories(opts?: { latencyMs?: number; failRate?: number }): Repositories`; `RepositoriesProvider` (React context); `useRepositories(): Repositories`.
- Consumes: `Repositories` (Task 9), `buildSeed` (Task 10), `Counter` (Task 8).

- [ ] **Step 1: Write the failing test** — `lib/data/mock/repositories.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { createMockRepositories } from "@/lib/data/mock/repositories";

describe("mock repositories", () => {
  it("lists seeded customers", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const customers = await repos.customers.list();
    expect(customers.find((c) => c.name === "Apex Aerospace")).toBeTruthy();
  });
  it("creates a quote with a generated id + bumped number", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const q = await repos.quotes.create({
      number: "", rev: 0, customerId: "cust-apex", customerPO: "", status: "draft",
      salespersonId: "op-vance", date: "2026-06-30T00:00:00.000Z", validUntil: "2026-07-30T00:00:00.000Z",
      requiredBy: null, discount: null, estCostCents: 0, notes: "", wonOrderId: null, parts: [],
    });
    expect(q.id).toBeTruthy();
    expect(q.version).toBe(0);
  });
  it("enforces optimistic concurrency on update", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const [q] = await repos.quotes.list();
    await expect(repos.quotes.update(q.id, { notes: "x" }, q.version + 5)).rejects.toThrow();
    const ok = await repos.quotes.update(q.id, { notes: "x" }, q.version);
    expect(ok.version).toBe(q.version + 1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- mock`

- [ ] **Step 3: Implement `lib/data/mock/store.ts`**

```ts
export class Collection<T extends { id: string; version: number; createdAt: string; updatedAt: string }> {
  private items: Map<string, T>;
  constructor(seed: T[]) { this.items = new Map(seed.map((i) => [i.id, i])); }
  all(): T[] { return [...this.items.values()]; }
  byId(id: string): T | null { return this.items.get(id) ?? null; }
  insert(item: T): T { this.items.set(item.id, item); return item; }
  replace(item: T): T { this.items.set(item.id, item); return item; }
}

let counter = 0;
export function genId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}

export const NOW = "2026-06-30T12:00:00.000Z"; // fixed mock clock (no Date.now in deterministic tests)
export async function delay(ms: number, failRate = 0): Promise<void> {
  if (failRate > 0 && hashFail(counter, failRate)) throw new Error("Simulated network error");
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
function hashFail(seed: number, rate: number): boolean {
  return (seed % 100) / 100 < rate;
}
```

- [ ] **Step 4: Implement `lib/data/mock/repositories.ts`**

```ts
import type { Repositories, ReadRepo, WriteRepo } from "@/lib/data/repositories";
import { buildSeed } from "@/lib/data/seed";
import { Counter } from "@/lib/logic/numbering";
import { Collection, genId, NOW, delay } from "./store";

type Opts = { latencyMs?: number; failRate?: number };

export function createMockRepositories(opts: Opts = {}): Repositories {
  const latency = opts.latencyMs ?? 250;
  const fail = opts.failRate ?? 0;
  const seed = buildSeed();
  const counter = new Counter(seed.counters);

  const numberPrefix: Record<string, string> = { quotes: "Q-", workOrders: "WO-", invoices: "INV-", certifications: "C-" };

  function read<T extends { id: string }>(col: Collection<any>): ReadRepo<T> {
    return {
      async list() { await delay(latency, fail); return col.all() as T[]; },
      async get(id) { await delay(latency, fail); return col.byId(id) as T | null; },
    };
  }
  function write<T extends { id: string; version: number; createdAt: string; updatedAt: string; number?: string | null }>(
    col: Collection<any>, key?: keyof typeof numberPrefix & string,
  ): WriteRepo<T> {
    return {
      ...read<T>(col),
      async create(input) {
        await delay(latency, fail);
        const id = genId(key ?? "id");
        const numbered = key && numberPrefix[key] ? { number: counter.next(numberPrefix[key]) } : {};
        const item = { ...(input as object), ...numbered, id, createdAt: NOW, updatedAt: NOW, version: 0 } as T;
        return col.insert(item);
      },
      async update(id, patch, expectedVersion) {
        await delay(latency, fail);
        const cur = col.byId(id);
        if (!cur) throw new Error("Not found: " + id);
        if (cur.version !== expectedVersion) throw new Error("Version conflict");
        const next = { ...cur, ...patch, version: cur.version + 1, updatedAt: NOW } as T;
        return col.replace(next);
      },
    };
  }

  const cols = {
    customers: new Collection(seed.customers),
    contacts: new Collection(seed.contacts),
    parts: new Collection(seed.parts),
    processMasters: new Collection(seed.processMasters),
    specifications: new Collection(seed.specifications),
    priceKeys: new Collection(seed.priceKeys),
    pricingRules: new Collection(seed.pricingRules),
    quotes: new Collection(seed.quotes),
    workOrders: new Collection(seed.workOrders),
    certifications: new Collection(seed.certifications),
    invoices: new Collection(seed.invoices),
    operators: new Collection(seed.operators),
  };

  return {
    customers: { ...read(cols.customers), async byId(ids) { await delay(latency, fail); return cols.customers.all().filter((c) => ids.includes(c.id)); } },
    contacts: { ...read(cols.contacts), async byCustomer(cid) { await delay(latency, fail); return cols.contacts.all().filter((c) => c.customerId === cid); } },
    parts: { ...write(cols.parts), async byCustomer(cid) { await delay(latency, fail); return cols.parts.all().filter((p) => p.customerId === cid); } },
    processMasters: read(cols.processMasters),
    specifications: read(cols.specifications),
    priceKeys: read(cols.priceKeys),
    pricingRules: { ...read(cols.pricingRules), async byPriceKey(pk) { await delay(latency, fail); return cols.pricingRules.all().filter((r) => r.priceKeyId === pk); } },
    quotes: write(cols.quotes, "quotes"),
    workOrders: write(cols.workOrders, "workOrders"),
    certifications: { ...write(cols.certifications, "certifications"), async byWorkOrder(woId) { await delay(latency, fail); return cols.certifications.all().find((c) => c.workOrderId === woId) ?? null; } },
    invoices: write(cols.invoices, "invoices"),
    operators: read(cols.operators),
  } as Repositories;
}
```

- [ ] **Step 5: Implement `lib/data/provider.tsx`**

```tsx
"use client";
import { createContext, useContext, useMemo } from "react";
import type { Repositories } from "@/lib/data/repositories";
import { createMockRepositories } from "@/lib/data/mock/repositories";

const Ctx = createContext<Repositories | null>(null);

export function RepositoriesProvider({ children }: { children: React.ReactNode }) {
  const repos = useMemo(() => createMockRepositories(), []);
  return <Ctx.Provider value={repos}>{children}</Ctx.Provider>;
}

export function useRepositories(): Repositories {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRepositories must be used within RepositoriesProvider");
  return r;
}
```

- [ ] **Step 6: Run — expect PASS.** `npm run test -- mock`

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: mock store, repositories, optimistic concurrency, provider"
```

---

### Task 12: TanStack Query setup + entity hooks

**Files:**
- Create: `lib/query/keys.ts`, `lib/query/provider.tsx`, `lib/query/hooks.ts`

**Interfaces:**
- Produces: `QueryProvider`; `queryKeys`; hooks `useCustomers`, `useCustomer(id)`, `useParts`, `usePart(id)`, `useProcessMasters`, `useSpecifications`, `useQuotes`, `useQuote(id)`, `useWorkOrders`, `useWorkOrder(id)`, `useInvoices`, `useCertifications`, `useOperators`.
- Consumes: `useRepositories` (Task 11).

- [ ] **Step 1: Create `lib/query/keys.ts`**

```ts
export const queryKeys = {
  customers: ["customers"] as const,
  customer: (id: string) => ["customers", id] as const,
  parts: ["parts"] as const,
  part: (id: string) => ["parts", id] as const,
  processMasters: ["processMasters"] as const,
  specifications: ["specifications"] as const,
  quotes: ["quotes"] as const,
  quote: (id: string) => ["quotes", id] as const,
  workOrders: ["workOrders"] as const,
  workOrder: (id: string) => ["workOrders", id] as const,
  invoices: ["invoices"] as const,
  certifications: ["certifications"] as const,
  operators: ["operators"] as const,
};
```

- [ ] **Step 2: Create `lib/query/provider.tsx`**

```tsx
"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 3: Create `lib/query/hooks.ts`**

```ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { useRepositories } from "@/lib/data/provider";
import { queryKeys } from "./keys";

export function useCustomers() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.customers, queryFn: () => r.customers.list() }); }
export function useCustomer(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.customer(id), queryFn: () => r.customers.get(id) }); }
export function useParts() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.parts, queryFn: () => r.parts.list() }); }
export function usePart(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.part(id), queryFn: () => r.parts.get(id) }); }
export function useProcessMasters() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.processMasters, queryFn: () => r.processMasters.list() }); }
export function useSpecifications() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.specifications, queryFn: () => r.specifications.list() }); }
export function useQuotes() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.quotes, queryFn: () => r.quotes.list() }); }
export function useQuote(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.quote(id), queryFn: () => r.quotes.get(id) }); }
export function useWorkOrders() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.workOrders, queryFn: () => r.workOrders.list() }); }
export function useWorkOrder(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.workOrder(id), queryFn: () => r.workOrders.get(id) }); }
export function useInvoices() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.invoices, queryFn: () => r.invoices.list() }); }
export function useCertifications() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.certifications, queryFn: () => r.certifications.list() }); }
export function useOperators() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.operators, queryFn: () => r.operators.list() }); }
```

- [ ] **Step 4: Typecheck** — `npx tsc --noEmit` (expect no errors).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: TanStack Query provider, keys, entity hooks"
```

---

### Task 13: Mocked auth — session, roles, permissions

**Files:**
- Create: `lib/auth/types.ts`, `lib/auth/provider.tsx`, `lib/auth/permissions.ts`
- Create: `lib/auth/permissions.test.ts`

**Interfaces:**
- Produces:
  - `permissions.ts`: `type Permission = "approve_over_limit" | "apply_discount" | "release_cert" | "close_period" | "edit_setup"`; `can(role: RoleKey, perm: Permission): boolean`.
  - `provider.tsx`: `AuthProvider`; `useAuth(): { operator: Operator; viewAs: RoleKey; setViewAs(r): void; login(id): void; logout(): void }`; `useCan(perm): boolean` (uses `viewAs`).

- [ ] **Step 1: Write the failing test** — `lib/auth/permissions.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { can } from "@/lib/auth/permissions";

describe("permissions", () => {
  it("only managers approve over limit + close periods", () => {
    expect(can("manager","approve_over_limit")).toBe(true);
    expect(can("sales","approve_over_limit")).toBe(false);
    expect(can("manager","close_period")).toBe(true);
    expect(can("office","close_period")).toBe(true);
  });
  it("sales + managers apply discounts", () => {
    expect(can("sales","apply_discount")).toBe(true);
    expect(can("office","apply_discount")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- permissions`

- [ ] **Step 3: Implement `lib/auth/permissions.ts`**

```ts
import type { RoleKey } from "@/lib/domain";

export type Permission = "approve_over_limit" | "apply_discount" | "release_cert" | "close_period" | "edit_setup";

const MATRIX: Record<Permission, RoleKey[]> = {
  approve_over_limit: ["manager"],
  apply_discount: ["manager", "sales"],
  release_cert: ["manager"],
  close_period: ["manager", "office"],
  edit_setup: ["manager"],
};

export function can(role: RoleKey, perm: Permission): boolean {
  return MATRIX[perm].includes(role);
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- permissions`

- [ ] **Step 5: Create `lib/auth/types.ts`**

```ts
import type { Operator, RoleKey } from "@/lib/domain";
export type AuthState = { operator: Operator; viewAs: RoleKey };
```

- [ ] **Step 6: Implement `lib/auth/provider.tsx`**

```tsx
"use client";
import { createContext, useContext, useState, useEffect } from "react";
import type { Operator, RoleKey } from "@/lib/domain";
import { useRepositories } from "@/lib/data/provider";
import { can, type Permission } from "./permissions";

type AuthCtx = {
  operator: Operator | null;
  viewAs: RoleKey;
  setViewAs: (r: RoleKey) => void;
  login: (operatorId: string) => Promise<void>;
  logout: () => void;
};
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const repos = useRepositories();
  const [operator, setOperator] = useState<Operator | null>(null);
  const [viewAs, setViewAs] = useState<RoleKey>("manager");

  // auto-login the demo manager on mount (mocked auth)
  useEffect(() => { void login("op-dana"); /* eslint-disable-next-line */ }, []);

  async function login(operatorId: string) {
    const op = await repos.operators.get(operatorId);
    if (op) { setOperator(op); setViewAs(op.role); }
  }
  function logout() { setOperator(null); }

  return <Ctx.Provider value={{ operator, viewAs, setViewAs, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}
export function useCan(perm: Permission): boolean {
  const { viewAs } = useAuth();
  return can(viewAs, perm);
}
```

- [ ] **Step 7: Wire all providers in `app/layout.tsx`** (nest: Query → Repositories → Auth)

```tsx
// inside <body>:
import { QueryProvider } from "@/lib/query/provider";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
// ...
<body>
  <QueryProvider>
    <RepositoriesProvider>
      <AuthProvider>{children}</AuthProvider>
    </RepositoriesProvider>
  </QueryProvider>
</body>
```

- [ ] **Step 8: Create the login page** — `app/(auth)/login/page.tsx`

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/provider";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { Label } from "@/lib/ui/label";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [id, setId] = useState("op-dana");
  return (
    <div className="grid min-h-screen place-items-center bg-canvas">
      <form className="w-80 space-y-4 rounded-card border border-border bg-surface p-6"
        onSubmit={async (e) => { e.preventDefault(); await login(id); router.push("/today"); }}>
        <div className="font-mono text-primary text-lg font-semibold">HeatSynQ</div>
        <div className="space-y-1">
          <Label htmlFor="op">Operator</Label>
          <Input id="op" value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <Button type="submit" className="w-full">Sign in</Button>
        <p className="text-text-muted text-xs">Demo: op-dana (manager), op-vance (sales), op-office (office)</p>
      </form>
    </div>
  );
}
```

- [ ] **Step 9: Manual check** — `npm run dev`, visit `/login`, sign in → routes to `/today` (which 404s until Task 16; that's fine). Stop server.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: mocked auth provider, permission matrix, login page"
```

---

### Task 14: Pattern components — display set

**Files:**
- Create: `components/patterns/status-pill.tsx`, `mono-id.tsx`, `kpi-tile.tsx`, `empty-state.tsx`, `error-panel.tsx`, `skeleton-rows.tsx`, `index.ts`
- Create: `components/patterns/status-pill.test.tsx`, `kpi-tile.test.tsx`

**Interfaces:**
- Produces:
  - `<StatusPill tone={StatusTone}>{label}</StatusPill>`
  - `<MonoId>{string}</MonoId>` (mono, primary-ish)
  - `<KpiTile label value sub? delta? tone? />`
  - `<EmptyState title description? action? />`
  - `<ErrorPanel message onRetry />`
  - `<SkeletonRows count? />`
- Consumes: `toneClasses` (Task 2), `cn` (Task 1).

- [ ] **Step 1: Write failing tests** — `components/patterns/status-pill.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
  it("renders label with tone classes", () => {
    render(<StatusPill tone="success">Won</StatusPill>);
    const el = screen.getByText("Won");
    expect(el.className).toContain("text-status-success");
    expect(el.className).toContain("bg-status-success-tint");
  });
});
```

`components/patterns/kpi-tile.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiTile } from "./kpi-tile";

describe("KpiTile", () => {
  it("renders label, value, and sub", () => {
    render(<KpiTile label="Open Orders" value="86" sub="4 today" />);
    expect(screen.getByText("Open Orders")).toBeInTheDocument();
    expect(screen.getByText("86")).toBeInTheDocument();
    expect(screen.getByText("4 today")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- patterns`

- [ ] **Step 3: Implement the components**

`status-pill.tsx`:
```tsx
import { cn } from "@/lib/utils";
import { toneClasses, type StatusTone } from "@/lib/domain/enums";

export function StatusPill({ tone, children, className }: { tone: StatusTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-pill px-2.5 py-0.5 font-mono text-[11px]", toneClasses(tone), className)}>
      {children}
    </span>
  );
}
```

`mono-id.tsx`:
```tsx
import { cn } from "@/lib/utils";
export function MonoId({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-text", className)}>{children}</span>;
}
```

`kpi-tile.tsx`:
```tsx
import { cn } from "@/lib/utils";
import type { StatusTone } from "@/lib/domain/enums";

export function KpiTile({ label, value, sub, delta, tone }: {
  label: string; value: string; sub?: string; delta?: string; tone?: StatusTone;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="text-text-muted text-[11px]">{label}</div>
      <div className={cn("mt-1 font-mono text-[26px] font-semibold", tone === "danger" && "text-status-danger")}>{value}</div>
      {delta && <div className="text-status-success text-[11px]">{delta}</div>}
      {sub && <div className="text-text-muted text-[11px]">{sub}</div>}
    </div>
  );
}
```

`empty-state.tsx`:
```tsx
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-card border border-border bg-surface py-16 text-center">
      <div className="max-w-[240px]">
        <div className="font-semibold">{title}</div>
        {description && <p className="mt-1 text-text-muted text-xs">{description}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
```

`error-panel.tsx`:
```tsx
import { Button } from "@/lib/ui/button";
export function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-status-danger-tint bg-surface p-6 text-center">
      <div className="text-status-danger font-semibold">Something went wrong</div>
      <p className="mt-1 text-text-muted text-xs">{message}</p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>Retry</Button>
    </div>
  );
}
```

`skeleton-rows.tsx`:
```tsx
import { Skeleton } from "@/lib/ui/skeleton";
export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-2 rounded-card border border-border bg-surface p-4">
      {Array.from({ length: count }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}
```

`index.ts`:
```ts
export * from "./status-pill";
export * from "./mono-id";
export * from "./kpi-tile";
export * from "./empty-state";
export * from "./error-panel";
export * from "./skeleton-rows";
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- patterns`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: display pattern components (StatusPill, KpiTile, EmptyState, ErrorPanel, ...)"
```

---

### Task 15: Pattern components — layout + form set

**Files:**
- Create: `components/patterns/page-header.tsx`, `list-card.tsx`, `detail-header.tsx`, `summary-rail.tsx`, `form-field.tsx`, `error-summary.tsx`, `confirm-dialog.tsx`
- Modify: `components/patterns/index.ts` (export new ones)
- Create: `components/patterns/list-card.test.tsx`

**Interfaces:**
- Produces:
  - `<PageHeader title subtitle? action? onFilter? />`
  - `<ListCard headers={string[]} rows={ReactNode[][]} onRowClick?(index) />`
  - `<DetailHeader backHref backLabel title statusPill? actions? subtitle? />`
  - `<SummaryRail title children />`
  - `<FormField label htmlFor error? children />`
  - `<ErrorSummary errors={string[]} />`
  - `<ConfirmDialog open onOpenChange title description confirmLabel onConfirm />`

- [ ] **Step 1: Write the failing test** — `components/patterns/list-card.test.tsx`

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListCard } from "./list-card";

describe("ListCard", () => {
  it("renders headers and rows and fires row click", async () => {
    const onRowClick = vi.fn();
    render(<ListCard headers={["A","B"]} rows={[["1","2"],["3","4"]]} onRowClick={onRowClick} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    await userEvent.click(screen.getByText("3"));
    expect(onRowClick).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- list-card`

- [ ] **Step 3: Implement the components**

`page-header.tsx`:
```tsx
import { Button } from "@/lib/ui/button";
import { Filter } from "lucide-react";
export function PageHeader({ title, subtitle, action, onFilter }: {
  title: string; subtitle?: string; action?: React.ReactNode; onFilter?: () => void;
}) {
  return (
    <div className="mb-5 flex items-start justify-between">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="text-text-muted text-xs">{subtitle}</p>}
      </div>
      <div className="flex gap-2">
        {onFilter && <Button variant="outline" onClick={onFilter}><Filter className="mr-1 size-4" />Filter</Button>}
        {action}
      </div>
    </div>
  );
}
```

`list-card.tsx`:
```tsx
import { cn } from "@/lib/utils";
export function ListCard({ headers, rows, onRowClick }: {
  headers: string[]; rows: React.ReactNode[][]; onRowClick?: (index: number) => void;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-border">
            {headers.map((h) => <th key={h} className="px-4 py-3 font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} onClick={() => onRowClick?.(i)}
              className={cn("border-b border-border-faint last:border-0", onRowClick && "cursor-pointer hover:bg-canvas")}>
              {row.map((cell, j) => <td key={j} className="px-4 py-3 align-top">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`detail-header.tsx`:
```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
export function DetailHeader({ backHref, backLabel, title, subtitle, statusPill, actions }: {
  backHref: string; backLabel: string; title: React.ReactNode; subtitle?: string;
  statusPill?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <Link href={backHref} className="text-primary text-xs"> <ArrowLeft className="inline size-3" /> {backLabel}</Link>
      <div className="mt-2 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
          {statusPill}
        </div>
        <div className="flex gap-2">{actions}</div>
      </div>
      {subtitle && <p className="text-text-muted text-xs">{subtitle}</p>}
    </div>
  );
}
```

`summary-rail.tsx`:
```tsx
export function SummaryRail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="rounded-card border border-border bg-surface p-4">
      <div className="mb-3 font-semibold">{title}</div>
      {children}
    </aside>
  );
}
```

`form-field.tsx`:
```tsx
import { Label } from "@/lib/ui/label";
export function FormField({ label, htmlFor, error, children }: {
  label: string; htmlFor: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-status-danger text-xs">{error}</p>}
    </div>
  );
}
```

`error-summary.tsx`:
```tsx
export function ErrorSummary({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="rounded-card border border-status-danger-tint bg-status-danger-tint/40 p-3">
      <div className="text-status-danger text-xs font-semibold">Please fix {errors.length} issue(s):</div>
      <ul className="mt-1 list-disc pl-5 text-status-danger text-xs">
        {errors.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    </div>
  );
}
```

`confirm-dialog.tsx`:
```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string;
  confirmLabel: string; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onConfirm(); onOpenChange(false); }}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Append to `components/patterns/index.ts`:
```ts
export * from "./page-header";
export * from "./list-card";
export * from "./detail-header";
export * from "./summary-rail";
export * from "./form-field";
export * from "./error-summary";
export * from "./confirm-dialog";
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- list-card`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: layout + form pattern components (PageHeader, ListCard, DetailHeader, ...)"
```

---

### Task 16: App shell — nav config, Sidebar, Topbar, layout

**Files:**
- Create: `components/shell/nav-config.ts`, `components/shell/sidebar.tsx`, `components/shell/topbar.tsx`, `components/shell/app-shell.tsx`
- Create: `app/(app)/layout.tsx`, `app/(app)/today/page.tsx` (temporary placeholder)
- Create: `components/shell/nav-config.test.ts`

**Interfaces:**
- Produces:
  - `nav-config.ts`: `NAV_GROUPS: { label: string | null; items: { label: string; href: string; key: string }[] }[]`; `isItemActive(itemHref: string, pathname: string): boolean` (parent stays active on detail routes).
  - `<AppShell>` wrapping `<Sidebar/> + <Topbar/> + content`.
  - `<Topbar onOpenPalette={() => void} />`.

- [ ] **Step 1: Write the failing test** — `components/shell/nav-config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { isItemActive, NAV_GROUPS } from "./nav-config";

describe("nav", () => {
  it("keeps the parent active on detail routes", () => {
    expect(isItemActive("/orders", "/orders")).toBe(true);
    expect(isItemActive("/orders", "/orders/wo-48211")).toBe(true);
    expect(isItemActive("/orders", "/quotes")).toBe(false);
  });
  it("does not match the today root against everything", () => {
    expect(isItemActive("/today", "/orders")).toBe(false);
  });
  it("exposes the documented groups", () => {
    const labels = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label));
    ["Quotes","Customers","Part Maintenance","Orders","Invoicing","A/R","Patterns","Setup"].forEach((l) =>
      expect(labels).toContain(l));
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- nav-config`

- [ ] **Step 3: Implement `components/shell/nav-config.ts`**

```ts
export type NavItem = { label: string; href: string; key: string };
export type NavGroup = { label: string | null; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [{ label: "Today", href: "/today", key: "today" }] },
  { label: "SALES", items: [
    { label: "Quotes", href: "/quotes", key: "quotes" },
    { label: "Customers", href: "/customers", key: "customers" },
    { label: "Part Maintenance", href: "/parts", key: "parts" },
  ]},
  { label: "PRODUCTION", items: [
    { label: "Orders", href: "/orders", key: "orders" },
    { label: "Process Master", href: "/process-masters", key: "process-masters" },
    { label: "Schedule", href: "/schedule", key: "schedule" },
    { label: "Tracking", href: "/tracking", key: "tracking" },
    { label: "Shop Floor", href: "/shop-floor", key: "shop-floor" },
  ]},
  { label: "QUALITY", items: [
    { label: "Certifications", href: "/certifications", key: "certifications" },
    { label: "Specifications", href: "/specifications", key: "specifications" },
    { label: "Standards", href: "/standards", key: "standards" },
  ]},
  { label: "FINANCE", items: [
    { label: "Invoicing", href: "/invoicing", key: "invoicing" },
    { label: "A/R", href: "/ar", key: "ar" },
    { label: "Reports", href: "/reports", key: "reports" },
  ]},
  { label: null, items: [
    { label: "Patterns", href: "/patterns", key: "patterns" },
    { label: "Setup", href: "/setup", key: "setup" },
  ]},
];

export function isItemActive(itemHref: string, pathname: string): boolean {
  if (itemHref === "/today") return pathname === "/today";
  return pathname === itemHref || pathname.startsWith(itemHref + "/");
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- nav-config`

- [ ] **Step 5: Implement `components/shell/sidebar.tsx`**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, isItemActive } from "./nav-config";

export function Sidebar({ badges = {} }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <aside className="flex w-[252px] shrink-0 flex-col border-r border-border bg-surface-sidebar">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="grid size-8 place-items-center rounded-lg bg-primary font-mono text-surface">H</div>
        <div><div className="font-semibold leading-tight">HeatSynQ</div><div className="text-text-muted text-[11px]">Heritage Heat Treat</div></div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((g, gi) => (
          <div key={gi} className="mb-3">
            {g.label && <div className="px-2 py-1 font-mono text-[10.5px] uppercase tracking-[.1em] text-text-faint">{g.label}</div>}
            {g.items.map((it) => {
              const active = isItemActive(it.href, pathname);
              return (
                <Link key={it.key} href={it.href}
                  className={cn("flex items-center justify-between rounded-[9px] px-2 py-1.5 text-[13px]",
                    active ? "bg-primary-tint text-primary font-medium" : "text-text-nav-idle hover:bg-canvas")}>
                  <span>{it.label}</span>
                  {badges[it.key] != null && <span className="font-mono text-[11px] text-text-muted">{badges[it.key]}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 6: Implement `components/shell/topbar.tsx`**

```tsx
"use client";
import { Search } from "lucide-react";
import { useAuth } from "@/lib/auth/provider";

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { operator } = useAuth();
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
      <button onClick={onOpenPalette}
        className="flex w-[420px] max-w-full items-center gap-2 rounded-[10px] bg-surface-subtle px-3 py-2 text-text-muted text-[13px]">
        <Search className="size-4" />
        <span>Search work orders, customers, parts…</span>
        <kbd className="ml-auto rounded-[5px] border border-border-alt bg-surface-subtle px-1.5 font-mono text-[11px]">⌘K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-3 text-text-muted text-[13px]">
        <span className="font-mono">{new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"}).format(new Date())}</span>
        <div className="grid size-8 place-items-center rounded-full bg-primary-tint font-mono text-primary text-xs">{operator?.initials ?? "—"}</div>
      </div>
    </header>
  );
}
```

- [ ] **Step 7: Implement `components/shell/app-shell.tsx`** (palette wired in Task 17 — leave a no-op for now)

```tsx
"use client";
import { useState } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children, badges }: { children: React.ReactNode; badges?: Record<string, number> }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar badges={badges} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-[1060px]">{children}</div>
        </main>
      </div>
      {/* CommandPalette mounted here in Task 17 using paletteOpen/setPaletteOpen */}
    </div>
  );
}
```

- [ ] **Step 8: Create `app/(app)/layout.tsx`**

```tsx
import { AppShell } from "@/components/shell/app-shell";
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
```

- [ ] **Step 9: Create `app/(app)/today/page.tsx`** (temporary)

```tsx
export default function TodayPage() {
  return <div className="text-text-muted">Today dashboard — built in Plan 2.</div>;
}
```

- [ ] **Step 10: Make `/` redirect to `/today`** — replace `app/page.tsx`

```tsx
import { redirect } from "next/navigation";
export default function Home() { redirect("/today"); }
```

- [ ] **Step 11: Manual check** — `npm run dev`, visit `/today`: sidebar + topbar render, Orders nav active on `/today`? (no). Click around; detail routes keep parent active will be verified in Plan 2. Stop server.

- [ ] **Step 12: Commit**

```bash
git add -A && git commit -m "feat: app shell (nav config, sidebar, topbar, layout)"
```

---

### Task 17: Command palette + `/patterns` page

**Files:**
- Create: `components/shell/command-palette.tsx`
- Modify: `components/shell/app-shell.tsx` (mount palette + ⌘K handler)
- Create: `app/(app)/patterns/page.tsx`
- Create: `components/shell/command-palette.test.tsx`

**Interfaces:**
- Produces: `<CommandPalette open onOpenChange />` (cmdk), grouped Go-to (from `NAV_GROUPS`) + Create actions; fuzzy filter; Esc closes; empty state.
- Consumes: `NAV_GROUPS` (Task 16), pattern components (Tasks 14–15).

- [ ] **Step 1: Write the failing test** — `components/shell/command-palette.test.tsx`

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./command-palette";

// next/navigation router mock
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("CommandPalette", () => {
  it("filters destinations by query and shows empty state", async () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText("Orders")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/search/i), "zzzzz");
    expect(screen.getByText(/no results/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npm run test -- command-palette`

- [ ] **Step 3: Implement `components/shell/command-palette.tsx`**

```tsx
"use client";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { NAV_GROUPS } from "./nav-config";

const CREATE = [
  { label: "New quote", href: "/quotes/new" },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  function go(href: string) { onOpenChange(false); router.push(href); }
  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette"
      className="fixed left-1/2 top-24 z-50 w-[560px] max-w-[90vw] -translate-x-1/2 rounded-modal border border-border bg-surface shadow-2xl">
      <Command.Input placeholder="Search destinations and actions…" autoFocus
        className="w-full border-b border-border px-4 py-3 text-[13px] outline-none" />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-text-muted text-xs">No results found.</Command.Empty>
        <Command.Group heading="Create" className="font-mono text-[10.5px] uppercase tracking-[.1em] text-text-faint">
          {CREATE.map((c) => (
            <Command.Item key={c.href} onSelect={() => go(c.href)}
              className="cursor-pointer rounded-[9px] px-3 py-2 text-[13px] text-text aria-selected:bg-primary-tint aria-selected:text-primary">
              {c.label}
            </Command.Item>
          ))}
        </Command.Group>
        {NAV_GROUPS.map((g, gi) => (
          <Command.Group key={gi} heading={g.label ?? "Go to"} className="font-mono text-[10.5px] uppercase tracking-[.1em] text-text-faint">
            {g.items.map((it) => (
              <Command.Item key={it.key} onSelect={() => go(it.href)}
                className="cursor-pointer rounded-[9px] px-3 py-2 text-[13px] text-text aria-selected:bg-primary-tint aria-selected:text-primary">
                {it.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
```

- [ ] **Step 4: Run — expect PASS.** `npm run test -- command-palette`

- [ ] **Step 5: Wire palette + ⌘K into `components/shell/app-shell.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { CommandPalette } from "./command-palette";

export function AppShell({ children, badges }: { children: React.ReactNode; badges?: Record<string, number> }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar badges={badges} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-[1060px]">{children}</div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
```

- [ ] **Step 6: Build the `/patterns` catalog** — `app/(app)/patterns/page.tsx`

```tsx
"use client";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { StatusPill, KpiTile, EmptyState, ErrorPanel, SkeletonRows, PageHeader, ListCard, FormField, MonoId } from "@/components/patterns";
import { quoteStatusMeta, orderStatusMeta, invoiceStatusMeta } from "@/lib/domain/enums";

export default function PatternsPage() {
  const allStatuses = [
    ...Object.values(quoteStatusMeta), ...Object.values(orderStatusMeta), ...Object.values(invoiceStatusMeta),
  ];
  return (
    <div className="space-y-8">
      <PageHeader title="Design patterns" subtitle="Reference states for the build — buttons, status, forms, empty, loading, error." />

      <section className="space-y-2">
        <h2 className="font-semibold">Buttons</h2>
        <div className="flex flex-wrap gap-2 rounded-card border border-border bg-surface p-4">
          <Button>Primary</Button>
          <Button variant="outline">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Status vocabulary</h2>
        <div className="flex flex-wrap gap-2 rounded-card border border-border bg-surface p-4">
          {allStatuses.map((s) => <StatusPill key={s.label} tone={s.tone}>{s.label}</StatusPill>)}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">KPI tiles</h2>
        <div className="grid grid-cols-3 gap-3">
          <KpiTile label="Open Orders" value="86" sub="4 today" />
          <KpiTile label="On-Time %" value="94.2" delta="▲ 1.1 pts" />
          <KpiTile label="Late Orders" value="5" sub="2 ship today" tone="danger" />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Identifiers</h2>
        <div className="rounded-card border border-border bg-surface p-4"><MonoId>WO-48211</MonoId></div>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-2"><h2 className="font-semibold">Form field</h2>
          <div className="rounded-card border border-border bg-surface p-4">
            <FormField label="Part number" htmlFor="pn" error="Required"><Input id="pn" /></FormField>
          </div>
        </div>
        <div className="space-y-2"><h2 className="font-semibold">List</h2>
          <ListCard headers={["WORK ORDER","STATUS"]} rows={[[<MonoId key="a">WO-48211</MonoId>, <StatusPill key="b" tone="info">In Process</StatusPill>]]} />
        </div>
      </section>

      <section className="grid grid-cols-3 gap-4">
        <div className="space-y-2"><h2 className="font-semibold">Empty</h2><EmptyState title="No quotes yet" description="Create your first quote." action={<Button>New quote</Button>} /></div>
        <div className="space-y-2"><h2 className="font-semibold">Loading</h2><SkeletonRows count={4} /></div>
        <div className="space-y-2"><h2 className="font-semibold">Error</h2><ErrorPanel message="Failed to load." onRetry={() => {}} /></div>
      </section>
    </div>
  );
}
```

- [ ] **Step 7: Manual check** — `npm run dev`, visit `/patterns` (renders the catalog), press ⌘K (palette opens, Esc closes, typing filters). Stop server.

- [ ] **Step 8: Run full test suite + typecheck**

Run: `npm run test` (all green) and `npx tsc --noEmit` (no errors).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: command palette (⌘K) + live /patterns design-system page"
```

---

## Self-Review (completed during authoring)

**Spec coverage (against the design spec §4–§13):** Stack/structure → Tasks 1–3; backend-ready data layer + concurrency → Tasks 9, 11; domain model → Task 4; pure business logic (pricing, quote/order/invoice/AR/numbering) → Tasks 5–8; mocked auth + roles + `can()` → Task 13; design tokens + foundation components → Tasks 2, 14, 15; app shell + sidebar active-state + topbar → Task 16; command palette → Task 17; `/patterns` page → Task 17; seed data → Task 10; TanStack Query → Task 12. **Deferred to Plan 2/3 (intentional):** all data-driven screens (Customers, Parts, Orders, Quotes, Invoicing, A/R, Today, placeholders) and the E2E happy path — these are the next plans.

**Placeholder scan:** No "TBD/TODO/handle later" in steps. The seed task intentionally provides complete core records plus an explicit instruction to extend arrays with the remaining reference-listed rows (data, not logic) — acceptable and not a logic placeholder.

**Type consistency:** `Repositories` shape (Task 9) is consumed verbatim by the mock (Task 11) and hooks (Task 12). `NewWorkOrder`/`NewInvoice` omit `id|createdAt|updatedAt|version` consistently with `WriteRepo.create`'s `Omit`. Status unions + meta maps (Task 4) feed `StatusPill`/`toneClasses` (Tasks 2, 14). `quoteTotalCents` (Task 5) is reused by quote-state (Task 6) and order creation (Task 7).

---

## Next plans (to be written after this one builds green)
- **Plan 2 — Data-driven screens:** Customers (list+detail tabs), Parts (list+editor), Process Master (list+read-only detail), Specifications, Certifications, **Today dashboard** (Manager/Sales/Office, KPIs computed from seed), and the placeholder pages; sidebar badges wired from live counts.
- **Plan 3 — Quote→Order→Invoice workflow:** Quote builder (multi-part) + lifecycle actions + mutation hooks, Won→Order, Order detail (ship gate, cert release, status actions), Invoicing (bill/pay), A/R aging + close-period, and the Playwright happy-path E2E.

# HeatSynQ Plan 9 — Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the `/reports` placeholder with the prototype's report catalog + 16 live derived-at-read report views, and complete the full DEMO_NOW clock migration.

**Architecture:** Pure read projection — no new entity/repo/write/permission/seed change. Report math lives in `lib/logic/report-types.ts` + four group modules + a registry (`lib/logic/reports.ts`); one generic view renders every report from a typed cell descriptor. Routes: `/reports` (catalog) + `/reports/[reportKey]` (generic view). Spec: `docs/superpowers/specs/2026-07-01-heatsynq-reports-design.md`.

**Tech Stack:** Next 16 (app router, client pages), TanStack React Query (existing hooks only), Tailwind v4 tokens, vitest + RTL, Playwright.

## Global Constraints

- Branch `heatsynq-reports` (spec committed at `68f81e5`, base `1b79b49`). Feature branch → PR; `verify` check required.
- UI depends only on async repo interfaces via existing Query hooks — this plan adds NO new hooks, keys, repos, mutations, permissions, or seed rows. Badge pin `q3-o9-c3` and every existing pinned count must hold.
- Money = integer cents, `formatMoney` at render. Dates = ISO midnight-UTC, `formatDate` at render. IBM Plex Mono (`font-mono`) for ids/numbers/dates/pills.
- Exact existing tokens/components only (`KpiTile`, `ListCard`, `StatusPill`, `MonoId`, `DetailHeader`, `EmptyState`, `ErrorPanel`, `SkeletonRows`, `PageHeader`). **No chart library, no new dependencies.**
- No new `any`, no new `eslint-disable`. `eslint --max-warnings 0` stays clean.
- Frozen clock: reports pass `DEMO_NOW` from `@/lib/clock`. "As of" renders `formatDate(DEMO_NOW)` = "Jun 30, 2026".
- Honesty rules: no invented metrics (16 canon names only), no time series, no WO-status↔invoice joins, empties are results.
- AGENTS.md: read `node_modules/next/dist/docs/` before Next-specific code (Task 9 copies the in-repo `use(params)` pattern from `app/(app)/shop-floor/[equipmentId]/page.tsx:15-16`).
- Gate (must be green at every commit): `npx vitest run` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0`. Full gate incl. `npm run build` + `npx playwright test` at Task 11.
- Percentage convention: ratio KPIs (`ratioPct`) render `"66.7%"`, `"—"` when denominator 0; the On-time KPI mirrors the existing manager tile exactly (label "On-time %", value `String(onSchedulePct(...))` = "66.7").

---

### Task 1: Report core types, cell constructors, shared helpers, `sameMonth` export

**Files:**
- Create: `lib/logic/report-types.ts`
- Create: `lib/logic/report-types.test.ts`
- Modify: `lib/logic/dashboard.ts:68` (export `sameMonth`)
- Modify: `lib/logic/dashboard.test.ts` (append describe block)

**Interfaces:**
- Consumes: `KpiDescriptor` from `lib/logic/dashboard.ts`, `StatusTone` from `lib/domain/enums`, entity types from `@/lib/domain`.
- Produces (used by Tasks 2–9): `REPORT_KEYS`, `ReportKey`, `ReportCell`, `ReportTable`, `ReportResult`, `ReportData`, `ReportDef`, `cell.{text,mono,date,money,pct,pill,progress}`, `ageDays(dateIso, asOf): number`, `ratioPct(num, den): string`, and exported `sameMonth(iso, asOf): boolean` from `./dashboard`.

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/report-types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { REPORT_KEYS, cell, ageDays, ratioPct } from "./report-types";

describe("report keys", () => {
  it("defines exactly the 16 canon report keys", () => {
    expect(REPORT_KEYS).toEqual([
      "sales-by-customer", "sales-by-process", "sales-summary", "bookings-vs-shipments",
      "ar-aging", "customer-statements", "cash-receipts", "past-due-detail",
      "equipment-utilization", "on-time-delivery", "reject-report", "work-in-process",
      "quotes-dashboard", "win-loss", "quote-aging", "quoted-vs-won",
    ]);
  });
});

describe("cell constructors", () => {
  it("builds tagged cells", () => {
    expect(cell.text("Apex")).toEqual({ kind: "text", value: "Apex" });
    expect(cell.mono("WO-48211")).toEqual({ kind: "mono", value: "WO-48211" });
    expect(cell.date("2026-06-27T00:00:00.000Z")).toEqual({ kind: "date", iso: "2026-06-27T00:00:00.000Z" });
    expect(cell.money(674000)).toEqual({ kind: "money", cents: 674000 });
    expect(cell.pct("66.7%")).toEqual({ kind: "pct", value: "66.7%" });
    expect(cell.pill("Late", "danger")).toEqual({ kind: "pill", label: "Late", tone: "danger" });
    expect(cell.progress(42)).toEqual({ kind: "progress", pct: 42 });
  });
});

describe("ageDays (UTC floor-day difference)", () => {
  const asOf = "2026-06-30T12:00:00.000Z";
  it("same UTC day is 0 regardless of time-of-day", () => {
    expect(ageDays("2026-06-30T00:00:00.000Z", asOf)).toBe(0);
  });
  it("counts whole days", () => {
    expect(ageDays("2026-06-24T00:00:00.000Z", asOf)).toBe(6);
    expect(ageDays("2026-06-12T00:00:00.000Z", asOf)).toBe(18);
  });
  it("clamps future dates to 0", () => {
    expect(ageDays("2026-07-04T00:00:00.000Z", asOf)).toBe(0);
  });
});

describe("ratioPct", () => {
  it("renders one-decimal percent", () => {
    expect(ratioPct(2, 3)).toBe("66.7%");
    expect(ratioPct(2659000, 2739000)).toBe("97.1%");
    expect(ratioPct(0, 5)).toBe("0%");
  });
  it("renders an em dash when the denominator is 0", () => {
    expect(ratioPct(0, 0)).toBe("—");
  });
});
```

Append to `lib/logic/dashboard.test.ts`:

```ts
describe("sameMonth (exported for report MTD windows)", () => {
  it("matches same UTC month+year only", async () => {
    const { sameMonth } = await import("./dashboard");
    expect(sameMonth("2026-06-01T00:00:00.000Z", "2026-06-30T12:00:00.000Z")).toBe(true);
    expect(sameMonth("2026-05-28T00:00:00.000Z", "2026-06-30T12:00:00.000Z")).toBe(false);
    expect(sameMonth("2025-06-15T00:00:00.000Z", "2026-06-30T12:00:00.000Z")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/report-types.test.ts lib/logic/dashboard.test.ts`
Expected: report-types suite FAILS (module not found); dashboard `sameMonth` test FAILS (not exported).

- [ ] **Step 3: Implement**

In `lib/logic/dashboard.ts`, change line 68 from `function sameMonth(...)` to:

```ts
export function sameMonth(iso: string, asOf: string): boolean {
  const a = new Date(iso), b = new Date(asOf);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}
```

(body unchanged — only add `export`.)

Create `lib/logic/report-types.ts`:

```ts
import type { Quote, WorkOrder, Invoice, Customer, Equipment } from "@/lib/domain";
import type { StatusTone } from "@/lib/domain/enums";
import type { KpiDescriptor } from "@/lib/logic/dashboard";

export const REPORT_KEYS = [
  "sales-by-customer", "sales-by-process", "sales-summary", "bookings-vs-shipments",
  "ar-aging", "customer-statements", "cash-receipts", "past-due-detail",
  "equipment-utilization", "on-time-delivery", "reject-report", "work-in-process",
  "quotes-dashboard", "win-loss", "quote-aging", "quoted-vs-won",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export type ReportCell =
  | { kind: "text"; value: string }
  | { kind: "mono"; value: string }
  | { kind: "date"; iso: string }
  | { kind: "money"; cents: number }
  | { kind: "pct"; value: string }
  | { kind: "pill"; label: string; tone: StatusTone }
  | { kind: "progress"; pct: number };

export const cell = {
  text: (value: string): ReportCell => ({ kind: "text", value }),
  mono: (value: string): ReportCell => ({ kind: "mono", value }),
  date: (iso: string): ReportCell => ({ kind: "date", iso }),
  money: (cents: number): ReportCell => ({ kind: "money", cents }),
  pct: (value: string): ReportCell => ({ kind: "pct", value }),
  pill: (label: string, tone: StatusTone): ReportCell => ({ kind: "pill", label, tone }),
  progress: (pct: number): ReportCell => ({ kind: "progress", pct }),
};

export type ReportTable = { columns: string[]; rows: ReportCell[][] };
export type ReportResult = { kpis: KpiDescriptor[]; table: ReportTable };
export type ReportData = {
  quotes: Quote[];
  orders: WorkOrder[];
  invoices: Invoice[];
  customers: Customer[];
  equipment: Equipment[];
};
export type ReportDef = {
  key: ReportKey;
  title: string;
  /** Honest-framing subtitle shown under the report title (only where the canon name promises more than the data holds). */
  framing?: string;
  /** EmptyState title when the table has no rows. */
  empty: string;
  build: (data: ReportData, asOf: string) => ReportResult;
};

const DAY_MS = 86_400_000;

function floorDayUtcMs(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole UTC days from dateIso's calendar day to asOf's calendar day (same day → 0; future → 0). */
export function ageDays(dateIso: string, asOf: string): number {
  const diff = floorDayUtcMs(asOf) - floorDayUtcMs(dateIso);
  return diff <= 0 ? 0 : Math.floor(diff / DAY_MS);
}

/** num/den as a one-decimal percent string; "—" when den is 0. */
export function ratioPct(num: number, den: number): string {
  if (den === 0) return "—";
  return `${Math.round((num / den) * 1000) / 10}%`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/report-types.test.ts lib/logic/dashboard.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/logic/report-types.ts lib/logic/report-types.test.ts lib/logic/dashboard.ts lib/logic/dashboard.test.ts
git commit -m "feat(reports): report cell/def types, ageDays/ratioPct helpers, export sameMonth"
```

---

### Task 2: Sales report builders

**Files:**
- Create: `lib/logic/reports-sales.ts`
- Create: `lib/logic/reports-sales.test.ts`

**Interfaces:**
- Consumes: Task 1 types + `cell`/`ratioPct`; `openOrders`, `sameMonth` from `./dashboard`; `customerBalanceCents` from `./ar`; `quoteTotalCents` from `./pricing`; `openQuotes` from `./dashboard`; `formatMoney` from `@/lib/utils`.
- Produces: `salesByCustomer`, `salesByProcess`, `salesSummary`, `bookingsVsShipments` — each a `ReportDef` (consumed by Task 6 registry).

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/reports-sales.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { salesByCustomer, salesByProcess, salesSummary, bookingsVsShipments } from "./reports-sales";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const EMPTY: ReportData = { quotes: [], orders: [], invoices: [], customers: [], equipment: [] };
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("salesByCustomer", () => {
  const r = salesByCustomer.build(data, DEMO_NOW);
  it("pins seed totals", () => {
    expect(kpi(r, "Invoiced")).toBe("$19,500");
    expect(kpi(r, "Open order value")).toBe("$27,390");
    expect(kpi(r, "Customers")).toBe("7");
  });
  it("has 7 rows, Apex first (highest invoiced), dormant Ironclad excluded", () => {
    expect(r.table.rows).toHaveLength(7);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Apex Aerospace" });
    expect(r.table.rows[0][1]).toEqual({ kind: "money", cents: 1_120_000 });
  });
  it("is empty-honest", () => {
    expect(salesByCustomer.build(EMPTY, DEMO_NOW).table.rows).toHaveLength(0);
  });
});

describe("salesByProcess", () => {
  const r = salesByProcess.build(data, DEMO_NOW);
  it("pins the seed process rollup", () => {
    expect(kpi(r, "Booked")).toBe("$27,390");
    expect(kpi(r, "Processes")).toBe("8");
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Carburize" });
    expect(r.table.rows[0][1]).toEqual({ kind: "money", cents: 1_118_000 });
    expect(r.table.rows[0][2]).toEqual({ kind: "mono", value: "3" });
  });
});

describe("salesSummary", () => {
  const r = salesSummary.build(data, DEMO_NOW);
  it("pins document-status rollup KPIs", () => {
    expect(kpi(r, "Quoted (open)")).toBe("$12,560");
    expect(kpi(r, "Won")).toBe("$3,740");
    expect(kpi(r, "Booked (open)")).toBe("$27,390");
    expect(kpi(r, "Invoiced")).toBe("$19,500");
    expect(kpi(r, "Collected")).toBe("$12,760");
  });
  it("renders the 8 fixed rows", () => {
    expect(r.table.rows).toHaveLength(8);
    expect(r.table.rows[2][1]).toEqual({ kind: "text", value: "Lost" });
    expect(r.table.rows[2][3]).toEqual({ kind: "money", cents: 1_173_600 });
    expect(r.table.rows[4][2]).toEqual({ kind: "mono", value: "0" }); // shipped WOs
  });
});

describe("bookingsVsShipments", () => {
  const r = bookingsVsShipments.build(data, DEMO_NOW);
  it("pins June MTD totals and ratio", () => {
    expect(kpi(r, "Booked MTD")).toBe("$27,390");
    expect(kpi(r, "Shipped MTD")).toBe("$26,590");
    expect(kpi(r, "Book-to-ship")).toBe("97.1%");
  });
  it("ratio dashes out with no bookings", () => {
    expect(kpi(bookingsVsShipments.build(EMPTY, DEMO_NOW), "Book-to-ship")).toBe("—");
  });
  it("excludes out-of-month records", () => {
    const july = "2026-07-15T00:00:00.000Z";
    expect(kpi(bookingsVsShipments.build(data, july), "Booked MTD")).toBe("$0");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/reports-sales.test.ts`
Expected: FAIL — Cannot find module './reports-sales'.

- [ ] **Step 3: Implement**

Create `lib/logic/reports-sales.ts`:

```ts
import type { Invoice, Quote, WorkOrder } from "@/lib/domain";
import type { InvoiceStatus } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { openOrders, openQuotes, sameMonth } from "./dashboard";
import { customerBalanceCents } from "./ar";
import { quoteTotalCents } from "./pricing";
import { cell, ratioPct, type ReportCell, type ReportDef } from "./report-types";

const quotesValue = (qs: Quote[]) => qs.reduce((s, q) => s + quoteTotalCents(q), 0);
const ordersValue = (os: WorkOrder[]) => os.reduce((s, o) => s + o.orderValueCents, 0);
const invoicesValue = (is: Invoice[]) => is.reduce((s, i) => s + i.amountCents, 0);

export const salesByCustomer: ReportDef = {
  key: "sales-by-customer",
  title: "Sales by Customer",
  empty: "No customer activity to report.",
  build(data) {
    const open = openOrders(data.orders);
    const rows = data.customers
      .map((c) => ({
        name: c.name,
        invoiced: invoicesValue(data.invoices.filter((i) => i.customerId === c.id && i.status !== "to_bill")),
        openValue: ordersValue(open.filter((o) => o.customerId === c.id)),
        openAr: customerBalanceCents(data.invoices, c.id),
        hasInvoice: data.invoices.some((i) => i.customerId === c.id),
      }))
      .filter((r) => r.hasInvoice || r.openValue > 0)
      .sort((a, b) => b.invoiced - a.invoiced || b.openValue - a.openValue || a.name.localeCompare(b.name));
    return {
      kpis: [
        { label: "Invoiced", value: formatMoney(rows.reduce((s, r) => s + r.invoiced, 0)) },
        { label: "Open order value", value: formatMoney(rows.reduce((s, r) => s + r.openValue, 0)) },
        { label: "Customers", value: String(rows.length) },
      ],
      table: {
        columns: ["CUSTOMER", "INVOICED", "OPEN ORDER VALUE", "OPEN A/R"],
        rows: rows.map((r) => [cell.text(r.name), cell.money(r.invoiced), cell.money(r.openValue), cell.money(r.openAr)]),
      },
    };
  },
};

export const salesByProcess: ReportDef = {
  key: "sales-by-process",
  title: "Sales by Process",
  empty: "No booked process lines to report.",
  build(data) {
    const byProcess = new Map<string, { booked: number; orders: Set<string> }>();
    for (const o of data.orders) {
      for (const line of o.pricing) {
        const entry = byProcess.get(line.process) ?? { booked: 0, orders: new Set<string>() };
        entry.booked += line.amountCents;
        entry.orders.add(o.id);
        byProcess.set(line.process, entry);
      }
    }
    const rows = [...byProcess.entries()]
      .map(([process, e]) => ({ process, booked: e.booked, orders: e.orders.size }))
      .sort((a, b) => b.booked - a.booked || a.process.localeCompare(b.process));
    return {
      kpis: [
        { label: "Booked", value: formatMoney(rows.reduce((s, r) => s + r.booked, 0)) },
        { label: "Processes", value: String(rows.length) },
      ],
      table: {
        columns: ["PROCESS", "BOOKED", "ORDERS"],
        rows: rows.map((r) => [cell.text(r.process), cell.money(r.booked), cell.mono(String(r.orders))]),
      },
    };
  },
};

export const salesSummary: ReportDef = {
  key: "sales-summary",
  title: "Sales Summary",
  empty: "Nothing to report.",
  build(data) {
    const openQ = openQuotes(data.quotes);
    const wonQ = data.quotes.filter((q) => q.status === "won");
    const lostQ = data.quotes.filter((q) => q.status === "lost");
    const openO = openOrders(data.orders);
    const shippedO = data.orders.filter((o) => o.status === "shipped");
    const inv = (status: InvoiceStatus) => data.invoices.filter((i) => i.status === status);
    const row = (doc: string, status: string, count: number, value: number): ReportCell[] =>
      [cell.text(doc), cell.text(status), cell.mono(String(count)), cell.money(value)];
    return {
      kpis: [
        { label: "Quoted (open)", value: formatMoney(quotesValue(openQ)) },
        { label: "Won", value: formatMoney(quotesValue(wonQ)) },
        { label: "Booked (open)", value: formatMoney(ordersValue(openO)) },
        { label: "Invoiced", value: formatMoney(invoicesValue(inv("sent")) + invoicesValue(inv("paid"))) },
        { label: "Collected", value: formatMoney(invoicesValue(inv("paid"))) },
      ],
      table: {
        columns: ["DOCUMENT", "STATUS", "COUNT", "VALUE"],
        rows: [
          row("Quotes", "Open", openQ.length, quotesValue(openQ)),
          row("Quotes", "Won", wonQ.length, quotesValue(wonQ)),
          row("Quotes", "Lost", lostQ.length, quotesValue(lostQ)),
          row("Work orders", "Open", openO.length, ordersValue(openO)),
          row("Work orders", "Shipped", shippedO.length, ordersValue(shippedO)),
          row("Invoices", "To bill", inv("to_bill").length, invoicesValue(inv("to_bill"))),
          row("Invoices", "Sent", inv("sent").length, invoicesValue(inv("sent"))),
          row("Invoices", "Paid", inv("paid").length, invoicesValue(inv("paid"))),
        ],
      },
    };
  },
};

export const bookingsVsShipments: ReportDef = {
  key: "bookings-vs-shipments",
  title: "Bookings vs. Shipments",
  empty: "No bookings or shipments this month.",
  build(data, asOf) {
    const booked = new Map<string, number>();
    const shipped = new Map<string, number>();
    for (const o of data.orders) {
      if (sameMonth(o.orderedDate, asOf)) booked.set(o.customerId, (booked.get(o.customerId) ?? 0) + o.orderValueCents);
    }
    for (const i of data.invoices) {
      if (sameMonth(i.shippedDate, asOf)) shipped.set(i.customerId, (shipped.get(i.customerId) ?? 0) + i.amountCents);
    }
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const rows = [...new Set([...booked.keys(), ...shipped.keys()])]
      .map((id) => ({ name: nameById.get(id) ?? "—", booked: booked.get(id) ?? 0, shipped: shipped.get(id) ?? 0 }))
      .sort((a, b) => b.booked - a.booked || a.name.localeCompare(b.name));
    const bookedTotal = rows.reduce((s, r) => s + r.booked, 0);
    const shippedTotal = rows.reduce((s, r) => s + r.shipped, 0);
    return {
      kpis: [
        { label: "Booked MTD", value: formatMoney(bookedTotal) },
        { label: "Shipped MTD", value: formatMoney(shippedTotal) },
        { label: "Book-to-ship", value: ratioPct(shippedTotal, bookedTotal) },
      ],
      table: {
        columns: ["CUSTOMER", "BOOKED", "SHIPPED"],
        rows: rows.map((r) => [cell.text(r.name), cell.money(r.booked), cell.money(r.shipped)]),
      },
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/reports-sales.test.ts`
Expected: PASS. Also run `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/reports-sales.ts lib/logic/reports-sales.test.ts
git commit -m "feat(reports): sales report builders (by customer/process, summary, bookings vs shipments)"
```

---

### Task 3: Accounts Receivable report builders

**Files:**
- Create: `lib/logic/reports-ar.ts`
- Create: `lib/logic/reports-ar.test.ts`

**Interfaces:**
- Consumes: Task 1 types/helpers; `ageInvoices`, `agingBucket`, `netDaysByCustomer`, `daysPastDue`, type `Bucket` from `./ar`; `sameMonth` from `./dashboard`; `formatMoney` from `@/lib/utils`.
- Produces: `arAging`, `customerStatements`, `cashReceipts`, `pastDueDetail` (`ReportDef`s for Task 6).

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/reports-ar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { arAging, customerStatements, cashReceipts, pastDueDetail } from "./reports-ar";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("arAging", () => {
  const r = arAging.build(data, DEMO_NOW);
  it("pins the 5 buckets — everything current at DEMO_NOW", () => {
    expect(kpi(r, "Current")).toBe("$6,740");
    expect(kpi(r, "1–30 days")).toBe("$0");
    expect(kpi(r, "31–60 days")).toBe("$0");
    expect(kpi(r, "61–90 days")).toBe("$0");
    expect(kpi(r, "90+ days")).toBe("$0");
  });
  it("lists the single sent invoice with a Current pill", () => {
    expect(r.table.rows).toHaveLength(1);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "INV-30412" });
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Current", tone: "neutral" });
  });
  it("moves the invoice into d31_60 at Sep 15 (dashboard.test precedent)", () => {
    const later = arAging.build(data, "2026-09-15T00:00:00.000Z");
    expect(kpi(later, "31–60 days")).toBe("$6,740");
    expect(later.table.rows[0][4]).toEqual({ kind: "pill", label: "31–60 days", tone: "warn" });
  });
});

describe("customerStatements", () => {
  const r = customerStatements.build(data, DEMO_NOW);
  it("pins open balance, unbilled, and customer count", () => {
    expect(kpi(r, "Open balance")).toBe("$6,740");
    expect(kpi(r, "Unbilled")).toBe("$7,090");
    expect(kpi(r, "Customers")).toBe("3");
  });
  it("sorts Delta (balance) above Summit/Midwest (unbilled)", () => {
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Delta Turbine" });
    expect(r.table.rows[0][4]).toEqual({ kind: "text", value: "Net 30" });
  });
});

describe("cashReceipts", () => {
  const r = cashReceipts.build(data, DEMO_NOW);
  it("pins June receipts", () => {
    expect(kpi(r, "Receipts MTD")).toBe("$12,760");
    expect(kpi(r, "Receipts")).toBe("2");
  });
  it("sorts newest paid first", () => {
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "INV-30408" });
    expect(r.table.rows[1][0]).toEqual({ kind: "mono", value: "INV-30401" });
  });
});

describe("pastDueDetail", () => {
  it("is honestly empty at DEMO_NOW", () => {
    const r = pastDueDetail.build(data, DEMO_NOW);
    expect(kpi(r, "Past due")).toBe("$0");
    expect(kpi(r, "Invoices")).toBe("0");
    expect(kpi(r, "Oldest")).toBe("—");
    expect(r.table.rows).toHaveLength(0);
  });
  it("surfaces the sent invoice once past due (Sep 15 → 50 days)", () => {
    const r = pastDueDetail.build(data, "2026-09-15T00:00:00.000Z");
    expect(r.table.rows).toHaveLength(1);
    expect(r.table.rows[0][4]).toEqual({ kind: "mono", value: "50d" });
    expect(kpi(r, "Oldest")).toBe("50d");
    expect(kpi(r, "Past due")).toBe("$6,740");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/reports-ar.test.ts`
Expected: FAIL — Cannot find module './reports-ar'.

- [ ] **Step 3: Implement**

Create `lib/logic/reports-ar.ts`:

```ts
import type { Invoice } from "@/lib/domain";
import type { StatusTone } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { ageInvoices, agingBucket, daysPastDue, netDaysByCustomer, type Bucket } from "./ar";
import { sameMonth } from "./dashboard";
import { cell, type ReportDef } from "./report-types";

const DAY_MS = 86_400_000;

const BUCKET_LABEL: Record<Bucket, string> = {
  current: "Current", d1_30: "1–30 days", d31_60: "31–60 days", d61_90: "61–90 days", d90_plus: "90+ days",
};
const BUCKET_TONE: Record<Bucket, StatusTone> = {
  current: "neutral", d1_30: "warn", d31_60: "warn", d61_90: "danger", d90_plus: "danger",
};

function dueDateIso(inv: Invoice, netDays: number): string {
  const ref = inv.invoicedDate ?? inv.shippedDate;
  return new Date(new Date(ref).getTime() + netDays * DAY_MS).toISOString();
}

export const arAging: ReportDef = {
  key: "ar-aging",
  title: "A/R Aging",
  empty: "No open invoices.",
  build(data, asOf) {
    const nd = netDaysByCustomer(data.customers);
    const buckets = ageInvoices(data.invoices, nd, asOf);
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const rows = data.invoices
      .filter((i) => i.status === "sent")
      .sort((a, b) => (a.invoicedDate ?? a.shippedDate).localeCompare(b.invoicedDate ?? b.shippedDate))
      .map((i) => {
        const bucket = agingBucket(i, nd[i.customerId] ?? 30, asOf);
        return [
          cell.mono(i.number ?? "—"),
          cell.text(nameById.get(i.customerId) ?? "—"),
          cell.money(i.amountCents),
          cell.date(i.invoicedDate ?? i.shippedDate),
          cell.pill(BUCKET_LABEL[bucket], BUCKET_TONE[bucket]),
        ];
      });
    return {
      kpis: [
        { label: "Current", value: formatMoney(buckets.current) },
        { label: "1–30 days", value: formatMoney(buckets.d1_30) },
        { label: "31–60 days", value: formatMoney(buckets.d31_60) },
        { label: "61–90 days", value: formatMoney(buckets.d61_90), tone: buckets.d61_90 > 0 ? "danger" : undefined },
        { label: "90+ days", value: formatMoney(buckets.d90_plus), tone: buckets.d90_plus > 0 ? "danger" : undefined },
      ],
      table: { columns: ["INVOICE", "CUSTOMER", "AMOUNT", "INVOICED", "BUCKET"], rows },
    };
  },
};

export const customerStatements: ReportDef = {
  key: "customer-statements",
  title: "Customer Statements",
  empty: "No customers with open items.",
  build(data) {
    const rows = data.customers
      .map((c) => {
        const sent = data.invoices.filter((i) => i.customerId === c.id && i.status === "sent");
        const unbilled = data.invoices.filter((i) => i.customerId === c.id && i.status === "to_bill");
        return {
          name: c.name,
          terms: c.terms,
          openCount: sent.length,
          balance: sent.reduce((s, i) => s + i.amountCents, 0),
          unbilled: unbilled.reduce((s, i) => s + i.amountCents, 0),
        };
      })
      .filter((r) => r.openCount > 0 || r.unbilled > 0)
      .sort((a, b) => b.balance - a.balance || b.unbilled - a.unbilled || a.name.localeCompare(b.name));
    return {
      kpis: [
        { label: "Open balance", value: formatMoney(rows.reduce((s, r) => s + r.balance, 0)) },
        { label: "Unbilled", value: formatMoney(rows.reduce((s, r) => s + r.unbilled, 0)) },
        { label: "Customers", value: String(rows.length) },
      ],
      table: {
        columns: ["CUSTOMER", "OPEN INVOICES", "BALANCE", "UNBILLED", "TERMS"],
        rows: rows.map((r) => [
          cell.text(r.name), cell.mono(String(r.openCount)), cell.money(r.balance), cell.money(r.unbilled), cell.text(r.terms),
        ]),
      },
    };
  },
};

export const cashReceipts: ReportDef = {
  key: "cash-receipts",
  title: "Cash Receipts",
  empty: "No payments recorded.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const paid = data.invoices.filter((i): i is Invoice & { paidDate: string } => i.status === "paid" && i.paidDate != null);
    const rows = [...paid].sort((a, b) => b.paidDate.localeCompare(a.paidDate));
    const mtd = paid.filter((i) => sameMonth(i.paidDate, asOf)).reduce((s, i) => s + i.amountCents, 0);
    return {
      kpis: [
        { label: "Receipts MTD", value: formatMoney(mtd) },
        { label: "Receipts", value: String(paid.length) },
      ],
      table: {
        columns: ["INVOICE", "CUSTOMER", "AMOUNT", "PAID"],
        rows: rows.map((i) => [
          cell.mono(i.number ?? "—"), cell.text(nameById.get(i.customerId) ?? "—"), cell.money(i.amountCents), cell.date(i.paidDate),
        ]),
      },
    };
  },
};

export const pastDueDetail: ReportDef = {
  key: "past-due-detail",
  title: "Past-Due Detail",
  empty: "Nothing past due.",
  build(data, asOf) {
    const nd = netDaysByCustomer(data.customers);
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const rows = data.invoices
      .filter((i) => i.status === "sent")
      .map((i) => ({ inv: i, netDays: nd[i.customerId] ?? 30, days: daysPastDue(i, nd[i.customerId] ?? 30, asOf) }))
      .filter((r) => r.days > 0)
      .sort((a, b) => b.days - a.days);
    const total = rows.reduce((s, r) => s + r.inv.amountCents, 0);
    return {
      kpis: [
        { label: "Past due", value: formatMoney(total), tone: total > 0 ? "danger" : undefined },
        { label: "Invoices", value: String(rows.length) },
        { label: "Oldest", value: rows.length ? `${rows[0].days}d` : "—" },
      ],
      table: {
        columns: ["INVOICE", "CUSTOMER", "AMOUNT", "DUE", "DAYS PAST DUE"],
        rows: rows.map(({ inv, netDays, days }) => [
          cell.mono(inv.number ?? "—"),
          cell.text(nameById.get(inv.customerId) ?? "—"),
          cell.money(inv.amountCents),
          cell.date(dueDateIso(inv, netDays)),
          cell.mono(`${days}d`),
        ]),
      },
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/reports-ar.test.ts`
Expected: PASS. Also `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/reports-ar.ts lib/logic/reports-ar.test.ts
git commit -m "feat(reports): A/R report builders (aging, statements, cash receipts, past-due detail)"
```

---

### Task 4: Production & Tracking report builders

**Files:**
- Create: `lib/logic/reports-production.ts`
- Create: `lib/logic/reports-production.test.ts`

**Interfaces:**
- Consumes: Task 1 types/helpers; `equipmentLoads`, `shopFloorSummary` from `./shop-floor`; `openOrders`, `lateOrders`, `isLate`, `onSchedulePct` from `./dashboard`; `equipmentKindMeta`, `equipmentStateMeta`, `orderStatusMeta` from `@/lib/domain/enums`; `formatMoney` from `@/lib/utils`.
- Produces: `equipmentUtilization`, `onTimeDelivery`, `rejectReport`, `workInProcess` (`ReportDef`s for Task 6).

**Verify-at-implementation clause (spec §6):** the equipment-utilization Running/Idle/Utilization seed pins below are the projected expectation (running 2 = wash + pit units, on-hold 1, idle 5, out of service 2 → utilization 2/8 = "25%"). If Step 4 fails on those three assertions only, print the actual `shopFloorSummary` output, verify it against the seed's `in_process` steps (`equipmentForStep` heuristics), and correct the EXPECTED values to the honest projection — never adjust the builder to force the plan's numbers. Document the correction in the commit message.

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/reports-production.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { equipmentUtilization, onTimeDelivery, rejectReport, workInProcess } from "./reports-production";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("equipmentUtilization", () => {
  const r = equipmentUtilization.build(data, DEMO_NOW);
  it("lists the full roster in order", () => {
    expect(r.table.rows).toHaveLength(10);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Batch IQ #1" });
  });
  it("pins the state snapshot (verify-at-implementation clause)", () => {
    expect(kpi(r, "Out of service")).toBe("2");
    expect(kpi(r, "Running")).toBe("2");
    expect(kpi(r, "Idle")).toBe("5");
    expect(kpi(r, "Utilization")).toBe("25%");
  });
  it("declares the honest snapshot framing", () => {
    expect(equipmentUtilization.framing).toBe("Current equipment state — utilization history isn't tracked yet.");
  });
});

describe("onTimeDelivery", () => {
  const r = onTimeDelivery.build(data, DEMO_NOW);
  it("mirrors the manager tile numbers", () => {
    expect(kpi(r, "On-time %")).toBe("66.7");
    expect(kpi(r, "Open")).toBe("9");
    expect(kpi(r, "Late")).toBe("3");
  });
  it("sorts by due asc with a Late pill on the overdue first row", () => {
    expect(r.table.rows).toHaveLength(9);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "WO-48120" });
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Late", tone: "danger" });
  });
});

describe("rejectReport", () => {
  it("is honestly empty over seed (no inspectResult values exist)", () => {
    const r = rejectReport.build(data, DEMO_NOW);
    expect(kpi(r, "Inspect failures")).toBe("0");
    expect(kpi(r, "Steps inspected")).toBe("0");
    expect(r.table.rows).toHaveLength(0);
  });
  it("surfaces a synthetic inspect failure", () => {
    const order = {
      ...s.workOrders[0],
      steps: s.workOrders[0].steps.map((st, i) =>
        i === 0 ? { ...st, inspectResult: "fail" as const, operatorInitials: "DM" } : st),
    };
    const r = rejectReport.build({ ...data, orders: [order] }, DEMO_NOW);
    expect(kpi(r, "Inspect failures")).toBe("1");
    expect(kpi(r, "Steps inspected")).toBe("1");
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Fail", tone: "danger" });
    expect(r.table.rows[0][3]).toEqual({ kind: "mono", value: "DM" });
  });
});

describe("workInProcess", () => {
  const r = workInProcess.build(data, DEMO_NOW);
  it("pins WIP = in_process + on_hold", () => {
    expect(kpi(r, "WIP orders")).toBe("5");
    expect(kpi(r, "WIP value")).toBe("$17,970");
    expect(kpi(r, "Late in WIP")).toBe("2");
  });
  it("sorts by due asc with a progress cell", () => {
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "WO-48190" });
    expect(r.table.rows[0][4].kind).toBe("progress");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/reports-production.test.ts`
Expected: FAIL — Cannot find module './reports-production'.

- [ ] **Step 3: Implement**

Create `lib/logic/reports-production.ts`:

```ts
import { equipmentKindMeta, equipmentStateMeta, orderStatusMeta } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { isLate, lateOrders, onSchedulePct, openOrders } from "./dashboard";
import { equipmentLoads, shopFloorSummary } from "./shop-floor";
import { cell, ratioPct, type ReportCell, type ReportDef } from "./report-types";

export const equipmentUtilization: ReportDef = {
  key: "equipment-utilization",
  title: "Equipment Utilization",
  framing: "Current equipment state — utilization history isn't tracked yet.",
  empty: "No equipment on the roster.",
  build(data, asOf) {
    const loads = equipmentLoads(openOrders(data.orders), data.equipment, asOf);
    const summary = shopFloorSummary(loads);
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const equipById = new Map(data.equipment.map((e) => [e.id, e]));
    const rows = loads.map((l) => {
      const e = equipById.get(l.equipmentId)!;
      const meta = equipmentStateMeta[l.state];
      return [
        cell.text(e.name),
        cell.text(equipmentKindMeta[e.kind].label),
        cell.pill(meta.label, meta.tone),
        l.load ? cell.mono(l.load.workOrderNumber) : cell.text("—"),
        l.load ? cell.text(nameById.get(l.load.customerId) ?? "—") : cell.text("—"),
      ];
    });
    const inService = loads.length - summary.outOfService;
    return {
      kpis: [
        { label: "Running", value: String(summary.running) },
        { label: "Idle", value: String(summary.idle) },
        { label: "Out of service", value: String(summary.outOfService), tone: summary.outOfService > 0 ? "warn" : undefined },
        { label: "Utilization", value: ratioPct(summary.running, inService) },
      ],
      table: { columns: ["EQUIPMENT", "KIND", "STATE", "WORK ORDER", "CUSTOMER"], rows },
    };
  },
};

export const onTimeDelivery: ReportDef = {
  key: "on-time-delivery",
  title: "On-Time Delivery",
  framing: "Open orders against due date — shipped-delivery history isn't tracked yet.",
  empty: "No open orders.",
  build(data, asOf) {
    const open = [...openOrders(data.orders)].sort((a, b) => a.due.localeCompare(b.due) || a.number.localeCompare(b.number));
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const late = lateOrders(data.orders, asOf).length;
    return {
      kpis: [
        { label: "On-time %", value: String(onSchedulePct(data.orders, asOf)), sub: "of open orders" },
        { label: "Open", value: String(open.length) },
        { label: "Late", value: String(late), tone: late > 0 ? "danger" : undefined },
      ],
      table: {
        columns: ["WORK ORDER", "CUSTOMER", "DUE", "STATUS", "LATE"],
        rows: open.map((o) => {
          const meta = orderStatusMeta[o.status];
          return [
            cell.mono(o.number),
            cell.text(nameById.get(o.customerId) ?? "—"),
            cell.date(o.due),
            cell.pill(meta.label, meta.tone),
            isLate(o, asOf) ? cell.pill("Late", "danger") : cell.text("—"),
          ];
        }),
      },
    };
  },
};

export const rejectReport: ReportDef = {
  key: "reject-report",
  title: "Reject Report",
  empty: "No inspection failures recorded.",
  build(data) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    let inspected = 0;
    const rows: ReportCell[][] = [];
    const sorted = [...data.orders].sort((a, b) => a.number.localeCompare(b.number));
    for (const o of sorted) {
      for (const s of o.steps) {
        if (s.inspectResult == null) continue;
        inspected += 1;
        if (s.inspectResult !== "fail") continue;
        rows.push([
          cell.mono(o.number),
          cell.text(nameById.get(o.customerId) ?? "—"),
          cell.text(s.op),
          cell.mono(s.operatorInitials ?? "—"),
          cell.pill("Fail", "danger"),
        ]);
      }
    }
    return {
      kpis: [
        { label: "Inspect failures", value: String(rows.length), tone: rows.length > 0 ? "danger" : undefined },
        { label: "Steps inspected", value: String(inspected) },
      ],
      table: { columns: ["WORK ORDER", "CUSTOMER", "STEP", "OPERATOR", "RESULT"], rows },
    };
  },
};

export const workInProcess: ReportDef = {
  key: "work-in-process",
  title: "Work-in-Process",
  empty: "Nothing on the floor.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const wip = data.orders
      .filter((o) => o.status === "in_process" || o.status === "on_hold")
      .sort((a, b) => a.due.localeCompare(b.due) || a.number.localeCompare(b.number));
    const value = wip.reduce((s, o) => s + o.orderValueCents, 0);
    const late = wip.filter((o) => isLate(o, asOf)).length;
    return {
      kpis: [
        { label: "WIP orders", value: String(wip.length) },
        { label: "WIP value", value: formatMoney(value) },
        { label: "Late in WIP", value: String(late), tone: late > 0 ? "danger" : undefined },
      ],
      table: {
        columns: ["WORK ORDER", "CUSTOMER", "PROCESS", "DUE", "PROGRESS", "VALUE"],
        rows: wip.map((o) => [
          cell.mono(o.number),
          cell.text(nameById.get(o.customerId) ?? "—"),
          cell.text(o.processSummary),
          cell.date(o.due),
          cell.progress(o.progressPct),
          cell.money(o.orderValueCents),
        ]),
      },
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/reports-production.test.ts`
Expected: PASS — except possibly the utilization snapshot pins; if ONLY those differ, apply the verify-at-implementation clause above (correct EXPECTED to the printed actual after verifying against seed steps + `equipmentForStep`), then re-run to PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/reports-production.ts lib/logic/reports-production.test.ts
git commit -m "feat(reports): production report builders (utilization snapshot, OTD, rejects, WIP)"
```

---

### Task 5: Quotes report builders

**Files:**
- Create: `lib/logic/reports-quotes.ts`
- Create: `lib/logic/reports-quotes.test.ts`

**Interfaces:**
- Consumes: Task 1 types/helpers (`ageDays`, `ratioPct`, `cell`); `openQuotes`, `awaitingApprovalCount`, `openQuoteValueCents`, `sameMonth` from `./dashboard`; `quoteTotalCents` from `./pricing`; `quoteStatusMeta` from `@/lib/domain/enums`; `formatMoney` from `@/lib/utils`.
- Produces: `quotesDashboard`, `winLoss`, `quoteAging`, `quotedVsWon` (`ReportDef`s for Task 6).

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/reports-quotes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { quotesDashboard, winLoss, quoteAging, quotedVsWon } from "./reports-quotes";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const EMPTY: ReportData = { quotes: [], orders: [], invoices: [], customers: [], equipment: [] };
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("quotesDashboard", () => {
  const r = quotesDashboard.build(data, DEMO_NOW);
  it("pins the open pipeline", () => {
    expect(kpi(r, "Open quotes")).toBe("3");
    expect(kpi(r, "Open value")).toBe("$12,560");
    expect(kpi(r, "Awaiting approval")).toBe("1");
  });
  it("sorts newest first", () => {
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "Q-2841" });
    expect(r.table.rows[0][5]).toEqual({ kind: "pill", label: "Approve", tone: "warn" });
  });
});

describe("winLoss", () => {
  const r = winLoss.build(data, DEMO_NOW);
  it("pins decided-quote outcomes", () => {
    expect(kpi(r, "Won")).toBe("2");
    expect(kpi(r, "Lost")).toBe("1");
    expect(kpi(r, "Win rate")).toBe("66.7%");
    expect(kpi(r, "Won value")).toBe("$3,740");
  });
  it("lists 3 decided quotes, newest first", () => {
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "Q-2838" });
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Won", tone: "success" });
  });
  it("dashes the rate with no decided quotes", () => {
    expect(kpi(winLoss.build(EMPTY, DEMO_NOW), "Win rate")).toBe("—");
  });
});

describe("quoteAging", () => {
  const r = quoteAging.build(data, DEMO_NOW);
  it("pins ages 18/6/0 → avg 8d, oldest 18d", () => {
    expect(kpi(r, "Open")).toBe("3");
    expect(kpi(r, "Avg age")).toBe("8d");
    expect(kpi(r, "Oldest")).toBe("18d");
  });
  it("sorts oldest first with mono age cells", () => {
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "Q-2835" });
    expect(r.table.rows[0][4]).toEqual({ kind: "mono", value: "18d" });
  });
  it("dashes ages when no open quotes", () => {
    const r0 = quoteAging.build(EMPTY, DEMO_NOW);
    expect(kpi(r0, "Avg age")).toBe("—");
    expect(kpi(r0, "Oldest")).toBe("—");
  });
});

describe("quotedVsWon", () => {
  const r = quotedVsWon.build(data, DEMO_NOW);
  it("pins the June window (May-dated Q-2828 excluded)", () => {
    expect(kpi(r, "Quoted MTD")).toBe("$25,996");
    expect(kpi(r, "Won MTD")).toBe("$1,700");
    expect(kpi(r, "Conversion")).toBe("6.5%");
  });
  it("sorts customers by quoted desc — Vulcan's lost quote leads honestly", () => {
    expect(r.table.rows).toHaveLength(5);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Vulcan Forge" });
    expect(r.table.rows[0][1]).toEqual({ kind: "money", cents: 1_173_600 });
    expect(r.table.rows[0][2]).toEqual({ kind: "money", cents: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/reports-quotes.test.ts`
Expected: FAIL — Cannot find module './reports-quotes'.

- [ ] **Step 3: Implement**

Create `lib/logic/reports-quotes.ts`:

```ts
import { quoteStatusMeta } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import { awaitingApprovalCount, openQuoteValueCents, openQuotes, sameMonth } from "./dashboard";
import { quoteTotalCents } from "./pricing";
import { ageDays, cell, ratioPct, type ReportDef } from "./report-types";

export const quotesDashboard: ReportDef = {
  key: "quotes-dashboard",
  title: "Quotes Dashboard",
  empty: "No open quotes.",
  build(data) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const open = [...openQuotes(data.quotes)].sort((a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number));
    return {
      kpis: [
        { label: "Open quotes", value: String(open.length) },
        { label: "Open value", value: formatMoney(openQuoteValueCents(data.quotes)) },
        { label: "Awaiting approval", value: String(awaitingApprovalCount(data.quotes)), tone: "warn" },
      ],
      table: {
        columns: ["QUOTE", "CUSTOMER", "DATE", "VALID UNTIL", "VALUE", "STATUS"],
        rows: open.map((q) => {
          const meta = quoteStatusMeta[q.status];
          return [
            cell.mono(q.number),
            cell.text(nameById.get(q.customerId) ?? "—"),
            cell.date(q.date),
            cell.date(q.validUntil),
            cell.money(quoteTotalCents(q)),
            cell.pill(meta.label, meta.tone),
          ];
        }),
      },
    };
  },
};

export const winLoss: ReportDef = {
  key: "win-loss",
  title: "Win / Loss",
  empty: "No decided quotes yet.",
  build(data) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const decided = data.quotes
      .filter((q) => q.status === "won" || q.status === "lost")
      .sort((a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number));
    const won = decided.filter((q) => q.status === "won");
    return {
      kpis: [
        { label: "Won", value: String(won.length) },
        { label: "Lost", value: String(decided.length - won.length) },
        { label: "Win rate", value: ratioPct(won.length, decided.length) },
        { label: "Won value", value: formatMoney(won.reduce((s, q) => s + quoteTotalCents(q), 0)) },
      ],
      table: {
        columns: ["QUOTE", "CUSTOMER", "DATE", "VALUE", "STATUS"],
        rows: decided.map((q) => {
          const meta = quoteStatusMeta[q.status];
          return [
            cell.mono(q.number),
            cell.text(nameById.get(q.customerId) ?? "—"),
            cell.date(q.date),
            cell.money(quoteTotalCents(q)),
            cell.pill(meta.label, meta.tone),
          ];
        }),
      },
    };
  },
};

export const quoteAging: ReportDef = {
  key: "quote-aging",
  title: "Quote Aging",
  empty: "No open quotes.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const open = openQuotes(data.quotes)
      .map((q) => ({ q, age: ageDays(q.date, asOf) }))
      .sort((a, b) => b.age - a.age || a.q.number.localeCompare(b.q.number));
    const avg = open.length ? Math.round(open.reduce((s, r) => s + r.age, 0) / open.length) : 0;
    return {
      kpis: [
        { label: "Open", value: String(open.length) },
        { label: "Avg age", value: open.length ? `${avg}d` : "—" },
        { label: "Oldest", value: open.length ? `${open[0].age}d` : "—" },
      ],
      table: {
        columns: ["QUOTE", "CUSTOMER", "STATUS", "DATE", "AGE", "VALUE"],
        rows: open.map(({ q, age }) => {
          const meta = quoteStatusMeta[q.status];
          return [
            cell.mono(q.number),
            cell.text(nameById.get(q.customerId) ?? "—"),
            cell.pill(meta.label, meta.tone),
            cell.date(q.date),
            cell.mono(`${age}d`),
            cell.money(quoteTotalCents(q)),
          ];
        }),
      },
    };
  },
};

export const quotedVsWon: ReportDef = {
  key: "quoted-vs-won",
  title: "Quoted vs. Won",
  empty: "No quotes issued this month.",
  build(data, asOf) {
    const nameById = new Map(data.customers.map((c) => [c.id, c.name]));
    const byCustomer = new Map<string, { quoted: number; won: number }>();
    for (const q of data.quotes) {
      if (!sameMonth(q.date, asOf)) continue;
      const e = byCustomer.get(q.customerId) ?? { quoted: 0, won: 0 };
      const total = quoteTotalCents(q);
      e.quoted += total;
      if (q.status === "won") e.won += total;
      byCustomer.set(q.customerId, e);
    }
    const rows = [...byCustomer.entries()]
      .map(([id, e]) => ({ name: nameById.get(id) ?? "—", ...e }))
      .filter((r) => r.quoted > 0 || r.won > 0)
      .sort((a, b) => b.quoted - a.quoted || a.name.localeCompare(b.name));
    const quoted = rows.reduce((s, r) => s + r.quoted, 0);
    const won = rows.reduce((s, r) => s + r.won, 0);
    return {
      kpis: [
        { label: "Quoted MTD", value: formatMoney(quoted) },
        { label: "Won MTD", value: formatMoney(won) },
        { label: "Conversion", value: ratioPct(won, quoted) },
      ],
      table: {
        columns: ["CUSTOMER", "QUOTED", "WON"],
        rows: rows.map((r) => [cell.text(r.name), cell.money(r.quoted), cell.money(r.won)]),
      },
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/reports-quotes.test.ts`
Expected: PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/reports-quotes.ts lib/logic/reports-quotes.test.ts
git commit -m "feat(reports): quotes report builders (dashboard, win/loss, aging, quoted vs won)"
```

---

### Task 6: Report registry + catalog config

**Files:**
- Create: `lib/logic/reports.ts`
- Create: `lib/logic/reports.test.ts`

**Interfaces:**
- Consumes: all 16 `ReportDef`s from Tasks 2–5; `REPORT_KEYS`/types from Task 1.
- Produces (used by Tasks 7–9): `REPORT_GROUPS: ReportGroup[]` (`{ key, icon, title, reports }`), `REPORTS: Record<ReportKey, ReportDef>`, `reportByKey(key: string): ReportDef | null`, plus `export * from "./report-types"` (components import everything from `@/lib/logic/reports`).

- [ ] **Step 1: Write the failing tests**

Create `lib/logic/reports.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { REPORT_GROUPS, REPORTS, reportByKey, REPORT_KEYS } from "./reports";

describe("catalog config (prototype canon)", () => {
  it("has the 4 canon groups in order with canon icons", () => {
    expect(REPORT_GROUPS.map((g) => [g.key, g.icon, g.title])).toEqual([
      ["sales", "☷", "Sales"],
      ["ar", "$", "Accounts Receivable"],
      ["production", "◉", "Production & Tracking"],
      ["quotes", "☷", "Quotes"],
    ]);
  });
  it("lists 4 reports per group covering all 16 keys in canon order", () => {
    expect(REPORT_GROUPS.flatMap((g) => g.reports)).toEqual([...REPORT_KEYS]);
  });
  it("every catalog item resolves to a def with the canon title", () => {
    const titles = REPORT_GROUPS.flatMap((g) => g.reports).map((k) => REPORTS[k].title);
    expect(titles).toEqual([
      "Sales by Customer", "Sales by Process", "Sales Summary", "Bookings vs. Shipments",
      "A/R Aging", "Customer Statements", "Cash Receipts", "Past-Due Detail",
      "Equipment Utilization", "On-Time Delivery", "Reject Report", "Work-in-Process",
      "Quotes Dashboard", "Win / Loss", "Quote Aging", "Quoted vs. Won",
    ]);
  });
  it("registry keys are self-consistent", () => {
    for (const key of REPORT_KEYS) expect(REPORTS[key].key).toBe(key);
  });
});

describe("reportByKey", () => {
  it("resolves known keys and rejects unknown ones", () => {
    expect(reportByKey("ar-aging")?.title).toBe("A/R Aging");
    expect(reportByKey("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/logic/reports.test.ts`
Expected: FAIL — Cannot find module './reports'.

- [ ] **Step 3: Implement**

Create `lib/logic/reports.ts`:

```ts
import type { ReportDef, ReportKey } from "./report-types";
import { salesByCustomer, salesByProcess, salesSummary, bookingsVsShipments } from "./reports-sales";
import { arAging, customerStatements, cashReceipts, pastDueDetail } from "./reports-ar";
import { equipmentUtilization, onTimeDelivery, rejectReport, workInProcess } from "./reports-production";
import { quotesDashboard, winLoss, quoteAging, quotedVsWon } from "./reports-quotes";

export type ReportGroup = { key: string; icon: string; title: string; reports: ReportKey[] };

/** Prototype canon: Visual Shop.dc.html lines 1095-1100 — groups, icons, titles, and item order. */
export const REPORT_GROUPS: ReportGroup[] = [
  { key: "sales", icon: "☷", title: "Sales", reports: ["sales-by-customer", "sales-by-process", "sales-summary", "bookings-vs-shipments"] },
  { key: "ar", icon: "$", title: "Accounts Receivable", reports: ["ar-aging", "customer-statements", "cash-receipts", "past-due-detail"] },
  { key: "production", icon: "◉", title: "Production & Tracking", reports: ["equipment-utilization", "on-time-delivery", "reject-report", "work-in-process"] },
  { key: "quotes", icon: "☷", title: "Quotes", reports: ["quotes-dashboard", "win-loss", "quote-aging", "quoted-vs-won"] },
];

export const REPORTS: Record<ReportKey, ReportDef> = {
  "sales-by-customer": salesByCustomer,
  "sales-by-process": salesByProcess,
  "sales-summary": salesSummary,
  "bookings-vs-shipments": bookingsVsShipments,
  "ar-aging": arAging,
  "customer-statements": customerStatements,
  "cash-receipts": cashReceipts,
  "past-due-detail": pastDueDetail,
  "equipment-utilization": equipmentUtilization,
  "on-time-delivery": onTimeDelivery,
  "reject-report": rejectReport,
  "work-in-process": workInProcess,
  "quotes-dashboard": quotesDashboard,
  "win-loss": winLoss,
  "quote-aging": quoteAging,
  "quoted-vs-won": quotedVsWon,
};

export function reportByKey(key: string): ReportDef | null {
  return (REPORTS as Record<string, ReportDef | undefined>)[key] ?? null;
}

export * from "./report-types";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/logic/reports.test.ts`
Expected: PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/logic/reports.ts lib/logic/reports.test.ts
git commit -m "feat(reports): registry + canon catalog config (4 groups x 4 reports)"
```

---

### Task 7: Report catalog component + retire the /reports placeholder

**Files:**
- Create: `components/reports/report-catalog.tsx`
- Create: `components/reports/report-catalog.test.tsx`
- Modify: `app/(app)/reports/page.tsx` (full replacement of the PlaceholderPage stub)

**Interfaces:**
- Consumes: `REPORT_GROUPS`, `REPORTS` from `@/lib/logic/reports`; `PageHeader` from `@/components/patterns`; `next/link`.
- Produces: `ReportCatalog` (no props). Testids: `report-group-<groupKey>`, `report-link-<reportKey>`. Canon subtitle copy on the page: "Every report, grouped — no menu hunting."

- [ ] **Step 1: Write the failing test**

Create `components/reports/report-catalog.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportCatalog } from "./report-catalog";

describe("ReportCatalog", () => {
  it("renders the 4 canon group cards", () => {
    render(<ReportCatalog />);
    for (const key of ["sales", "ar", "production", "quotes"]) {
      expect(screen.getByTestId(`report-group-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Accounts Receivable")).toBeInTheDocument();
    expect(screen.getByText("Production & Tracking")).toBeInTheDocument();
  });
  it("renders 16 live links with report titles and hrefs", () => {
    render(<ReportCatalog />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(16);
    const aging = screen.getByTestId("report-link-ar-aging");
    expect(aging).toHaveAttribute("href", "/reports/ar-aging");
    expect(aging).toHaveTextContent("A/R Aging");
    expect(screen.getByTestId("report-link-quoted-vs-won")).toHaveAttribute("href", "/reports/quoted-vs-won");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/reports/report-catalog.test.tsx`
Expected: FAIL — Cannot find module './report-catalog'.

- [ ] **Step 3: Implement**

Create `components/reports/report-catalog.tsx`:

```tsx
import Link from "next/link";
import { REPORT_GROUPS, REPORTS } from "@/lib/logic/reports";

export function ReportCatalog() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {REPORT_GROUPS.map((g) => (
        <div key={g.key} data-testid={`report-group-${g.key}`} className="rounded-card border-border bg-surface border p-4">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="bg-primary-tint text-primary grid size-8 place-items-center rounded-md text-sm">{g.icon}</span>
            <span className="font-semibold">{g.title}</span>
          </div>
          <div>
            {g.reports.map((key) => (
              <Link
                key={key}
                data-testid={`report-link-${key}`}
                href={`/reports/${key}`}
                className="border-border-faint hover:bg-canvas flex items-center justify-between border-t px-1 py-2.5 text-[13px]"
              >
                {REPORTS[key].title}
                <span className="text-text-faint">→</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

Replace `app/(app)/reports/page.tsx` entirely with:

```tsx
"use client";
import { PageHeader } from "@/components/patterns";
import { ReportCatalog } from "@/components/reports/report-catalog";

export default function ReportsPage() {
  return (
    <div>
      <PageHeader title="Reports" subtitle="Every report, grouped — no menu hunting." />
      <ReportCatalog />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/reports/report-catalog.test.tsx && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add components/reports/report-catalog.tsx components/reports/report-catalog.test.tsx "app/(app)/reports/page.tsx"
git commit -m "feat(reports): catalog screen — retire the /reports placeholder"
```

---

### Task 8: Generic report view + cell-kind table renderer

**Files:**
- Create: `components/reports/report-table.tsx`
- Create: `components/reports/report-table.test.tsx`
- Create: `components/reports/report-view.tsx`
- Create: `components/reports/report-view.test.tsx`

**Interfaces:**
- Consumes: `ReportCell`, `ReportTable` (type), `ReportDef`, `ReportResult` from `@/lib/logic/reports`; `ListCard`, `MonoId`, `StatusPill`, `KpiTile`, `DetailHeader`, `EmptyState` from `@/components/patterns`; `formatMoney`, `formatDate` from `@/lib/utils`.
- Produces: `ReportTable({ table })` component (testid `report-table`) and `ReportView({ def, result, asOf })` (testid `report-kpis`; "As of" line; EmptyState on zero rows). Consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

Create `components/reports/report-table.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportTable } from "./report-table";
import { cell } from "@/lib/logic/reports";

describe("ReportTable cell kinds", () => {
  it("renders every cell kind with house formatting", () => {
    render(
      <ReportTable
        table={{
          columns: ["A", "B", "C", "D", "E", "F", "G"],
          rows: [[
            cell.text("Apex Aerospace"),
            cell.mono("WO-48211"),
            cell.date("2026-06-27T00:00:00.000Z"),
            cell.money(674000),
            cell.pct("66.7%"),
            cell.pill("Late", "danger"),
            cell.progress(40),
          ]],
        }}
      />,
    );
    expect(screen.getByTestId("report-table")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("WO-48211")).toBeInTheDocument();
    expect(screen.getByText("Jun 27, 2026")).toBeInTheDocument();
    expect(screen.getByText("$6,740")).toBeInTheDocument();
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("Late")).toBeInTheDocument();
    const bar = screen.getByTestId("report-cell-progress");
    expect(bar.firstChild).toHaveStyle({ width: "40%" });
  });
});
```

Create `components/reports/report-view.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportView } from "./report-view";
import type { ReportDef, ReportResult } from "@/lib/logic/reports";

const def: ReportDef = {
  key: "past-due-detail",
  title: "Past-Due Detail",
  framing: "Open invoices only.",
  empty: "Nothing past due.",
  build: () => ({ kpis: [], table: { columns: [], rows: [] } }),
};
const emptyResult: ReportResult = {
  kpis: [{ label: "Past due", value: "$0" }, { label: "Invoices", value: "0" }],
  table: { columns: ["INVOICE"], rows: [] },
};

describe("ReportView", () => {
  it("renders title, framing, deterministic as-of line, KPI strip, and honest empty state", () => {
    render(<ReportView def={def} result={emptyResult} asOf="2026-06-30T12:00:00.000Z" />);
    expect(screen.getByRole("heading", { name: "Past-Due Detail" })).toBeInTheDocument();
    expect(screen.getByText("Open invoices only.")).toBeInTheDocument();
    expect(screen.getByText("As of Jun 30, 2026")).toBeInTheDocument();
    expect(screen.getByTestId("report-kpis")).toHaveTextContent("Past due");
    expect(screen.getByText("Nothing past due.")).toBeInTheDocument();
    expect(screen.queryByTestId("report-table")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reports/ })).toHaveAttribute("href", "/reports");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/reports/report-table.test.tsx components/reports/report-view.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `components/reports/report-table.tsx`:

```tsx
import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { formatDate, formatMoney } from "@/lib/utils";
import type { ReportCell, ReportTable as ReportTableData } from "@/lib/logic/reports";

function renderCell(c: ReportCell, key: number): React.ReactNode {
  switch (c.kind) {
    case "text":
      return c.value;
    case "mono":
      return <MonoId key={key}>{c.value}</MonoId>;
    case "date":
      return <span key={key} className="text-text-muted font-mono">{formatDate(c.iso)}</span>;
    case "money":
      return <span key={key} className="font-mono">{formatMoney(c.cents)}</span>;
    case "pct":
      return <span key={key} className="font-mono">{c.value}</span>;
    case "pill":
      return <StatusPill key={key} tone={c.tone}>{c.label}</StatusPill>;
    case "progress":
      return (
        <div key={key} data-testid="report-cell-progress" className="bg-canvas-alt mt-1 h-1.5 w-24 rounded-full">
          <div className="bg-primary h-1.5 rounded-full" style={{ width: `${c.pct}%` }} />
        </div>
      );
  }
}

export function ReportTable({ table }: { table: ReportTableData }) {
  return (
    <div data-testid="report-table">
      <ListCard headers={table.columns} rows={table.rows.map((row) => row.map((c, i) => renderCell(c, i)))} />
    </div>
  );
}
```

Create `components/reports/report-view.tsx`:

```tsx
import { DetailHeader, EmptyState, KpiTile } from "@/components/patterns";
import { formatDate } from "@/lib/utils";
import type { ReportDef, ReportResult } from "@/lib/logic/reports";
import { ReportTable } from "./report-table";

export function ReportView({ def, result, asOf }: { def: ReportDef; result: ReportResult; asOf: string }) {
  return (
    <div>
      <DetailHeader backHref="/reports" backLabel="Reports" title={def.title} subtitle={def.framing} />
      <div className="text-text-muted mb-4 font-mono text-[11px]">As of {formatDate(asOf)}</div>
      <div
        data-testid="report-kpis"
        className="mb-5 grid gap-3"
        style={{ gridTemplateColumns: `repeat(${result.kpis.length}, minmax(0, 1fr))` }}
      >
        {result.kpis.map((k) => (
          <KpiTile key={k.label} label={k.label} value={k.value} sub={k.sub} tone={k.tone} />
        ))}
      </div>
      {result.table.rows.length === 0 ? <EmptyState title={def.empty} /> : <ReportTable table={result.table} />}
    </div>
  );
}
```

(Dynamic `gridTemplateColumns` via inline style follows the schedule-board precedent, `components/schedule/schedule-board.tsx` — KPI count varies 2–5 per report.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/reports/report-table.test.tsx components/reports/report-view.test.tsx && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add components/reports/report-table.tsx components/reports/report-table.test.tsx components/reports/report-view.tsx components/reports/report-view.test.tsx
git commit -m "feat(reports): generic report view + cell-kind table renderer"
```

---

### Task 9: `/reports/[reportKey]` route page

**Files:**
- Create: `app/(app)/reports/[reportKey]/page.tsx`

**Interfaces:**
- Consumes: `use(params)` pattern from `app/(app)/shop-floor/[equipmentId]/page.tsx:15-16` (AGENTS.md: consult `node_modules/next/dist/docs/` if anything about the dynamic-segment API looks unfamiliar); `reportByKey` from `@/lib/logic/reports`; `ReportView` from Task 8; `useQuotes/useWorkOrders/useInvoices/useCustomers/useEquipment` from `@/lib/query/hooks`; `DEMO_NOW` from `@/lib/clock`; `SkeletonRows/ErrorPanel/EmptyState` from `@/components/patterns`.
- Produces: the drill-down route. Unknown key → `EmptyState` "No such report" with a back link (house unknown-id convention, mirroring the equipment detail's "Equipment not found").

- [ ] **Step 1: Implement the page** (thin container — logic and rendering are fully covered by Task 2–8 tests; the route itself is exercised end-to-end in Task 11)

Create `app/(app)/reports/[reportKey]/page.tsx`:

```tsx
"use client";
import { use } from "react";
import Link from "next/link";
import { useCustomers, useEquipment, useInvoices, useQuotes, useWorkOrders } from "@/lib/query/hooks";
import { EmptyState, ErrorPanel, SkeletonRows } from "@/components/patterns";
import { ReportView } from "@/components/reports/report-view";
import { reportByKey } from "@/lib/logic/reports";
import { DEMO_NOW } from "@/lib/clock";

export default function ReportPage({ params }: { params: Promise<{ reportKey: string }> }) {
  const { reportKey } = use(params);
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const invoices = useInvoices();
  const customers = useCustomers();
  const equipment = useEquipment();

  const def = reportByKey(reportKey);
  if (!def) {
    return (
      <EmptyState
        title="No such report"
        action={<Link className="text-primary text-xs" href="/reports">Back to Reports</Link>}
      />
    );
  }

  if (quotes.isLoading || orders.isLoading || invoices.isLoading || customers.isLoading || equipment.isLoading)
    return <SkeletonRows />;
  if (quotes.isError || orders.isError || invoices.isError || customers.isError || equipment.isError)
    return (
      <ErrorPanel
        message="Failed to load report data."
        onRetry={() => {
          quotes.refetch();
          orders.refetch();
          invoices.refetch();
          customers.refetch();
          equipment.refetch();
        }}
      />
    );

  const result = def.build(
    {
      quotes: quotes.data ?? [],
      orders: orders.data ?? [],
      invoices: invoices.data ?? [],
      customers: customers.data ?? [],
      equipment: equipment.data ?? [],
    },
    DEMO_NOW,
  );

  return <ReportView def={def} result={result} asOf={DEMO_NOW} />;
}
```

- [ ] **Step 2: Verify with the existing gate**

Run: `npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0`
Expected: all clean (vitest total grows by the Task 1–8 suites; no regressions).

- [ ] **Step 3: Manual smoke (dev server)**

Run: `npm run dev` (or reuse a running server); visit `http://localhost:3000/reports/ar-aging` — expect "Current $6,740" KPI + INV-30412 row + "As of Jun 30, 2026"; visit `http://localhost:3000/reports/nope` — expect "No such report" with a working back link. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/reports/[reportKey]/page.tsx"
git commit -m "feat(reports): report drill-down route with unknown-key empty state"
```

---

### Task 10: Full DEMO_NOW clock migration

**Files:**
- Modify: `app/(app)/today/page.tsx:33`
- Modify: `app/(app)/tracking/page.tsx:23`
- Modify: `app/(app)/ar/page.tsx:19`
- Modify: `app/(app)/invoicing/page.tsx:23`
- Modify: `app/(app)/orders/[id]/page.tsx:40`
- Modify: `app/(app)/quotes/new/page.tsx:30`
- Modify: `app/(app)/quotes/[id]/page.tsx:78`
- Modify: `lib/query/hooks.ts:144,210,229`
- Create: `tests/clock-stamps.test.tsx`

**Interfaces:**
- Consumes: `DEMO_NOW` from `@/lib/clock`; `renderWithProviders`/wrapper conventions from `tests/utils.tsx` and `tests/equipment-hooks.test.tsx` (renderHook + `createMockRepositories({ latencyMs: 0 })` + stale-version pattern).
- Produces: every read `asOf` and write stamp in app/lib is `DEMO_NOW`; the only wall-clock left in `app/`+`components/`+`lib/` is `components/shell/topbar.tsx:16` (intentional machine date — if another cosmetic time-of-day site surfaces, it is topbar-class: leave it and list it in the PR).

- [ ] **Step 1: Write the failing test**

Create `tests/clock-stamps.test.tsx` (mirror the provider stack used in `tests/equipment-hooks.test.tsx` — reuse its `createWrapper`-style helper verbatim from that file):

```tsx
import { describe, it, expect } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import { useTrackInStep } from "@/lib/query/hooks";
import { DEMO_NOW } from "@/lib/clock";

function createWrapper(repos: ReturnType<typeof createMockRepositories>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <RepositoriesProvider repositories={repos}>
          <AuthProvider>{children}</AuthProvider>
        </RepositoriesProvider>
      </QueryClientProvider>
    );
  };
}

describe("mutation stamps use the frozen clock", () => {
  it("track-in stamps trackedInAt and activity with DEMO_NOW", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const operator = (await repos.operators.get("op-dana"))!;
    const order = (await repos.workOrders.get("wo-48205"))!; // step 3 (Vacuum harden) is pending
    const { result } = renderHook(() => useTrackInStep(), { wrapper: createWrapper(repos) });
    await act(async () => {
      await result.current.mutateAsync({ order, stepN: 3, operator });
    });
    await waitFor(async () => {
      const updated = (await repos.workOrders.get("wo-48205"))!;
      const step = updated.steps.find((s) => s.n === 3)!;
      expect(step.trackedInAt).toBe(DEMO_NOW);
      expect(updated.activity[updated.activity.length - 1].at).toBe(DEMO_NOW);
    });
  });
});
```

> If `RepositoriesProvider`'s prop name differs (check `lib/data/provider.tsx` — it may be `value` or `repositories`), or `wo-48205`'s step 3 isn't the first trackable pending step, copy the exact provider-stack helper and a valid `stepN` from `tests/equipment-hooks.test.tsx` / `tests/schedule-hooks.test.tsx` — those files are the source of truth for this harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/clock-stamps.test.tsx`
Expected: FAIL — `trackedInAt` is a real wall-clock instant, not `"2026-06-30T12:00:00.000Z"`.

- [ ] **Step 3: Implement the migration (10 call sites)**

In each file, add the import `import { DEMO_NOW } from "@/lib/clock";` (where not already present) and make exactly these edits:

1. `app/(app)/today/page.tsx:33` — `const asOf = new Date().toISOString();` → `const asOf = DEMO_NOW;`
2. `app/(app)/tracking/page.tsx:23` — `const now = new Date().toISOString();` → `const now = DEMO_NOW;`
3. `app/(app)/ar/page.tsx:19` — `asOf={new Date().toISOString()}` → `asOf={DEMO_NOW}`
4. `app/(app)/invoicing/page.tsx:23` — `const now = () => new Date().toISOString();` → `const now = () => DEMO_NOW;`
5. `app/(app)/orders/[id]/page.tsx:40` — `const now = () => new Date().toISOString();` → `const now = () => DEMO_NOW;`
6. `app/(app)/quotes/new/page.tsx:30` — `todayIso={new Date().toISOString()}` → `todayIso={DEMO_NOW}`
7. `app/(app)/quotes/[id]/page.tsx:78` — `todayIso={new Date().toISOString()}` → `todayIso={DEMO_NOW}`
8. `lib/query/hooks.ts:144` (`useWinQuote`) — `nowIso: new Date().toISOString()` → `nowIso: DEMO_NOW`
9. `lib/query/hooks.ts:210` (`useTrackInStep`) — `const at = new Date().toISOString();` → `const at = DEMO_NOW;`
10. `lib/query/hooks.ts:229` (`useTrackOutStep`) — `const at = new Date().toISOString();` → `const at = DEMO_NOW;`

- [ ] **Step 4: Verify the wall-clock invariant**

Run: `grep -rn "new Date()" app components lib --include="*.ts" --include="*.tsx" | grep -v ".test."`
Expected: the ONLY hit is `components/shell/topbar.tsx` (machine date). Any other hit is either topbar-class cosmetic time-of-day (leave + list in PR) or a missed migration site (fix it).

- [ ] **Step 5: Run the full unit gate**

Run: `npx vitest run && npx tsc --noEmit && npx eslint . --max-warnings 0`
Expected: all green — `tests/clock-stamps.test.tsx` now passes; existing suites unaffected (they pass explicit `at`/`asOf` values). If any existing test pinned a wall-clock-derived value, fix the TEST only if it asserted "some recent timestamp"; report anything that asserted specific non-DEMO_NOW behavior.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/today/page.tsx" "app/(app)/tracking/page.tsx" "app/(app)/ar/page.tsx" "app/(app)/invoicing/page.tsx" "app/(app)/orders/[id]/page.tsx" "app/(app)/quotes/new/page.tsx" "app/(app)/quotes/[id]/page.tsx" lib/query/hooks.ts tests/clock-stamps.test.tsx
git commit -m "feat(clock): full DEMO_NOW migration — deterministic reads and write stamps (topbar stays wall-clock)"
```

---

### Task 11: Reports E2E + full gate

**Files:**
- Create: `tests/e2e/reports.spec.ts`

**Interfaces:**
- Consumes: testids from Tasks 7–8 (`report-group-*`, `report-link-*`, `report-kpis`, `report-table`); deterministic Today numbers from Task 10; Playwright conventions from `tests/e2e/*.spec.ts` (chromium project, `npm run dev` webServer).

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/reports.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("reports catalog drills into derived reports", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  for (const key of ["sales", "ar", "production", "quotes"]) {
    await expect(page.getByTestId(`report-group-${key}`)).toBeVisible();
  }
  await expect(page.locator('[data-testid^="report-link-"]')).toHaveCount(16);

  await page.getByTestId("report-link-ar-aging").click();
  await expect(page).toHaveURL(/\/reports\/ar-aging$/);
  await expect(page.getByText("As of Jun 30, 2026")).toBeVisible();
  await expect(page.getByTestId("report-kpis")).toContainText("$6,740");
  await expect(page.getByTestId("report-table")).toContainText("INV-30412");

  await page.goto("/reports");
  await page.getByTestId("report-link-win-loss").click();
  await expect(page.getByTestId("report-kpis")).toContainText("66.7%");
  await expect(page.getByTestId("report-kpis")).toContainText("$3,740");
  await expect(page.getByTestId("report-table")).toContainText("Q-2838");
});

test("today dashboard renders deterministic Invoiced MTD after clock migration", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByText("Invoiced MTD")).toBeVisible();
  await expect(page.getByText("$19,500")).toBeVisible();
});
```

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test tests/e2e/reports.spec.ts`
Expected: 2 passed.

- [ ] **Step 3: Run the FULL gate**

```bash
npx vitest run
npx tsc --noEmit
npx eslint . --max-warnings 0
npm run build
npx playwright test
```
Expected: vitest all green (345 pre-existing + new suites); tsc/eslint clean; build succeeds with `/reports` static and `/reports/[reportKey]` dynamic; e2e 8 spec files / 10 tests green.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/reports.spec.ts
git commit -m "test(reports): e2e — catalog drill-down + deterministic Today MTD"
```

---

## Post-implementation

- Whole-branch adversarial review (per superpowers:subagent-driven-development), fix wave, then `superpowers:requesting-code-review` / PR to `main` with the `verify` check (branch protection). PR body lists: no seed changes, badge `q3-o9-c3` unchanged, topbar as the sole intentional wall-clock.
- Out of scope (carry-forwards, spec §3): filters/export, trends/time-series, cash-receipt entity, shipped-history OTD, `inv-summit-48120` quirk, `/setup`.

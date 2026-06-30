# HeatSynQ — Foundation + Quote→Order→Invoice Slice (Design Spec)

**Date:** 2026-06-30
**Status:** Approved (design); ready for implementation planning
**Repo:** https://github.com/CoJoA13/HeatSynQ.git
**Grounded reference:** [`../reference/2026-06-30-heatsynq-grounded-reference.md`](../reference/2026-06-30-heatsynq-grounded-reference.md) (exact design tokens, full data model, slice semantics, glossary, screen inventory — mined from the prototype)

---

## 1. Overview

HeatSynQ is a new, modern, workflow-driven ERP for a heat-treating / metal-processing job shop. The full product spans Sales, Production, Quality, Finance, and Setup. This spec covers the **first build**: the application **foundation** (app shell, navigation, command palette, design system, mocked auth) plus one **end-to-end vertical slice — Quote → Order → Invoice** — to prove the architecture on a real workflow before going wide.

The remaining subsystems (Schedule, Tracking, Shop Floor execution, full Quality, Reports, Setup, etc.) each get their own spec → plan → build cycle later.

### Product framing
- Visual Shop is **reference only** (domain, terminology, pain points). HeatSynQ is a new product with its own data model, UX, and architecture.
- The two `.dc.html` files + screenshots are **visual/interaction references**; `support.js` (the `dc-runtime`) is ignored. We rebuild natively.

---

## 2. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| Build approach | **Frontend-first, backend-ready** (real UI on a mock data layer behind typed repository interfaces) |
| Framework | **Next.js (App Router) + TypeScript**, single on-prem deployable |
| Eventual DB | **PostgreSQL** on-prem (built in a later phase) |
| Deployment | Single on-prem Node server serving UI + API to **multiple concurrent workstation users** |
| Auth | **App-managed accounts** (users/passwords/roles in-app); mocked in this slice |
| First slice | **Foundation + Quote → Order → Invoice** |
| Component toolkit | **Tailwind v4 + shadcn/ui** (Radix), restyled to extracted tokens |
| Quote pricing | **Price Key default rate → editable override → min-charge floor** |
| Quote scope | **Multi-part quotes** (each part its own pricing lines) → multi-part orders |
| Order creation | **Mark quote Won → auto-create Work Order** |
| Invoice trigger | **On ship → To-bill queue → bill (assign INV#) → Sent → A/R** |
| Canvas color | `#f6f7f9` (main prototype) |
| Navigation | Main-prototype naming; defer redesign-only concepts (CARs, Maintenance, "Furnace Floor") |

### Defaulted business rules (stated, changeable)
- **Pricing bases:** per-lb / per-lot / per-piece / flat.
- **Weight (e.g. 600 lb):** entered manually on the quote line; auto-calc from a Part unit-weight is a later enhancement.
- **Partial ship/invoice:** whole WO ships & invoices as one unit (partials later).
- **Approval > $25k:** per-user quote limit; over-limit quote → status **Approve** → any Manager-role user approves → Sent; reject → back to Draft.
- **Sent quotes:** immutable; "Revise" clones to a new revision; only Draft is editable.
- **Discount:** quote-level (amount or %), role-gated; line-level later.
- **Margin:** display-only in the slice (simple per-line cost stub); real cost model later.
- **Credit Hold:** customer Hold blocks new orders + shipments, still allows quoting (warning banner).
- **Cert gating:** order carries a cert flag; **ship is blocked until the cert is Released**; release is a manual action in the slice (auto-on-hardness-pass later); hardness fail → order On Hold.
- **Tax/freight:** per-customer `taxExempt` flag (exempt → no tax line); freight out of scope for the slice.
- **Numbering:** sequential per type (`Q-`, `WO-`, `INV-`, `C-`), no yearly reset, gaps allowed; cents stored, whole-dollar display.
- **Period close / payment:** "Record payment" moves Sent → Paid (full payment only in slice); "Close period" locks that period's invoices from edits (advisory in slice).

---

## 3. Scope

### In scope (build now)
- **Foundation:** app shell (sidebar, topbar, content), command palette, design system + `/patterns` page, mocked auth (login + session + role switch), shared list/detail/form/loading/error/empty patterns.
- **Slice workflow:** Quotes, Quote builder (multi-part), Orders, Order detail, Invoicing, A/R, Today dashboard (Manager/Sales/Office).
- **Reference data needed by the slice:** Customers (list + detail), Part Maintenance (list + editor), Process Master (list + read-only detail), Specifications (list), Certifications (light list driving the ship gate).
- **Shell completeness:** Schedule, Tracking, Shop Floor, Standards, Reports, Setup render a consistent "coming in a later phase" empty state.

### Out of scope (this slice)
Real Postgres/API + real auth (hashing/sessions); Schedule/Tracking/Shop-Floor execution; full Process Master editor; Standards/Reports/Setup beyond placeholders; CARs/Maintenance/furnace telemetry; partial shipments; line-level discounts; real cost/margin model; tax computation beyond the exempt flag; multi-tenant.

---

## 4. Architecture & stack

- **Next.js (App Router), TypeScript**, single deployable.
- **Tailwind v4** + **shadcn/ui** (Radix primitives), themed to the extracted token set.
- **TanStack Query (v5)** for data fetching/caching/loading-error states against the repository layer (maps cleanly onto a future HTTP backend).
- **react-hook-form + Zod** for forms + validation; **Zod** also defines/validates domain models.
- **cmdk** for the command palette; **lucide-react** for icons.
- **Vitest + React Testing Library** (unit/component); **Playwright** (slice E2E).
- Package manager: npm (confirm at scaffold if you prefer pnpm/bun).

### Backend-ready seams (the "no-rework" guarantee)
1. **UI depends only on repository interfaces** (`*Repository`), never on a concrete data source. Interfaces are async/Promise-based.
2. **Mock implementation** is in-memory, seeded with the prototype's real sample data, with **simulated latency + optional fault injection** (so loading/error UI is exercised). A repository factory/provider selects the implementation; later an `http` implementation calls Next.js route handlers → Postgres.
3. **Every entity** carries `id, createdAt, updatedAt, version` to support **optimistic concurrency** for the eventual multi-workstation backend.
4. Domain logic (pricing, state machines, aging) lives in **pure functions** independent of the data source, so it's identical in mock and real backends and unit-testable.

---

## 5. Project structure

```
app/
  (auth)/login/page.tsx
  (app)/
    layout.tsx                 # AppShell (sidebar + topbar + content)
    today/page.tsx
    quotes/page.tsx            # list
    quotes/new/page.tsx        # builder (create)
    quotes/[id]/page.tsx       # builder (edit) / read-only when Sent+
    customers/page.tsx
    customers/[id]/page.tsx    # tabbed detail
    parts/page.tsx
    parts/[id]/page.tsx        # editor
    orders/page.tsx
    orders/[id]/page.tsx       # detail
    process-masters/page.tsx
    process-masters/[id]/page.tsx   # read-only
    specifications/page.tsx
    certifications/page.tsx
    invoicing/page.tsx
    ar/page.tsx
    patterns/page.tsx          # design-system catalog
    (placeholders) schedule/ tracking/ shop-floor/ standards/ reports/ setup/
lib/
  domain/        # types + Zod schemas + enums (Quote, WorkOrder, Invoice, ...)
  logic/         # pure functions: pricing, quote/order/invoice state machines, AR aging, numbering
  data/
    repositories/  # interfaces
    mock/          # in-memory impls + latency/fault injection
    seed/          # seed dataset (Heritage Heat Treat)
    provider.ts    # factory + React context/provider
  auth/          # mocked session, current operator, can() permission helper
  query/         # TanStack Query hooks per entity
components/
  ui/            # shadcn primitives (themed)
  patterns/      # PageHeader, ListCard, StatusPill, MonoId, DetailHeader, SummaryRail,
                 # KpiTile, FormField, ErrorSummary, EmptyState, ErrorPanel, Skeleton, ConfirmDialog
  shell/         # AppShell, Sidebar, Topbar, CommandPalette
styles/          # tokens (Tailwind theme + CSS variables)
tests/           # unit, component, e2e
```

---

## 6. Design system & foundation

Tokens are taken verbatim from the grounded reference (§1). Highlights:
- **Type:** IBM Plex Sans 13px base; **IBM Plex Mono** for IDs, KPI numbers, timestamps, status pills, uppercase group labels (the brand signature — preserved).
- **Color:** primary `#3d63dd`; canvas `#f6f7f9`; surface `#ffffff`; the documented neutral/text/border ramps; semantic success `#1f9d6b` / warn `#c98a16` / danger `#d4503e`, each with its tint.
- **Status pills (5-tone map):** green (Active/Won/Shipped/Released/Ready to ship), blue (Sent/In Process), amber (Draft/On Hold/Approve), red (Late), neutral (Scheduled/Received/tags). Mono 11px, radius 6px.
- **Layout:** 252px sidebar, 60px topbar, 1060px content max-width, app-shell `100vh` flex with sticky header + scrollable content.
- Tokens are wired into the **shadcn theme** (CSS variables) plus a small set of HeatSynQ-specific tokens (status tones, mono treatment).

**Shell behaviors:** flat sidebar grouped by workflow (Today; Sales: Quotes/Customers/Part Maintenance; Production: Orders/Process Master/Schedule/Tracking/Shop Floor; Quality: Certifications/Specifications/Standards; Finance: Invoicing/A-R/Reports; footer: Patterns, Setup), badge counts, **detail routes keep their parent nav item active**. Topbar ⌘K opens the command palette (grouped Go-to / Create / Action, fuzzy search, Esc to close, empty state).

**`/patterns` page** renders every shared component and the status vocabulary live — the real version of the prototype's "Patterns" screen and our component reference.

---

## 7. Data model (slice entities)

Defined as TypeScript types + Zod schemas in `lib/domain`. Every entity includes base fields `id, createdAt, updatedAt, version`. Full field lists are in the grounded reference §2; the slice set and key structural notes:

- **Customer** (+ status Active/Hold/Dormant, terms, priceKey, taxExempt, arBalance, defaultCert) → Contacts, Parts, Quotes, WorkOrders, Invoices, PricingRules, ARBalance.
- **Contact** → Customer.
- **Part** (partNumber, description, material, drawingRev, hardness, caseDepth, specification, assignedProcessMaster, priceKey, inspection scale/sample) → Customer, ProcessMaster, Specification, PriceKey.
- **ProcessMaster** + **ProcessStep** (ordered op, equipment/area label, instructions, params[], track point) — recipe driving the traveler; read-only in slice.
- **Quote** (header) + **QuotePart[]** (part ref, material, quantity, optional weight) + **QuoteLine[]** per part (process, basis, qty/wt, rate, amount). Computed subtotal/discount/total/margin. Status: Draft / Sent / Approve / Won / Lost.
- **WorkOrder** (header: customer, customerPO, processSummary, orderedDate, due, status, certifyRequired+spec, orderValue, recipe ref, progress) + **OrderLine[]** (part, description, qty, spec) + carried pricing + traveler steps + activity feed. Status: Received / Scheduled / In Process / On Hold / Ready to ship / Shipped.
- **Certification** (id, customer, wo, specification, type, status Pending/Released, copies) → WorkOrder.
- **Specification** (id e.g. AMS 2759/3, title, rev, owner).
- **PriceKey** + **PricingRule** (process, basis, rate, minCharge) — rate source for quote lines.
- **Invoice** (id, customer, wo ref, amount, date, status To-bill/Sent/Paid).
- **ARBalance** (per-customer balance + aging buckets Current/1–30/31–60/61–90/90+).
- **Operator/User** (id>1000, name, initials, role, quoteAuthLimit $25k) + **Role** (manager/sales/office + permissions).

---

## 8. Business rules & state machines (pure functions in `lib/logic`)

### 8.1 Quote pricing
- For each `QuoteLine`: default `rate` looked up from the applicable `PricingRule` (by part/customer Price Key + process + basis); estimator may override; **effective amount = max(rate × qtyOrWeight, minCharge)**.
- Quote subtotal = Σ line amounts across all parts; total = subtotal − discount (amount or %); margin = (total − stubbed cost) / total (display-only).

### 8.2 Quote lifecycle
```
Draft --Send--> [total ≤ user limit] Sent
Draft --Send--> [total > user limit] Approve --approve(Manager)--> Sent
Approve --reject--> Draft
Sent --Won--> Won  (auto-creates WorkOrder)
Sent --Lost--> Lost
Sent --Revise--> new Quote revision (Draft)
```
- Only **Draft** quotes are editable. Sent/Approve/Won/Lost are read-only.

### 8.3 Quote → Order
- On **Won**, auto-create a `WorkOrder`: copy customer, customerPO, parts → OrderLines, pricing lines verbatim (`orderValue = quote total`), cert flag from part/customer default cert spec, traveler steps instantiated from each part's assigned ProcessMaster. Append activity "Order created from {quoteId}". WO starts at **Received**.

### 8.4 Order lifecycle & ship gate
```
Received -> Scheduled -> In Process -> Ready to ship -> Shipped
any -> On Hold -> (resume) previous
```
- **Ship** action requires the WorkOrder's Certification (if required) to be **Released**, else blocked with a clear message. Shipping sets status Shipped and creates the To-bill invoice row.
- Cert: manual **Release** action in slice; hardness "fail" → order **On Hold**.

### 8.5 Invoice & A/R
```
(ship) -> To-bill (no INV#) --bill--> Sent (INV-#####) --record payment--> Paid
```
- A/R aging derives from Sent (unpaid) invoices by age buckets; per-customer balances; "Close period" locks that period's invoices (advisory).

### 8.6 Numbering
Sequential per type via a pluggable id/number service (`Q-`, `WO-`, `INV-`, `C-`), gaps allowed, no yearly reset.

---

## 9. Screens

Each screen follows the shared patterns (List: title/subtitle/filter/primary-action/card-table/status-pills/clickable rows; Detail: back link/header/status/actions/content/summary rail; Forms: labels/validation/inline errors/error summary/disabled-until-valid/success).

| Screen | Route | Notes |
|---|---|---|
| Today | `/today` | Manager/Sales/Office variants; KPIs computed from mock data (open/late orders, on-time %, revenue MTD, open A/R, open quotes, to-bill, certs awaiting release); "Viewing as" role switch |
| Quotes | `/quotes` | list w/ status pills |
| Quote builder | `/quotes/new`, `/quotes/[id]` | multi-part: repeatable part blocks each with pricing lines; live summary rail (subtotal/discount/total/margin); customer snapshot; Save draft / Send / (over-limit) request approval; Revise on Sent |
| Customers | `/customers` | list |
| Customer detail | `/customers/[id]` | tabs Overview / Contacts / Parts / Orders / Documents / Pricing (Overview + Pricing live; others populated from seed) |
| Part Maintenance | `/parts` | list |
| Part editor | `/parts/[id]` | details, spec, assigned process master, price key, inspection |
| Orders | `/orders` | list |
| Order detail | `/orders/[id]` | parts, pricing breakdown, traveler (read-only steps from Process Master), cert card + Release, status actions + Ship (gated), activity feed |
| Process Master | `/process-masters`, `/process-masters/[id]` | list + read-only detail (steps, used-by) |
| Specifications | `/specifications` | reference list |
| Certifications | `/certifications` | light list, Pending/Released, drives ship gate |
| Invoicing | `/invoicing` | tabs To-bill / Sent / Paid; bill + record-payment actions |
| A/R | `/ar` | aging buckets + per-customer balances; Close period (confirm dialog) |
| Patterns | `/patterns` | design-system catalog |
| Placeholders | `/schedule` `/tracking` `/shop-floor` `/standards` `/reports` `/setup` | consistent "coming in a later phase" empty state |

---

## 10. Auth & roles (mocked)
- Login screen (operator id + password — any seeded operator, password not validated in slice).
- Session context exposes current Operator + role; **"Viewing as"** switch on the dashboard previews Manager/Sales/Office.
- `can(permission)` helper gates actions/nav by role (e.g. approve-over-limit = Manager; apply-discount = Sales+). Real password/session/hashing deferred to the backend phase.

---

## 11. Seed data
Seeded as the **Heritage Heat Treat** demo shop using the prototype's concrete values: customers (Apex Aerospace #1042, Titan Fasteners, Delta Turbine, Midwest Gear & Axle, Vulcan Forge [Hold], etc.), parts (TS-4471, SP-119, CS-88, BR-12, …), process masters (PM-CARB-58 rev C, PM-NIT-09, PM-VAC-44, …), specs (AMS 2759/3, …), price keys (AERO-1 with step pricing), and enough quotes/orders/invoices to populate every list, the dashboard KPIs, and at least one multi-part order (TS-4471 ×480 + SP-119 ×120) matching the reference.

---

## 12. States, validation, errors
- **Loading:** skeletons from real simulated latency (TanStack Query `isLoading`).
- **Error:** recoverable `ErrorPanel` with retry; mock layer can inject faults to demo it.
- **Empty:** `EmptyState` (max-width copy, primary action).
- **Forms:** Zod schema per form, inline field errors, error summary on invalid submit, disabled submit until valid, success confirmation.

---

## 13. Testing strategy (TDD where it counts)
- **Unit (Vitest):** pricing (rate×qty, min floor, discount, totals, margin); quote state machine (send/approve/won/lost/revise + limit routing); order-from-won-quote; order ship gate (cert released); invoice lifecycle (ship→to-bill→bill→sent→paid); A/R bucketing; numbering. *Write these tests first.*
- **Component (RTL):** StatusPill tone mapping; QuoteBuilder add/remove part+line with live totals + min-charge floor; CommandPalette filtering/grouping; Sidebar active-state on detail routes.
- **E2E (Playwright):** the whole slice happy path — create multi-part quote → send → won → order auto-created → release cert → ship → bill → invoice Sent → appears in A/R aging.

---

## 14. Build sequence (high level — detailed plan via writing-plans)
1. Scaffold Next.js + Tailwind + shadcn; wire tokens/theme; base layout.
2. Domain types + Zod + pure logic (pricing, state machines, aging) **with unit tests first**.
3. Repository interfaces + mock impl + seed + provider + TanStack Query hooks.
4. Foundation: AppShell, Sidebar, Topbar, CommandPalette, pattern components, `/patterns`, mocked auth + role switch.
5. Reference screens: Customers, Parts, Process Master, Specifications, Certifications.
6. Slice screens: Quotes + builder → Orders + detail → Invoicing → A/R.
7. Today dashboard variants.
8. Placeholders for non-slice nav.
9. E2E happy path + polish (loading/error/empty everywhere).

---

## 15. Assumptions & open items
- App name **HeatSynQ**; demo shop **Heritage Heat Treat** (changeable).
- npm as package manager (changeable to pnpm/bun).
- Tax is effectively exempt for the slice (per-customer flag only).
- All defaulted business rules in §2 stand unless changed.
- Detailed permission matrix, real auth, and the on-prem Postgres/API are separate later specs.

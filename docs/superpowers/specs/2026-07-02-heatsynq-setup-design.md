# HeatSynQ Plan 10 — Setup (design)

Date: 2026-07-02
Status: approved in brainstorming (shape / card-targets / Plant-Setup / Certs-&-Forms user-ruled; design approved)
Reference: `docs/superpowers/reference/2026-06-30-heatsynq-grounded-reference.md` (Setup §5.1 line 303 footer nav, §5.2 line 329 grid row, SetupModule §2 line 220 "Config tiles: title, desc")
Prototype ground truth: `Visual Shop.dc.html` lines 370–378 (markup) + 1102–1109 (`setupCards` data) — verified first-hand.
Prior specs: Plan 8 `2026-07-01-heatsynq-equipment-maintenance-design.md` (ReadRepo→WriteRepo promotion precedent), Plan 9 `2026-07-01-heatsynq-reports-design.md` (catalog precedent, honesty rules).

## 1. Overview

Plan 10 retires the **last placeholder** (`/setup`) with the prototype's **Setup catalog** — title "Setup",
subtitle *"Configuration once buried under Maintain ▸ … ▸ …, now flat"*, and a 3-column grid of the 6 canon
config cards, titles and descriptions **verbatim**. Per-card honesty decides what each card does:

| Card (canon title) | Canon desc (verbatim) | Behavior |
|---|---|---|
| Operators & Security | Operator IDs, roles, module permissions and signatures. | → `/setup/operators` (new view; hosts the one write) |
| Plant Setup | Company info that prints on travelers, certs and invoices. | **Inert** (muted "Not built yet" caption) |
| Process Masters | Recipes: standard steps, table keys and equipment. | → `/process-masters` (existing screen) |
| Equipment & Areas | Furnaces, ovens, areas and tracking templates. | → `/shop-floor` (existing screen) |
| Pricing & Price Keys | Step pricing, customer overrides and dimensional pricing. | → `/setup/pricing` (new read view) |
| Certifications & Forms | Cert formats, defaults and form / message inserts. | → `/setup/cert-defaults` (new read view) |

One write ships with this plan and **finally spends `edit_setup`** (reserved unused since Plan 8): a
manager can edit an operator's **quote-authorization limit** on `/setup/operators`. That promotes
`operators` from `ReadRepo` to `WriteRepo<Operator>` (Plan-8 Equipment promotion precedent) and gives
`useOperators()` its first consumers. Everything else is pure read projection. **Zero seed changes**
(badge stays `q3-o9-c3`; every existing pin holds).

User rulings (brainstorming):
1. **Shape:** hybrid — faithful 6-card grid, live drill-downs where honest data exists, plus exactly ONE
   version-checked write (operator quote-auth limit) spending `edit_setup`.
2. **Cards with existing screens link, not duplicate:** Process Masters → `/process-masters`;
   Equipment & Areas → `/shop-floor` (areas are already visible as the `/tracking` kanban columns).
3. **Plant Setup stays inert** with honest copy — no PlantInfo entity while nothing prints anywhere
   (an entity with zero consumers is config theater).
4. **Certifications & Forms → cert-defaults read view** — the desc's "defaults" is real data
   (`Customer.defaultCertSpecId` / `defaultCertCopies`); formats and form/message inserts stay unmodeled.

Honesty rules for this slice:
- **Canon only** — 6 cards, verbatim titles/descs; no invented config surfaces, no invented entities
  (no PlantInfo, no cert formats/templates, no signatures, no per-operator permission overrides).
- **Mixed grid honesty** — live cards are visibly links (hover + `→` affordance); the inert Plant Setup
  card carries a muted "Not built yet" caption so mixed behavior is explained, not mysterious.
- **Framing notes where the canon desc promises more than the data holds** — Operators view: signatures
  aren't modeled; cert-defaults view: formats/inserts aren't modeled, customer defaults only.
- **Session-cache caveat stated, not hidden** — `AuthProvider` caches the logged-in operator at login,
  so editing your *own* limit doesn't retro-update the live session; fresh logins pick it up. The demo
  path (op-dana edits op-vance) is unaffected.

## 2. Decision table

| Decision | Ruling |
|---|---|
| Catalog config | `SETUP_CARDS` typed const in `lib/logic/setup.ts` — `{ key, title, desc, href: string \| null }[]`, canon comment citing `Visual Shop.dc.html` lines 1102–1109 (data) + 370–378 (markup). Component is a dumb map (Reports-catalog pattern). |
| Card keys | `operators` · `plant` · `process-masters` · `equipment` · `pricing` · `cert-defaults` (kebab, used in testids `setup-card-<key>`). |
| Routes | `/setup` (grid) + **three static subroutes** `app/(app)/setup/operators/page.tsx`, `.../pricing/page.tsx`, `.../cert-defaults/page.tsx`. No dynamic `[section]` — the three views are heterogeneous, unlike Reports' 16-of-one-shape. All `"use client"` thin containers per house convention. Sidebar `isItemActive` prefix-match keeps Setup lit on subroutes for free; zero nav/palette changes. |
| Grid | `grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3` (prototype `repeat(3,1fr)`, responsive per shop-floor-grid precedent); card surface = `rounded-card border border-border bg-surface` tokens (never the prototype's inline hex/13px radius). |
| The write | `useSetOperatorQuoteLimit` mutation → `repos.operators.update(id, { quoteAuthLimitCents }, expectedVersion)`; invalidates `["operators"]` prefix. Narrow patch only (availability-patch precedent). Gated `useCan("edit_setup")` (= manager; matrix row unchanged). |
| Repo promotion | `Repositories.operators: ReadRepo<Operator>` → `WriteRepo<Operator>`; mock swaps `read(cols.operators)` → `write(cols.operators)` (factory exists, zero other callers gain behavior). No create/delete UI; no role editing (security semantics — out of scope). |
| Permission matrix display | `lib/auth/permissions.ts` **exports** the matrix (today module-private) + an ordered `PERMISSIONS` list + `permissionMeta` labels. `can()` untouched. Matrix rendered as 7 rows × 3 role columns with ✓/— cells. |
| roleMeta centralization | `roleMeta: Record<RoleKey, { label }>` added to `lib/domain/enums.ts`; today-dashboard's local `ROLES` const (its line 7) consumes it instead of duplicating (targeted improvement — the Operators view is a second consumer). |
| Pricing view data | `usePriceKeys()` + per-key `usePricingRulesByPriceKey(key.id)` (child component per key — hook-per-key) + `useCustomers()` for "used by N customer(s)". Read-only; `priceKeys`/`pricingRules` stay ReadRepo. |
| Cert-defaults view data | `useCustomers()` + `useSpecifications()`; resolve `defaultCertSpecId` → spec code; raw fields shown honestly ("—" for null spec; copies shown as stored, even when spec is null — that's the real seed data). `customers` stays ReadRepo. |
| Roles/permissions | Views ungated for all roles (house rule: views ungated, actions gated). The only gated action is Edit limit (`edit_setup`, manager). No new permissions. |
| Clock | No time logic anywhere in the slice — no `asOf`, no `DEMO_NOW` needed, and **zero `new Date()`** (topbar stays the sole wall-clock; grep invariant holds). |
| Seed | **Untouched.** No new rows, no changed rows, zero existing-pin churn. |
| PlaceholderPage | **Deleted** (component + its test + barrel export) — `/setup` was its last consumer; `/patterns` gallery does not use it (verified). |
| Money / FKs / any | Dollar input converts to integer cents; FKs stay plain strings; no new `any`, no new deps. |

## 3. Out of scope (carry-forwards)

- **Plant Setup entity + printing** — PlantInfo/company-info waits until anything prints (travelers,
  certs, invoices are unrendered today).
- **Cert formats / templates / form & message inserts** — unmodeled; cert "format" remains
  `Certification.type` + `copies` + `specificationId`.
- **Operator management beyond the limit** — create/delete, role editing, signatures, per-operator
  permission overrides, operator detail pages.
- **Pricing writes** — price-key/rule CRUD, customer price-key assignment, dimensional pricing
  (canon desc mentions it; no data models it).
- **Customer default-cert writes** (would promote `customers` to WriteRepo — a bigger pattern change).
- **Live session refresh on self-edit** — `AuthProvider` re-fetch/invalidation on operator update.
  Harmless today: quote-limit checks read the login-cached operator, fresh logins pick up the new value,
  and the demo path (op-dana editing op-vance) never hits the cache. Documented here and in tests; the
  view itself carries no caveat copy.
- Unchanged from Plan 9: equipment CRUD, areas-as-entity/tracking templates, CARs, telemetry,
  maintenance history, auto-hold, partial shipments, typed TrackingEvent, superseded QuoteStatus,
  backend atomicity ledger (this plan's single write is single-aggregate), `inv-summit-48120` quirk.

## 4. Pure logic & config

New/changed files (each new logic file with sibling `.test.ts`):

- `lib/logic/setup.ts` (new) — `SetupCardKey` union, `SetupCard` type, `SETUP_CARDS` const (6 canon
  entries, exact prototype strings, hrefs per §1 table). Canon comment. No functions — static config
  like `NAV_GROUPS`.
- `lib/auth/permissions.ts` (changed) — export the existing `MATRIX` under its current name (typed
  `Record<Permission, readonly RoleKey[]>`), add ordered `PERMISSIONS: readonly Permission[]` and `permissionMeta: Record<Permission, { label: string }>`:
  approve_over_limit "Approve over-limit quotes" · apply_discount "Apply discounts" · release_cert
  "Release certifications" · close_period "Close A/R period" · edit_setup "Edit setup" · schedule_loads
  "Schedule loads" · maintain_equipment "Maintain equipment". `can()` and the matrix rows unchanged.
- `lib/domain/enums.ts` (changed) — `roleMeta: Record<RoleKey, { label: string }>` (Manager/Sales/Office);
  `components/today/today-dashboard.tsx` local `ROLES` const now derives from it.
- `lib/data/repositories/index.ts` (changed) — `operators: WriteRepo<Operator>`.
- `lib/data/mock/repositories.ts` (changed) — `operators: write(cols.operators)`.
- `lib/query/hooks.ts` (changed) — `useSetOperatorQuoteLimit()` mutation
  (`vars: { id, quoteAuthLimitCents, version }`), invalidates `["operators"]`.

## 5. Components & routes

- `components/setup/setup-grid.tsx` — maps `SETUP_CARDS`; `href` non-null → `next/link` card with hover
  state + `→` glyph (nav-row affordance); null → plain card + muted "Not built yet" caption. Testids
  `setup-card-<key>`. No data hooks (static).
- `app/(app)/setup/page.tsx` — rewritten as `"use client"` thin container: `PageHeader` (canon title +
  subtitle) + `SetupGrid`. (Currently the only server-component page; it joins the house convention.)
- `components/setup/operators-security.tsx` — Operators `ListCard` (OPERATOR = name + `MonoId` id /
  TITLE / ROLE via `roleMeta` / QUOTE LIMIT via `formatMoney`) with per-row **Edit limit** button when
  `useCan("edit_setup")`; edit dialog (Plan-8 equipment-detail dialog convention): dollar input,
  non-negative validation, Save disabled while invalid/unchanged/pending, mutation error surfaced.
  Permissions section: matrix table (PERMISSION / Manager / Sales / Office; ✓/— cells, mono uppercase
  headers) + framing note *"Signatures aren't modeled yet."* Testids: `operator-row-<id>`,
  `operator-limit-<id>`, `edit-limit-<id>`, `permission-row-<perm>`.
- `app/(app)/setup/operators/page.tsx` — thin container: `DetailHeader` (back `/setup`, "Operators &
  Security"), `useOperators()` + skeleton/error branches, passes `canEdit` + mutation callback.
- `components/setup/pricing-keys.tsx` — per price key: header (`MonoId` code + description + "Used by
  N customer(s)") + rules `ListCard` (PROCESS / BASIS via `basisLabel` / RATE via `formatMoney` /
  MIN CHARGE or "—") — column semantics identical to the customer Pricing tab. Key with zero rules →
  `EmptyState` (none in seed). Testid `price-key-<code>`.
- `app/(app)/setup/pricing/page.tsx` — thin container: `DetailHeader` (back `/setup`, "Pricing & Price
  Keys"), `usePriceKeys()` + `useCustomers()`; child `PriceKeySection` owns `usePricingRulesByPriceKey`.
- `components/setup/cert-defaults.tsx` — `ListCard` (CUSTOMER / DEFAULT CERT = resolved spec code or
  "—" / COPIES) + framing note *"Cert formats and form / message inserts aren't modeled yet — customer
  defaults only."* Testid `cert-default-row-<customerId>`.
- `app/(app)/setup/cert-defaults/page.tsx` — thin container: `DetailHeader` (back `/setup`,
  "Certifications & Forms"), `useCustomers()` + `useSpecifications()`.
- **Deleted:** `components/patterns/placeholder-page.tsx`, its test, its barrel export.
- **Hygiene:** remove the stray empty untracked dir `app/\(app\)/` (escaped-parens shell accident, Jul 1).

Error handling follows house pattern: per-query `isLoading → SkeletonRows`, `isError → ErrorPanel`;
version conflict on the limit write surfaces the mutation error (optimistic-concurrency convention).

## 6. Testing

Baseline to keep green: vitest **400 tests / 78 files** (live-verified; the "79 files" figure was stale),
tsc, eslint --max-warnings 0, build, e2e 8 specs / 10 tests → grows to **9 specs**.

- `lib/logic/setup.test.ts` — pins all 6 canon titles/descs verbatim, the href table (5 links + 1 null),
  key uniqueness.
- `lib/auth/permissions.test.ts` (extend) — exported matrix matches `can()` for every perm × role;
  `PERMISSIONS` ordered & complete; labels present.
- `lib/domain/enums` roleMeta test — three labels.
- `tests/operator-hooks.test.tsx` (new, renderWithProviders + real mock repos, latency 0) — seed pins
  (op-dana $100,000 manager / op-vance $25,000 sales / op-office $0 office); `useSetOperatorQuoteLimit`
  round-trip: update op-vance → version bumps → refetch shows new cents; stale `expectedVersion` throws
  "Version conflict".
- Component tests (fixture props, no providers): setup-grid (6 cards, 5 links, inert Plant Setup caption),
  operators-security (rows, matrix ✓/— cells, Edit hidden when `canEdit=false`, dialog validation),
  pricing-keys (AERO-1 4 rules: Carburize per lb $10.30 min $250 / Temper per lot $1,440 / Certification
  flat $800 / Neutral harden per lb $6.80 min $180; "Used by 1 customer"), cert-defaults (8 rows;
  apex AMS 2759/3 · 2; titan AMS 2759/2 · 1; summit SB-4 · 1; vulcan/ironclad — · 0; delta/midwest/crane
  — · 1 — raw seed truth, verify-at-implementation).
- Page-guard tests per new route (`vi.mock` hooks + next/navigation convention).
- Seed test: unchanged (no seed edits).
- **E2E `tests/e2e/setup.spec.ts`** (happy path): `/setup` → 6 `setup-card-*` visible, exactly 5 links →
  click Operators & Security → URL `/setup/operators` → 3 operator rows + permission matrix visible →
  Edit limit on op-vance: $25,000 → set 30000 → row shows $30,000 (auto-login op-dana = manager, so
  `edit_setup` passes). Second test: `/setup` → Pricing card → AERO-1 rules table visible ($10.30 pin).

## 7. Verification notes

- The Plan-8 dialog convention, exact `formatMoney` output for $6.80 rates ("$6.80"), and the
  delta/midwest/crane copies=1 rendering are **verify-at-implementation** clauses — the implementer
  confirms against code, and task reviewers recompute pins from `buildSeed()`.
- Grep invariants that must still hold after the plan: `new Date()` in app/components/lib (tests
  excluded) hits only `components/shell/topbar.tsx`; `PlaceholderPage` hits nothing; `edit_setup`
  now hits real call sites.
- AGENTS.md: read `node_modules/next/dist/docs/` before the route work (three new static routes;
  no dynamic params in this slice).

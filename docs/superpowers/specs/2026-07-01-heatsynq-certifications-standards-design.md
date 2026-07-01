# HeatSynQ — Certifications & Standards (Quality Module) Design Spec

**Date:** 2026-07-01
**Status:** Approved (design); ready for implementation planning
**Repo:** https://github.com/CoJoA13/HeatSynQ.git
**Plan:** 7 (Certifications & Standards — the Quality module: cert lifecycle screen + Standards library)
**Builds on:** Plans 1–6 (Foundation, Data-driven screens, Quote→Order→Invoice, Shop-Floor Execution & Tracking, Shop Floor equipment monitor, Schedule weekly equipment-load board), all merged to `main`.
**Grounded reference:** [`../reference/2026-06-30-heatsynq-grounded-reference.md`](../reference/2026-06-30-heatsynq-grounded-reference.md). Certification entity §2 (✅ first-slice-adjacent, `id/customer/wo/specification/type/status Pending|Released/copies`); Standard entity §2 later-slice table (⬜, `id (AS9100D…), title, category (Quality/Process), reviewed/nextReview`); cert status vocab §4.1; dashboard framing "X certs awaiting release · Blocking X shipments" §3.2.
**Prior specs (conventions + the cert model this plan surfaces):** [Plan-6 Schedule](./2026-07-01-heatsynq-schedule-design.md); [Plan-4 Shop-Floor Execution & Tracking](./2026-07-01-heatsynq-shop-floor-tracking-execution-design.md) (inspect-pass auto-release, `canShipOrder` cert gate); [Foundation](./2026-06-30-heatsynq-foundation-quote-order-invoice-design.md) (Certification entity, C-#### numbering, blocks-ship rule, `release_cert`).

---

## 1. Overview

The Certification entity has been live since the Foundation slice: certs are auto-created on quote win (`createCertForOrder`), released manually (`useReleaseCertification`, manager-only) or automatically on final-inspect pass (Plan 4, inside `useTrackOutStep`), and an unreleased cert blocks shipment (`canShipOrder`). The `/certifications` **list** screen has been data-driven since Plan 2 (it is *not* a placeholder). What is missing is the rest of the Quality module: a cert **detail** page, navigable **linkage** (cert ↔ work order), an honest **dashboard framing** ("blocking N shipments" is currently a hardcoded string), and the **Standards library** (`/standards` is the placeholder this plan retires).

This plan completes the pipeline's `Cert` station (`Quote → Order → Schedule → Track → **Cert** → Ship → Invoice`) as a **read-mostly slice**: the only write is the existing manual release, reused as-is.

### What makes this plan different from Plans 4–6
- **No new writes.** Plan 6 added the first WO-linked WriteRepo; Plan 7 adds a **read-only repo entity** (`Standard`, the Specification pattern) and **zero new mutations**. The one action on the new detail page is the *existing* `useReleaseCertification` + `release_cert` permission — no second release path, no conflict with Plan-4's inspect-pass auto-release.
- **No schema churn.** `certificationSchema` is untouched. Everything new on screen is **derived at read** (Plan-6 minimalism): the "blocking shipments" count is a pure join of pending certs × `ready_to_ship` orders; Standards' "review overdue" flag is derived from `nextReviewAt` vs an `asOf` the page passes (`DEMO_NOW`), never stored.
- It converts the Certifications list from a dead-end table into the hub of the Quality module: list → detail → work order, and back from Order Detail's cert card.

### Product framing (unchanged)
- Visual Shop is reference only (domain, terminology). HeatSynQ is its own product/data-model/UX.
- Frontend-first on a typed mock data layer behind async repository interfaces; backend-ready seams preserved.

---

## 2. Decisions locked (from brainstorming, 2026-07-01)

| Decision | Choice |
|---|---|
| **Plan-7 scope** | **Certifications (detail + linkage + dashboard framing) + Standards library only.** Specifications screen untouched (already a ✅ reference screen — slice stays single-purpose). CAR / Maintenance stay deferred (redesign-only concepts, reference §5.3 recommends deferring). |
| **`Standard` data home** | **Seeded read-only repo entity** (`ReadRepo<Standard>`, the Specification pattern) — *not* static config (Equipment pattern) and *not* a WriteRepo. Standards is reference **data** like its Quality sibling Specifications, not app topology like the furnace roster. Keeps the locked convention (UI depends only on async repo interfaces via Query hooks) and leaves the door open for a later "mark reviewed" write without moving the data home. **User-ruled.** |
| **Certification schema** | **Unchanged.** No `releasedBy/releasedAt`, no document link (deferred — would create two writers: manual release + auto-release). Detail page shows only what exists, plus derived context from the linked WO. |
| **Release action** | **Reuse `useReleaseCertification` + `release_cert` (manager)** on both the list (existing) and the new detail page. Auto-release on inspect pass (Plan 4, `useTrackOutStep`) is untouched. No new permission. |
| **`Standard` lifecycle** | **None.** No status enum (reference §4.1 has no Standard vocab). "Review overdue" is **derived**: `isReviewDue(standard, asOf)` where `asOf = DEMO_NOW`, rendered as a danger pill (matches LATE semantics). `reviewedAt`/`nextReviewAt` are plain ISO dates. |
| **Dashboard framing** | Manager KPI "Certs Awaiting Release" keeps value = pending count; the hardcoded sub "blocking ship" becomes **computed**: `blocking N shipment(s)` where N = pending certs whose WO is `ready_to_ship` (new pure `certsBlockingShipments`). Nav badge semantics unchanged (all pending certs). |
| **Seed story** | **Flip `C-9910 → pending`** (Summit, `wo-48120`, `ready_to_ship`). Its process master `pm-nh15` has **no inspect step**, so a pending cert on a done-steps WO is coherent — this *is* the manual-release use case. Makes exactly one visible cert-blocked shipment (blocking count = 1); nav badge `c2 → c3`. No new WO, no counter bump. |
| **Detail routing** | New `/certifications/[id]` (the `use(params)` + DetailHeader + SummaryRail-grid pattern from `/orders/[id]`). List rows become clickable; Order Detail's cert number becomes a link. Cert-not-found renders an EmptyState. |
| **Standards interaction** | List only, no row click, no detail page (mirrors `/specifications`). |
| **Clock** | `/standards` passes `asOf = DEMO_NOW` (Plan-6 convention) so the overdue pill is deterministic. Pure logic never calls `Date.now()`. |

---

## 3. Scope

### In scope (build now)
- **`Standard`** domain entity: Zod schema + type, `STANDARD_CATEGORIES` + `standardCategoryMeta` (`lib/domain`).
- **`standards` repository** (`ReadRepo<Standard>`): interface entry, mock wiring (`read(cols.standards)`, no number key), provider, seed rows (4, grounded).
- **Pure logic**: `lib/logic/standards.ts` (`isReviewDue`); `certsBlockingShipments` in `lib/logic/dashboard.ts`; dashboard KPI sub computed.
- **Query hooks** (`lib/query`): `useStandards()`, `useCertification(id)` + query keys `standards`, `certification(id)`.
- **`/standards` screen**: `StandardsList` + page (replaces the `PlaceholderPage`).
- **`/certifications/[id]` screen**: cert detail (fields + linked WO card + customer + spec + Release action).
- **Linkage**: `CertificationsList` rows clickable (`onSelect`), Release button `stopPropagation`; Order Detail cert number → `Link` to cert detail.
- **Seed changes**: `C-9910` status `released → pending`; 4 standards rows (one review-overdue vs `DEMO_NOW`); seed test extended.
- **Tests**: unit (logic + seed), component (RTL: StandardsList, cert detail, pages, row-click, perm gating, loading/error guards), one new E2E happy path (`tests/e2e/certifications.spec.ts`).

### Out of scope (deferred, see §14)
- "Mark reviewed" write on Standards (+ any standards permission); Standard detail page.
- Certification schema fields (`releasedBy/releasedAt`, document link/PDF); WO activity entry on *manual* release (a two-aggregate write — joins the backend-atomicity ledger).
- Specifications screen changes; CAR / Maintenance (redesign-only); cert supersede/void states.
- Partial shipments, `TrackingEvent`, "superseded" QuoteStatus, backend transactions, real Equipment entity — unchanged prior deferrals.

---

## 4. Architecture & stack (locked conventions, restated)

- UI depends **only** on async repository interfaces via TanStack Query hooks; no component touches the mock directly.
- Money = integer cents (untouched here); dates = ISO strings (midnight-UTC for date-only fields — `reviewedAt`/`nextReviewAt` follow `due`/`day` precedent).
- IBM Plex Mono for ids/numbers/pills (`MonoId`); exact design tokens; 5-tone `StatusPill` map.
- `any` stays confined to the two approved mock-plumbing signatures (this plan adds none).
- Optimistic-concurrency `version` on every update — the only update here is the existing cert release (already version-checked).
- Permissions via authenticated `operator.role` / `useCan` (never `viewAs`).
- **Atomicity note:** Plan 7 adds **no new writes** and therefore no new multi-aggregate paths. The known two-aggregate paths (win-saga, ship+invoice, inspect-pass→cert-release, assign/unschedule) are unchanged.
- **Clock:** `lib/clock.ts` `DEMO_NOW` is the `asOf` passed by `/standards`. Certifications screens need no clock.
- **Next 16:** read `node_modules/next/dist/docs/` before any Next-specific code (AGENTS.md rule) — the new `[id]` route follows the existing `use(params)` pattern.

---

## 5. Domain additions (`lib/domain`)

### 5.1 `Standard` entity

```ts
// enums.ts
export const STANDARD_CATEGORIES = ["quality", "process"] as const;
export type StandardCategory = (typeof STANDARD_CATEGORIES)[number];
export const standardCategoryMeta: Meta<StandardCategory> = {  // Meta<T> = Record<T, { label; tone }> (existing alias)
  quality: { label: "Quality", tone: "neutral" },
  process: { label: "Process", tone: "neutral" },
};

// entities.ts
export const standardSchema = baseEntitySchema.extend({
  code: z.string(),          // "AS9100D" — display id, mono (Specification `code` precedent)
  title: z.string(),
  category: z.enum(STANDARD_CATEGORIES),
  reviewedAt: z.string(),    // ISO midnight-UTC — last internal review
  nextReviewAt: z.string(),  // ISO midnight-UTC — next review due
});
export type Standard = z.infer<typeof standardSchema>;
```

- Category pills are **neutral** (tags, per reference §1.6 "rev tags" convention) — the meta exists for labels and future tone tuning.
- No `number` field, no status enum, no `Standard` writes.

### 5.2 Certification — no changes
`certificationSchema`, `CERT_STATUSES`, `certStatusMeta` untouched.

---

## 6. Repository (`lib/data`)

- `repositories/index.ts`: `standards: ReadRepo<Standard>` (peer of `specifications`).
- Mock: `standards: read(cols.standards)` — no `numberPrefix` entry, no counter.
- Seed (`lib/data/seed/index.ts`) — 4 grounded rows (glossary §4.2):

| id | code | title | category | reviewedAt | nextReviewAt |
|---|---|---|---|---|---|
| `std-as9100d` | AS9100D | Aerospace quality management system | quality | 2025-11-15 | 2026-11-15 |
| `std-iso9001` | ISO 9001 | Quality management systems | quality | 2026-02-01 | 2027-02-01 |
| `std-nadcap-ht` | Nadcap HT | Heat treating special-process accreditation | process | 2026-03-10 | 2026-09-10 |
| `std-cqi9` | CQI-9 | AIAG heat-treat system assessment | process | 2025-06-15 | **2026-06-15** |

`std-cqi9` is review-overdue vs `DEMO_NOW` (2026-06-30) — the deterministic overdue demo. Exact titles/dates tunable at implementation; the shape and the one-overdue-row invariant are the spec.

- Seed change: `cert-9910` (`C-9910`, Summit, `wo-48120`) `status: "released" → "pending"`. All other certs, WOs, counters unchanged.
- `seed.test.ts` extends: every standards row parses `standardSchema`; exactly one row `isReviewDue` vs `DEMO_NOW`; `C-9910` pending + its WO `ready_to_ship` + `pm-nh15` has no `track: "inspect"` step (guards the manual-release story against future process-master edits).

---

## 7. Pure logic (`lib/logic`) — TDD

### 7.1 `standards.ts`
```ts
export function isReviewDue(standard: Standard, asOf: string): boolean
// true when standard.nextReviewAt <= asOf (due on or before "today"). No Date.now().
```

### 7.2 `dashboard.ts` additions
```ts
export function certsBlockingShipments(certs: Certification[], orders: WorkOrder[]): number
// count of certs where status === "pending" AND the linked order (by workOrderId) has status === "ready_to_ship"
```
- Manager KPI descriptor changes from `sub: "blocking ship"` to `` sub: `blocking ${n} shipment${n === 1 ? "" : "s"}` `` via `certsBlockingShipments`.
- `certsAwaitingRelease` (value + nav badge) unchanged.

---

## 8. Data flow & hooks (`lib/query`)

### 8.1 Query keys
```ts
standards: ["standards"] as const,
certification: (id: string) => ["certifications", id] as const,
```
`certification(id)` is **prefix-invalidated** by every existing `invalidateQueries({ queryKey: queryKeys.certifications })` call — both release paths (manual + inspect-pass) refresh the detail page with **zero hook changes**.

### 8.2 Read hooks
- `useStandards()` → `r.standards.list()`.
- `useCertification(id)` → `r.certifications.get(id)` (returns `Certification | null`; `null` → not-found state).
- Cert detail composes existing hooks for context: `useWorkOrder(cert?.workOrderId ?? "")`, `useCustomer(cert?.customerId ?? "")`, `useSpecifications()` (find by `specificationId`) — the established chained-hook pattern (the known `useCustomer("")` null-query minor stays a pre-existing deferral).

### 8.3 Mutations
None new. Detail page calls the existing `useReleaseCertification` with `{ id, version }`.

---

## 9. Screens

### 9.1 `/standards` (replaces PlaceholderPage)
- `PageHeader` — title "Standards", subtitle "Quality & process standards library."
- Guards: `isLoading → SkeletonRows`, `isError → ErrorPanel(retry)`, empty → `EmptyState`.
- `components/standards/standards-list.tsx` — `ListCard` headers `STANDARD / TITLE / CATEGORY / REVIEWED / NEXT REVIEW`; `code` in `MonoId`; category `StatusPill` (neutral); `NEXT REVIEW` cell shows the date + a danger `Overdue` pill when `isReviewDue(std, asOf)`; `asOf = DEMO_NOW` passed from the page. No row click.

### 9.2 `/certifications/[id]` (new)
- `use(params)`; `useCertification(id)` + chained context hooks; **all queries guarded** `isLoading`/`isError` (Plan-4 review lesson: no gate/action renders while context is loading); cert `null` → `EmptyState` "Certification not found" + back link.
- `DetailHeader`: back → `/certifications`; title = `C-####` (`MonoId`); `StatusPill` from `certStatusMeta`; action = `Release` button when `status === "pending" && useCan("release_cert")` → `release.mutate({ id, version })`.
- Body (order-detail grid `grid-cols-[1fr_300px]`):
  - **Certification card** — type, specification (`code` + rev), copies, created date.
  - **Work order card** — `WO-####` (`MonoId`, `Link` → `/orders/[id]`), order status pill, due date, process summary; when pending, a warn note "This cert blocks shipment of WO-####" if the WO is `ready_to_ship`.
  - **SummaryRail** — customer (link → `/customers/[id]`), status, copies.
- `components/certifications/certification-detail.tsx` holds the presentation; the page composes hooks (list-page convention).

### 9.3 `/certifications` list (edit)
- `CertificationsList` gains `onSelect?: (id: string) => void`; page wires `router.push(\`/certifications/${id}\`)`. Release button (existing) adds `stopPropagation` so the row click doesn't swallow it.

### 9.4 Order Detail (edit)
- Cert card's `cert.number` (`components/orders/order-detail.tsx` SummaryRail) becomes a `Link` → `/certifications/[cert.id]`. Nothing else changes.

### 9.5 Today dashboard (edit)
- Manager tile sub computed per §7.2. No layout change.

---

## 10. States, validation, errors

- No forms this plan → no new Zod form schemas.
- Every query on every new/edited screen: `isLoading` skeleton, `isError` `ErrorPanel` with retry, empty `EmptyState`.
- Release failure (stale version / fault injection) surfaces via the existing mutation error path (`ErrorPanel`/inline message per existing certifications-page behavior); TanStack refetch after invalidation restores truth.
- Cert-not-found (`/certifications/unknown-id`) → `EmptyState`, no crash.

---

## 11. Testing strategy

Gate (all green before merge): `npm test` (vitest) · `tsc --noEmit` · `eslint --max-warnings 0` · `next build` · `npm run test:e2e` (6/6 specs).

- **Unit (TDD):** `isReviewDue` (before/on/after boundary, `<=` semantics); `certsBlockingShipments` (pending+ready_to_ship counted; pending+in_process not; released+ready_to_ship not; orphan cert with no matching WO not); seed assertions per §6; dashboard KPI sub string (0 / 1 / n pluralization); nav-badge fixture `q3-o9-c2 → q3-o9-c3`.
- **Component (RTL):** StandardsList (rows, category pills, overdue pill only on the overdue row); standards page guards; certification-detail (fields, WO link, Release visible only pending+manager, release.mutate args, blocking note, not-found, loading/error guards incl. chained queries); certifications page row-click → push + Release stopPropagation.
- **E2E (`tests/e2e/certifications.spec.ts`):** as manager — `/certifications` shows `C-9910` Pending → click row → detail → `Release` → pill `Released` → navigate to `/orders/wo-48120` → Ship enabled (gate cleared); `/standards` shows AS9100D row and CQI-9 `Overdue` pill. Clock-independent facts only.
- **Existing tests updated, not weakened:** dashboard/nav-badge/seed tests re-pinned to the C-9910 flip (2 pending → 3).

---

## 12. Seed data

Summarized in §6. Net effect on derived counts: `certsAwaitingRelease` 2 → 3; `certsBlockingShipments` = 1 (C-9910 / WO-48120); nav badge `c2 → c3`; open orders, late counts, on-time % unchanged (no WO status/due edits).

Pre-existing seed quirk, unchanged: `inv-summit-48120` is `to_bill` with a recorded `shippedDate` while `wo-48120` has never shipped (flagged since Plan 6 exploration; not this plan's defect — see §15).

---

## 13. Build sequence (high level)

1. Domain: `Standard` schema + categories + meta.
2. Repo + seed: `standards` ReadRepo, seed rows, `C-9910` flip, seed tests.
3. Pure logic: `standards.ts`, `certsBlockingShipments`, dashboard sub (TDD).
4. Hooks + keys: `useStandards`, `useCertification`.
5. `/standards` screen (list + page), placeholder retired.
6. `/certifications/[id]` detail (component + page).
7. Linkage edits: list row-click, order-detail cert link.
8. Test-fixture re-pins (dashboard, nav badges) + E2E + full gate.

Detailed task plan via `writing-plans` (subagent-driven, TDD, review between tasks).

---

## 14. Deferred-item ledger

**Resolved by Plan 7:** `/standards` placeholder retired; cert detail + linkage (list was already live since Plan 2); honest "blocking N shipments" dashboard framing; `Standard` entity realized (as read-only reference data).

**Still deferred (carried forward):**
- "Mark reviewed" write on Standards + standards permission; Standard detail page.
- Cert `releasedBy/releasedAt` + document link; WO activity entry on manual release (two-aggregate write).
- Backend atomicity (win-saga, ship+invoice, inspect-pass→cert-release, assign/unschedule) — unchanged.
- Real `Equipment` repo entity + telemetry + AMS-2750 TUS/SAT + CARs / Maintenance (redesign concepts).
- Partial shipments; typed `TrackingEvent`; "superseded" QuoteStatus; Schedule follow-ups (week nav, capacity, multi-block); DEMO_NOW adoption in Tracking/Shop-Floor asOf.
- Pre-existing minors (`parseNetDays` discount-terms, broad `useUpdateQuote` patch type, `numbers.next` guard, `useCustomer("")` null query, Documents entity unmodeled).

---

## 15. Assumptions & open items

- **Category assignment** for Nadcap HT (process) vs AS9100D/ISO 9001 (quality) is a judgment call on grounded names; reference gives the category enum but no per-standard assignment. Tunable without schema impact.
- **`isReviewDue` boundary** is `nextReviewAt <= asOf` (due *on* the date counts as due). Stated here to avoid two readings.
- **`inv-summit-48120` quirk** (to_bill + shippedDate on a never-shipped WO) predates this plan and becomes slightly more visible with C-9910 pending. Left as-is; candidate for a seed-hygiene pass when partial shipments land.
- **`certifications.byWorkOrder`** repo helper remains unused (detail flows id→cert, not WO→cert); removing it is out of scope (backend seam).
- Real cert PDF/document generation, cert supersede/void, and multi-cert-per-WO are all future product decisions; the 1:1 WO↔cert model stands.

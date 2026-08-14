# Phase 8A — Reports & Scoreboard: Implementation Plan

**Date:** 2026-08-14
**Design spec:** `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` (approved 2026-08-14) — §4.1–§4.3 are the contract for this sub-phase.
**Branch:** `phase-8a-reports-scoreboard` (squash-merged to `main`; attribution in the PR body, never a commit trailer).
**Depends on:** the read models of Phases 3–5 (orders/`receivedDate`, shippers/`shipDate`/`ship-ledger.ts`, invoices/`finalizedAt`/`invoiceDate`/frozen snapshot, `gl-export.ts` revenue accounts, `payments`), and the existing report precedent `aging.ts` + `toXlsx` + the shared `query.ts` pattern.

## The shape every task shares (read once)

8A builds a **reporting platform**, not five bespoke pages. Each report is the same five parts, cloned from A/R aging:

1. **Service** `src/server/reports/<name>.ts` — a **pure aggregation core** (no Prisma/IO, unit-testable in isolation, the `bucketAging` precedent) + a thin **Prisma wrapper** `report<Name>(filter)` that reads and calls the core. **Pure read**: no row claim, no audit, no Serializable (spec §11). Money in integer cents; humanize cells (dates via `formatDateOnly`, enums to labels) before handing rows out. Every `where` carries `deletedAt: null` and excludes voided/discarded rows (the safe default). **The `includeVoided` toggle is intentionally deferred for 8A — default-exclude only; no toggle param/UI is built.**
2. **Filter parse** `src/app/api/reports/<name>/query.ts` — a shared module imported by BOTH the JSON route and the export route (the six-precedent single-parse discipline: `orUndefined`, `parseDate`-owned 400s), so the table and the Excel file can never disagree. The **export-mirror property is verified once** (Task 1's explicit test + this shared-parse invariant + the Task 8 E2E), not repeated per report.
3. **JSON route** `src/app/api/reports/<name>/route.ts` — `mustCan(requireUser(), "reports", "view"); return NextResponse.json(await report<Name>(parse(url)))`.
4. **Export route** `src/app/api/reports/<name>/export/route.ts` — same `mustCan` + same parse, `toXlsx(sheet, columns, rows)`, xlsx content-type + `attachment; filename` (the `receivables/aging/export` template).
5. **UI** `src/app/reports/<name>/{page.tsx, <Name>Report.tsx}` — a client component (page.tsx a trivial wrapper) against the guarded API, filters in state, ONE query string reused for the JSON fetch AND the `<a href=".../export?query">Export to Excel</a>` link, date inputs `type=date`. Renders a **numeric table — no charts** (§3 dashboard-graphs non-goal).

**TDD per task:** failing test → implement → pass → commit a small unit. Conventional commits, no attribution trailer. **Commit small units** so a died-mid-task turn resumes from a committed prefix. Run `npm test` + `tsc` + `eslint` per task; **run `npm run test:e2e` on any UI/flow-touching task** (dev server + DEV db `erp`). A gate row is written **after** watching the run end, or it says PENDING — never a pre-written green claim.

**Execution record** in `docs/execution/2026-08-14-phase-8a/` (task briefs, implementer reports, reviewer verdicts, progress ledger) — **committed on Task 0**, not at the end (the `.superpowers/sdd` clobber lesson).

**Review loop:** a fresh subagent per task → an independent `task-reviewer` per task (spec-compliance + quality, against a task-brief + implementer-report + review-package diff) → fix rounds until approved → a whole-branch review on the strongest model → one fix wave → PR. From round 6 on, triage non-correctness/concurrency/data-integrity findings to issues.

---

## Task 0 — Report platform scaffolding + the two indexes

**Goal:** the `reports` area goes live, the `/reports` index exists (closing the dead 404 nav link), the reusable report skeleton is in place, and the two required indexes land.

- **Migration** (the TTY-less two-DB workflow, CLAUDE.md): add `@@index` on **`Invoice.finalizedAt`** (Sales) and **`Payment.receivedDate`** (Payments). `migrate diff --from-config-datasource --to-schema --script` → hand-write → apply to dev + `erp_test` → `prisma generate`.
- **`/reports` index** `src/app/reports/page.tsx` — a client component listing the available reports, each link permission-filtered by `reports.view` (reuse the nav `canViewArea` gating); the index route/page requires `reports.view`. **No `nav.ts` change is needed** — the entry already targets `/reports`; the 404 exists solely because `src/app/reports/page.tsx` doesn't exist yet.
- **Skeleton**: establish `src/server/reports/` and `src/app/api/reports/` with the shared shape above; if a genuinely shared helper emerges (e.g. a common `reportExport` wrapper), extract it, but the house default is inline columns per export route (don't over-abstract on the first report).
- **Tests:** `reports.view` required on the index + a placeholder report route (403 without, 200 with); the migration is present and both indexes exist; an all-permissions user sees the index.
- **Acceptance:** navigating to `/reports` renders (no 404); a user lacking `reports.view` is denied.
- **Review focus:** permission wiring correct; no server import leaks into a client component; migration applied to BOTH DBs.

## Task 1 — Backlog report (spec §4.2)

**Goal:** open orders not yet fully shipped.

- **Measure:** orders where `status ∈ {OPEN, PARTIAL_SHIPPED, REOPENED}`, `deletedAt: null`; columns order#, customer, part(s), qty + weight ordered, receivedDate, days-open. Group/slice by customer · part · received-month. Filter: `receivedDate` range (`dateRange` helper) + customer + part. **Not** `boardWhere` (define its own status predicate).
- **Tests:** REOPENED **included**; SHIPPED/INVOICED and voided **excluded**; grouping by each dimension; received-date range filter; export mirrors on-screen filter; days-open math.
- **Acceptance:** matches a hand-computed backlog over a seeded fixture.
- **Review focus:** the REOPENED inclusion (a silent-undercount trap if dropped); soft-delete/void exclusion.

## Task 2 — Shipped report (spec §4.2)

**Goal:** actual shipped volume by period.

- **Measure:** a **new `shipDate`-windowed aggregation** joining `ShipperLine → ShipperOrder → Shipper.shipDate`, applying `ship-ledger.ts`'s live-filter discipline (voided shipments contribute nothing via `shipper.deletedAt: null`; reversals are live negative-qty rows that **net into their own `shipDate` window**). **Released rows (`orderLineId` null) ARE included** via their snapshot qty/weight — real shipped material (this is the deliberate divergence from `shippedTotals`, which skips them and has no date dimension; do NOT call `shippedTotals`). Columns: shipped qty + weight + shipment count. Group by customer · part · ship-month · day; filter `shipDate` range + customer + part.
- **Tests:** a reversal nets into its own `shipDate` window (not the original's); voided shipment excluded; a **released row is counted** (guard against reusing `shippedTotals`' skip); grouping.
- **Review focus:** released-row inclusion; reversal netting; that this is a new aggregate, not `shippedTotals`.

## Task 3 — Turnaround report (spec §4.2)

**Goal:** average order-to-ship days.

- **Measure:** completion date is **derived from shipments, never the audit log** — for each order line, the earliest live `Shipper.shipDate` whose `ShipperLine` is `lineComplete`; the order's completion date = **MAX** of those per-line dates. Include only orders **currently fully `SHIPPED`**; a `REOPENED`-then-re-completed order recomputes from **current live shipments** (ignore prior cycles). Measure = completion − `receivedDate` (days), averaged. Group by customer · part · completion-month; range on completion date. **Endpoint = full-`SHIPPED` completion** (owner default).
- **Tests:** completion-date derivation over a multi-shipment order; excludes not-currently-SHIPPED orders; REOPENED-recompute from current shipments; average math; range on completion date.
- **Review focus:** the derived completion date (no stored timestamp exists — a builder must not invent one or mine the audit log); the currently-SHIPPED-only filter.

## Task 4 — Sales report (spec §4.2) — the careful one

**Goal:** invoiced revenue, ex-tax, reconciling to GL revenue.

- **Measure:** `FINALIZED` invoices + credits recognized by **`finalizedAt`**, range **half-open `[from, nextDay)`**. Sum **ALL non-`TAX`** lines from the **frozen `Invoice`/`InvoiceLine` snapshot** (never live-join Part/StepCode) — that is **OPERATION + SURCHARGE + FREIGHT + CHARGE + CERT** (the PART header line is amount=0, harmless). **SURCHARGE carries real revenue and a blank `partNumber`** (`pricing.ts` `blank("SURCHARGE")`) — dropping it undercounts sales and breaks the reconciliation test below; do not. Net credits (credits copy their source lines, carrying `partNumber`). **By-part slice:** part-bearing lines group by `partNumber`; the blank-`partNumber` kinds (**`SURCHARGE`**/`FREIGHT`/`CHARGE`/`CERT`) go into an explicit **"(no part)"** bucket so the part-sliced total equals the unsliced total (surcharge revenue is **not** re-joined to the part it surcharges — frozen-paper rule). Group by customer · part · finalized-month.
- **Reconciliation test (the headline):** on a **fully GL-mapped, closeable month with no prior `GlPosting`** (so the export delta = the full journal), close then export; assert the **Sales grand total (Σ all-non-tax finalized lines − credits) equals the sum of `exportClose()`'s revenue-side postings** (non-A/R, non-`TAX` accounts). This is a property of a clean month, not of the report — the Sales report itself needs no GL accounts and sums `line.amount` regardless. Do **not** assert equality with the roll-forward gross (which includes tax).
- **Tests:** ex-tax (a taxed invoice's Sales figure excludes the tax line); **surcharge included** (a surcharged invoice's figure includes the surcharge revenue, which lands in the "(no part)" bucket in the by-part cut, and the month still reconciles to GL); **frozen snapshot** (rename a part / change a price *after* finalize → the report is unchanged); credit reduces the total; the "(no part)" bucket; `finalizedAt` half-open boundary (a last-second-of-month finalize lands in the right month).
- **Review focus:** ex-tax measure + the reconciliation identity (the review flagged the earlier over-claim); frozen-snapshot-not-live-join; part bucketing keeps the total whole.

## Task 5 — Payments received report (spec §4.2)

**Goal:** cash received by period.

- **Measure:** **POSTED-batch** payments (`batch.status = POSTED`) by `receivedDate`; group by customer · month · payment type (each FK'd to a GL account). **Print the basis** ("Posted payments only") on the page and the export.
- **Tests:** un-posted-batch payments **excluded** (RED-verify: a payment in a non-posted batch does not appear); grouping by payment type; range on `receivedDate`; the basis label present.
- **Review focus:** POSTED-only filter (the two existing consumers disagree — this report is deliberately the books-consistent one).

## Task 6 — Home the invoice register + A/R aging under `/reports`

**Goal:** the two already-built reports are discoverable under `/reports`.

- The `/reports` index links to the invoicing list (the de-facto invoice register — **default: link, not relocate**, §12) and to `/receivables/aging`. Their auth stays on their source areas; `/reports` is discovery only.
- **Tests:** the index shows both entries, permission-filtered (a user with `reports.view` but not `receivables.view`/`invoicing.view` sees appropriate gating).
- **Review focus:** no double-authorization confusion; links correct.

## Task 7 — Comparison scoreboard (spec §4.3, D2/D3)

**Goal:** the weekly parallel-run eyeball page.

- **Page** `src/app/reports/scoreboard/` — a numeric table (no charts), a date-range picker with **this-week** and **this-month** presets. Three figures, each with its **basis printed**:
  - **Orders entered** — count of orders by `receivedDate`, voided excluded.
  - **Shipped** — pounds & pieces (reuse the Task 2 aggregation).
  - **Invoiced $** — Σ `Invoice.total` for `FINALIZED` invoices by **`invoiceDate`** (owner ruling — VS eyeball; uses the existing `invoiceDate` index), credits netted, shown on their own line.
- No Visual-Shop data entry, no variance (D2). **Export:** an `/api/reports/scoreboard/export` route (the `receivables/aging/export` template — `toXlsx`, xlsx content-type, `attachment; filename`) driven by the **same query string** as the page, so the file mirrors the on-screen figures/window.
- **Tests:** each metric over a fixture; the **`invoiceDate` basis** for invoiced-$ (a finalized-in-a-different-month invoice buckets by its invoice date); orders-entered excludes voided; shipped matches the Shipped report for the same window; the basis labels render; **the export mirrors the on-screen figures/window**.
- **Review focus:** invoiceDate (not finalizedAt) for invoiced-$; credits netted; presets compute correct windows.

## Task 8 — E2E flows + docs

**Goal:** prove the flows in the real app and update the docs as part of the work.

- **Playwright** (dev server + DEV db `erp`): open a report, apply a filter, export to Excel (assert the download); open the scoreboard, switch presets. Add to the E2E suite.
- **Docs:** update `docs/HANDOFF.md` (8A gates/state) and, if 8A introduces a convention worth pinning (the `reports` area going live + the reusable report shape), a curated CLAUDE.md line — no counts. (The larger CLAUDE.md architecture notes — `practiceMode()`, the order gate — belong to 8B/8C.)
- **Gates:** full chain green (vitest, tsc, eslint, build, E2E) — rows written after watching each run end.

---

## Sequencing & parallelism

Task 0 first (unblocks everything). Tasks 1–5 (the five reports) are **independent** once the skeleton exists and can be built in parallel by separate subagents; Task 6 is trivial and can ride with any. Task 7 (scoreboard) reuses Task 2's shipped aggregation, so it follows Task 2. Task 8 (E2E + docs) is last. Per-task reviews run as each task completes (pipeline: implement → review → fix), not batched.

## Definition of done (8A)

All eight tasks task-approved; the whole-branch review clean on correctness/concurrency/data-integrity (reports are pure reads — the concurrency surface is minimal, but the reconciliation identities and the date-basis edges are where correctness lives); gates green (vitest, tsc, eslint, build, E2E — verified from the runs' own output, controller re-runs before any merge claim); the reconciliation test (Sales == GL revenue) and the report date-basis tests all passing; docs updated. PR to `main`, squash, attribution in the body.

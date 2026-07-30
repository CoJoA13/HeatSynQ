# Phase 2 Kickoff Brief — Master Data

**Written:** 2026-07-30, by the session that built Phase 1, to carry forward context that lives nowhere else. Read `docs/HANDOFF.md` first. This brief is the input to the detailed Phase 2 plan (superpowers:writing-plans) — it is NOT the plan itself; the plan supplies bite-sized TDD tasks with complete code, following Phase 1's conventions (handoff §5).

**Phase 2 goal (roadmap):** the owner can key in their real customers, parts, process masters, and reference data — with quick-entry grids, Excel export, full audit, and permission gating. Testable outcome: an afternoon of real data entry works and everything shows in the audit trail.

---

## 1. Pre-work — "Task 0" items (do these BEFORE new features; they reshape patterns Phase 2 repeats)

1. **Auth-context refactor**: `handle()` resolves the session user once and stashes it (extend the existing `AsyncLocalStorage` actor context in `src/server/context.ts`); `requireUser` reads the stash; `/api/auth/me` reuses `resolve()`/`can()` from permissions instead of hand-rolled math. Kills the double session-lookup + double sliding-expiry write per request.
2. **Extract `HttpError`** to `src/server/errors.ts` (update all imports) — breaks the `settings → http → sessions → settings` cycle.
3. **Prisma error-hygiene helper** (e.g. `src/server/db-errors.ts`): wrap service mutations so P2002 → `HttpError(400, "<thing> already exists")` and P2025 → `HttpError(404, ...)`. Retrofit to roles/users services (fixes the createUser duplicate race, renameRole soft-deleted-name edge, bogus-id 500s), then use everywhere in Phase 2.
4. **`settings.ts` audit values through `redact()`** (one line each side).
5. **dotenv quiet** in `tests/helpers/setup.ts` (pristine test output).

## 2. Entities and binding rules

Everything below is soft-delete + active-flag + audited (extend `AuditableModel` and, where relations are mutated through a parent, `SNAPSHOT_INCLUDE`). Child entities that get their own CRUD (addresses, contacts, price breaks, steps) are audited as their own models — cleaner history than giant parent snapshots.

### 2.1 Customer
- Fields: name (required), active; credit limit (nullable decimal), **credit hold** (bool), COD (bool), taxable (bool), terms (ref), default PO text; standing instruction/note fields that later surface at order entry, shipping, and invoicing (model now as three text columns: `orderNotes`, `shippingNotes`, `invoiceNotes`); surcharge opt-out (bool) and finance-charge override rate (nullable) — consumed in Phase 5, modeled now to avoid migration churn.
- **Typed addresses**, many per customer: kind SHIP_TO | BILL_TO | RECEIVED_FROM, name/street/city/state/zip, one default per kind.
- **Contacts**, many: name, email, phone, and per-document-type flags (gets shippers / gets invoices / gets statements / gets certs) — consumed by Phases 4–5 emailing; cheap booleans now.
- Single plant — plain ids, no compound keys (spec decision; Visual Shop's Plant+Cust key is deliberately NOT carried over).
- Credit hold's enforcement (blocks order entry + shipping) is Phase 3/4 behavior — Phase 2 only stores it.

### 2.2 Reference tables (Plant-Support equivalents — deliberately flat and simple)
- **Operation** (Visual Shop "process code"): code (unique), name, **GL account (required text)** — Phase 5 posts by it; optional equipment/department informational tag. This replaces Visual Shop's 4-dimension Table Keys lattice — do not rebuild that lattice (spec §3).
- **Material**, **Inspection code** (+ optional default scale), **Inspection scale**, **Container type**, **Carrier**, **Terms**, **Payment type (with GL account)**, **Salesperson**, **Comment snippet** (name + text block, reusable in step text later), **Specification** (name/text).
- All: name + active + audit. No behavior beyond being pick-lists yet.

### 2.3 Part (memorized) — the heart of Phase 2
- Belongs to one customer. **Part number required; unique per customer** (matches Visual Shop's part+customer identity; flag at the owner demo to confirm).
- **Each-weight required** (owner decision — order entry computes total weight); name/description optional; material (ref); **process master required** (generic only — assembly masters are out of scope permanently).
- **Load quantity and/or load weight** (nullable) — Phase 3 auto-splits orders into loads from these (1,000 pcs @ 300/load → 300/300/300/100). Not enforced against anything in Phase 2.
- **Inspection requirements**: child rows (inspection code, scale, min, max) — these are what print on certs in Phase 4. A table, not Visual Shop's fixed 1–10 slots.
- **Pricing** (modeled now, resolution engine is Phase 5): setup charge, unit price, minimum charge; **price-per enum EACH | LB | PER_100 | PER_1000 | LOT**; quantity-or-weight **break rows** (threshold + price). Price edits gated by the existing `change_prices` special action.
- **Owner-defined custom fields**: a `PartFieldDef` table (name, type TEXT|NUMBER|DATE|CHECKBOX, active, sort) + values per part. This replaces Visual Shop's fixed user0–160/s_user/cb_user banks with something the owner controls. Admin UI for defs; part page renders them dynamically.
- Attachments/photos: **defer file storage to Phase 3** (order attachments arrive there; build one attachment story once). Note it in the plan's non-goals.
- Quote linkage: **cannot exist yet** — quotes are Phase 6. The spec's "ideally an active quote, auto-linked" lands there. Leave no dangling columns.

### 2.4 Process master + step library — the design-sensitive part

Invariants (from spec §5.1 and the Visual Shop failure this design exists to fix — shared steps edited live silently rewrote in-flight orders):

1. A master has: id/name, material (ref), default inspection requirements (same shape as part's), status active/inactive, and an ordered list of **steps** (operation ref + instruction text).
2. **Revisions are immutable.** Saving a change to steps/content creates revision N+1; prior revisions remain readable forever. Parts reference the *master*; Phase 3 orders snapshot *master + revision number* at order save. Cert-template default assignment arrives in Phase 4 — leave a nullable text column or nothing; do not build cert coupling now.
3. **Step library = reusable step texts that are COPIED into a revision when used** (copy-on-write). Editing a library entry never touches any master revision that used it. Library entries: operation ref + title + instruction text + active.
4. Per-part step overrides (replace/extend a step's text for one part without cloning the master) are **Phase 3 scope** (they matter at order/traveler time) — Phase 2 models masters + library only. State this in the plan's non-goals so nobody builds it twice.
5. Renaming a master is allowed (id stable); revision history preserves everything (this is what makes rename safe — a lesson from the Visual Shop findings).

### 2.5 UI
- Left-nav pages now go live: **Customers, Parts, Processes** (list + detail/edit), plus reference-table maintenance under a "Plant data" or similar grouping (planner's call; keep it one obvious place, permission-gated by area).
- Lists: search-as-you-type, column sort, active-only toggle, **Excel export** (spec §6 says every list exports — pick a maintained xlsx lib server-side, e.g. exceljs; endpoint per list; CSV is not what the spec promised).
- **Quick-entry grids** (spec §13): paste rows from a spreadsheet (TSV via textarea or paste event) into a validating grid → bulk create with per-row error reporting. Deliver for customers, parts, and each reference table. This is the difference between "keying masters is a sitting" and "a project" — it is a headline Phase 2 feature, not a stretch goal.
- Detail pages include the existing `HistoryPanel` (entity, id) — it was built to be dropped in.
- Pages stay client components calling guarded APIs (Phase 1 pattern) — or if any page goes server-rendered, it must call `requireUser` itself (middleware is cookie-presence only).

## 3. Suggested task decomposition (planner refines; keep tasks independently testable)

0. Pre-work items 1–5 (one or two tasks).
1. Reference-table schema + generic reference service/routes/UI (one pattern, many tables).
2. Customer schema (+ addresses + contacts) + service + tests.
3. Customer routes + pages (list/detail/edit incl. addresses/contacts).
4. Part field-def admin (schema/service/UI).
5. Part schema (+ inspection reqs + pricing + breaks + custom values) + service + tests.
6. Part routes + pages.
7. Step library (schema/service/UI).
8. Process master + revisions (schema/service — the immutability/copy-on-write rules get the densest tests).
9. Process master routes + pages (incl. revision history view).
10. Quick-entry grid component + per-entity wiring.
11. Excel export endpoint pattern + per-list wiring.
12. Permissions/audit sweep test (every new route 401/403-tested; every mutation audited — write the meta-test that greps/exercises this) + owner-demo checklist.

## 4. Definition of done
- Owner can key (and paste) real customers, parts with pricing/inspections/custom fields, reference data, a step library, and revisioned process masters.
- Every list exports to Excel; every mutation is in the audit trail with a meaningful diff; every route is permission-gated with 401 AND 403 tests.
- Suite well north of 100 tests, `tsc --noEmit` and eslint clean, README updated if setup changed.
- Demo script for the owner at the end of the phase (like Phase 1's completion checklist).

## 5. Things Phase 2 must NOT build (scope fences)
Order entry/board, loads, travelers/PDFs, barcodes (P3); certs, shipping (P4); pricing *resolution*, surcharge *application*, invoicing, A/R, QBO (P5); quotes (P6); template designer (P7); reports beyond list exports, practice DB, comparison scoreboard (P8); anything in spec §3's out-list (scheduling, tracking, assembly masters, CAR, order duplication…).

## 6. Open questions for the owner (ask during Phase 2, none block its start)
1. Confirm part-number uniqueness **per customer** (two customers may share a part number; one customer may not).
2. Which custom part fields do they actually want on day one (names/types) — seeds the PartFieldDef demo.
3. The spec §14 items (document samples, report list, GL accounts, FC treatment) — GL accounts become live the moment operations are keyed, so chase the GL list early in Phase 2.

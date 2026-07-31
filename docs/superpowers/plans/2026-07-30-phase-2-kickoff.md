# Phase 2 Kickoff Brief — Master Data

**Written:** 2026-07-30, by the session that built Phase 1, to carry forward context that lives nowhere else. Read `docs/HANDOFF.md` first. This brief is the input to the detailed Phase 2 plan (superpowers:writing-plans) — it is NOT the plan itself; the plan supplies bite-sized TDD tasks with complete code, following Phase 1's conventions (handoff §5).

**Phase 2 goal (roadmap):** the owner can key in their real customers, parts, per-part Process Steps, and reference data — with quick-entry grids, Excel export, full audit, and permission gating. Testable outcome: an afternoon of real data entry works and everything shows in the audit trail.

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
- **GL account** (owner decision 2026-07-30, see §6.3): its own reference table — account number (unique), description, active. Operations, payment types, and surcharges (Phase 5) hold a **nullable reference** to it, never a free-text string. Renumbering the chart of accounts happens in one place; entry is a pick-list so typos cannot reach the Phase 5 QBO export.
- **Process Step Code** (Visual Shop "process code"; called "Operation" in earlier drafts — **renamed by the owner 2026-07-30**): code (unique), name, **nullable GL account reference** — Phase 5 posts by it; optional equipment/department informational tag. GL is **optional at entry** so codes can be keyed before the accounting list exists; lists and detail pages must surface a visible "needs GL account" state, and Phase 5 must refuse to export rather than post a code with no account. This replaces Visual Shop's 4-dimension Table Keys lattice — do not rebuild that lattice (spec §3).
  - **Each code defines the fields a step of its kind exposes** (owner decision 2026-07-30): child rows of (label, type NUMBER|TEXT|DATE|CHECKBOX, optional unit, sort, active). Austenitize → temperature / time / carbon potential; Hot Wash → none. Same owner-controlled pattern as `PartFieldDef`. The point is the traveler: a typed temperature prints in a fixed place and cannot be quietly omitted.
- **Material**, **Inspection code** (+ optional default scale), **Inspection scale**, **Container type**, **Carrier**, **Terms**, **Payment type** (nullable GL account reference), **Salesperson**, **Comment snippet** (name + text block, reusable in step text later), **Specification** (name/text).
- All: name + active + audit. No behavior beyond being pick-lists yet.

### 2.3 Part (memorized) — the heart of Phase 2
- Belongs to one customer. **Part number required; unique per customer** — confirmed by the owner 2026-07-30. Unique constraint is `(customerId, partNumber)`; there is deliberately **no global unique index** on part number.
- **The same part number legitimately recurs across customers, with a different recipe** (owner, 2026-07-30): work moves when a customer's own customer finds a cheaper source, so part `12345` may leave Customer A and appear at Customer B — and **the chemistry can require a different recipe**. Rarely simultaneous, but the records coexist forever because history must resolve. Binding consequences, to be built as tested rules rather than UI intentions:
  - **A part number alone must never identify a part.** Customer is displayed at every selection point — global search results, order-entry autocomplete, quick-entry paste validation, part pickers.
  - **Never infer process steps, material, or pricing across customers from a matching part number.** No silent default, no pre-fill, and (per the 2026-07-30 decision) **no copy-from-another-part mechanic at all** — the only load source is a blank template. A wrong recipe is a mis-processed heat treat, not a data-entry annoyance.
  - The losing customer's part is **deactivated, never deleted** — its orders and certs must still resolve.
- **Each-weight required** (owner decision — order entry computes total weight); name/description optional; material (ref); **its own revisioned Process Steps required** (§2.4 — assembly recipes are out of scope permanently).
- **Specifications: many per part** (owner, 2026-07-30) — link to the `Specification` reference table, not free text. A part can carry a customer spec *and* an industry standard; rare but real. **Specs sit on the part, never on the process**: the same recipe yields ASTM grade 1, 2, or 3 depending on the customer's base iron (ductile iron), so the achieved grade is a property of the part. *(This link was missing from earlier drafts of this brief although spec §5.1 requires it.)*
- **Load quantity and/or load weight** (nullable) — Phase 3 auto-splits orders into loads from these (1,000 pcs @ 300/load → 300/300/300/100). Not enforced against anything in Phase 2.
- **Inspection requirements**: child rows (inspection code, scale, min, max, **+ optional freeform location/notes** — e.g. "Brinell @ flange OD"; owner 2026-07-30, since some customers demand that specificity and free text avoids forcing structure on the majority that don't) — these are what print on certs in Phase 4. A table, not Visual Shop's fixed 1–10 slots.
- **Pricing** (modeled now, resolution engine is Phase 5): setup charge, unit price, minimum charge; **price-per enum EACH | LB | PER_100 | PER_1000 | LOT**; quantity-or-weight **break rows** (threshold + price). Price edits gated by the existing `change_prices` special action.
- **Owner-defined custom fields**: a `PartFieldDef` table (name, type TEXT|NUMBER|DATE|CHECKBOX, active, sort) + values per part. This replaces Visual Shop's fixed user0–160/s_user/cb_user banks with something the owner controls. Admin UI for defs; part page renders them dynamically.
- Attachments/photos: **defer file storage to Phase 3** (order attachments arrive there; build one attachment story once). Note it in the plan's non-goals.
- Quote linkage: **cannot exist yet** — quotes are Phase 6. The spec's "ideally an active quote, auto-linked" lands there. Leave no dangling columns.

### 2.4 Process Steps — the design-sensitive part

> **Rewritten 2026-07-30.** Shared process masters are **removed** — see spec §15 amendments and the full model with diagrams in `docs/2026-07-30-process-steps-model.md`. Why: nearly every step varies part to part (racking *always*; test type and location *always*; temper time/temp; austenitize time/temp/carbon potential; pre-heat often — only receiving is fixed, and wash is yes/no), so a shared master would be an empty shell overridden everywhere, and per-part overrides would be the normal path rather than the exception. The single benefit of sharing — propagate one edit to many parts — is one this shop would never dare use, since outcome depends on the customer's base chemistry.

**The recipe belongs to the part.** What is shared is the *vocabulary* and *blank skeletons*.

1. **Process Step Code** (§2.2) is the shared, billable reference vocabulary and carries the GL account. Every step names one. This is what keeps billing consistent across parts that share nothing else.
2. **A part owns an ordered list of Process Steps**, each = step code + this part's free instruction text + values for whatever fields that code defines. Required before the part is orderable.
3. **Revisions are immutable.** Editing creates revision N+1; prior revisions remain readable forever. Phase 3 orders snapshot **part + revision number** at order save, so a traveler reprints identically years later. The Visual Shop defect is now structurally impossible — there is nothing shared left to break — rather than merely prevented by a rule.
4. **Template** = a named, shop-built, **blank** skeleton: ordered step codes + optional boilerplate text, **no values**. "Load Template" → dropdown → fills the step structure with empty fields for the user to complete. Owner-configurable so each shop builds its own (Austemper, Neutral Harden, …).
5. **There is deliberately no copy-from-another-part.** The only load source is a blank template. Copying values is how one customer's chemistry silently becomes another's.
6. **Per-part step overrides no longer exist** — deleted from Phase 3 scope, not deferred. The recipe is already per-part. Remove this from any inherited task list.
7. The **step library is gone**, replaced by templates. No copy-on-write semantics to build or explain.
8. Cert-template default assignment arrives in Phase 4 — leave a nullable column or nothing; do not build cert coupling now.

**Open detail for the planner (not an owner question):** when a new revision is cut. Cutting one per save would churn during initial part setup. Sensible default — amend the current revision until it has been consumed by an order, then the next edit starts N+1. Whatever the planner picks, test it.

### 2.5 UI
- Left-nav pages now go live: **Customers, Parts, Processes** (list + detail/edit), plus reference-table maintenance under a "Plant data" or similar grouping (planner's call; keep it one obvious place, permission-gated by area).
- Lists: search-as-you-type, column sort, active-only toggle, **Excel export** (spec §6 says every list exports — pick a maintained xlsx lib server-side, e.g. exceljs; endpoint per list; CSV is not what the spec promised).
- **Quick-entry grids** (spec §13): paste rows from a spreadsheet (TSV via textarea or paste event) into a validating grid → bulk create with per-row error reporting. Deliver for customers, parts, and each reference table. This is the difference between "keying masters is a sitting" and "a project" — it is a headline Phase 2 feature, not a stretch goal.
- Detail pages include the existing `HistoryPanel` (entity, id) — it was built to be dropped in.
- Pages stay client components calling guarded APIs (Phase 1 pattern) — or if any page goes server-rendered, it must call `requireUser` itself (middleware is cookie-presence only).

## 3. Suggested task decomposition (planner refines; keep tasks independently testable)

*Updated 2026-07-30 for the Process Steps model — old tasks 7–9 (step library, process master, master pages) are replaced by 7–9 below.*

0. Pre-work items 1–5 (one or two tasks).
1. Reference-table schema + generic reference service/routes/UI (one pattern, many tables) — **includes the new GL Account table**.
2. **Process Step Code + its field definitions** (schema/service/UI) — richer than the other reference tables, so give it its own task.
3. Customer schema (+ addresses + contacts) + service + tests.
4. Customer routes + pages (list/detail/edit incl. addresses/contacts).
5. Part field-def admin (schema/service/UI).
6. Part schema (+ specs link, inspection reqs incl. location, pricing, breaks, custom values) + service + tests.
7. Part routes + pages.
8. **Part Process Steps + revisions** (schema/service — immutability and the revision-cut rule get the densest tests in the phase).
9. **Templates** (schema/service/UI) + the "Load Template" action — assert by test that loading carries **structure only, never values**.
10. **Process Steps designer UI** on the part page (reorder, add/remove, per-code fields render dynamically) + revision history view.
11. Quick-entry grid component + per-entity wiring.
12. Excel export endpoint pattern + per-list wiring.
13. Permissions/audit sweep test (every new route 401/403-tested; every mutation audited — write the meta-test that greps/exercises this) + owner-demo checklist.

## 4. Definition of done
- Owner can key (and paste) real customers, parts with pricing/inspections/specs/custom fields, reference data, shop-built templates, and per-part revisioned Process Steps.
- Every list exports to Excel; every mutation is in the audit trail with a meaningful diff; every route is permission-gated with 401 AND 403 tests.
- Suite well north of 100 tests, `tsc --noEmit` and eslint clean, README updated if setup changed.
- Demo script for the owner at the end of the phase (like Phase 1's completion checklist).

## 5. Things Phase 2 must NOT build (scope fences)
Order entry/board, loads, travelers/PDFs, barcodes (P3); certs, shipping (P4); pricing *resolution*, surcharge *application*, invoicing, A/R, QBO (P5); quotes (P6); document template designer (P7 — unrelated to Phase 2's process-step Templates); reports beyond list exports, practice DB, comparison scoreboard (P8); anything in spec §3's out-list (scheduling, tracking, assembly recipes, CAR, order duplication…).

Also **not built, by decision rather than deferral** (2026-07-30): shared process masters, the step library, per-part step overrides, and any copy-a-recipe-from-another-part mechanic. These were removed from the design, not postponed — do not reintroduce them in a later phase without a fresh owner decision.

## 6. Open questions for the owner (ask during Phase 2, none block its start)

1. ~~Confirm part-number uniqueness **per customer**.~~ **Answered 2026-07-30: yes, unique per customer, not globally.** Multiple customers may carry the same part number — work migrates between them when a customer's own customer finds a cheaper source, and the chemistry may require a different recipe. See §2.3 for the constraints this binds.
2. ~~Which custom part fields on day one?~~ **Answered 2026-07-30: customer drawing number and revision level** (both TEXT). Two candidates were rejected on the reasoning in §2.3/§2.4 — *heat treat spec* became a `Specification` reference link (many per part) rather than a custom field, and *serialization required* is pending: it is a real column if Phase 3 order entry validates against it, a custom field if it is only a note a human reads. **Planner: flag this one to the owner before the part schema task.** Legacy Visual Shop part ID was suggested as a cheap parallel-run cross-reference — owner has not ruled on it.
3. ~~GL accounts become live the moment operations are keyed.~~ **Answered 2026-07-30: GL accounts get their own maintained reference table, and the account is optional when keying a Process Step Code** — "configurable and not set in stone." This de-blocks Phase 2: codes can be entered before the accounting list exists. See §2.2. Still open from spec §14: the actual account list (needed before Phase 5, not before Phase 2), document samples, the go-to report list, and finance-charge treatment in the QBO export.
4. **Carried from Phase 2A by owner decision (2026-07-30) — build this in 2B.** Reference columns that hold a foreign key currently render, export, and accept a **raw cuid**: `inspectionCode.defaultScaleId` and `paymentType.glAccountId` show `cms7xo30a0004ijdl…` on screen and in Excel, and paste for those two kinds requires typing a cuid, so it is unusable for them. Phase 2A's final review argued for fixing it before merge; the owner ruled **defer**, on the grounds that 2B must build the same name-resolution for customers and parts anyway, and both affected tables are small enough to key by hand in the UI meanwhile.

   What 2B owes: `listReference` resolves the related row's `name` for display, the Excel export writes that name rather than the id, and create/paste accept a **name** and look the id up — erroring clearly when the name is unknown. Build it as the general mechanism customers and parts will reuse, not a special case for two kinds.

5. **Open (raised 2026-07-30, does not block).** Cross-part queries on step parameters — "which parts austenitize above 1600°F?" The typed per-code fields make this *possible*; nothing in Phase 2 builds the query UI. Worth confirming whether the owner wants it before Phase 8's report set is scoped.

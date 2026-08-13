# Task 16 report — Templates admin: list, lifecycle UI, version history, nav

**Branch:** `phase-7-template-designer` · the first real template-designer SCREEN (the editor is
Tasks 17–18; this task links to it with a stub). All server-side lifecycle, assignment and
resolution already existed (Tasks 1–15); this task is the admin surface + the Shell nav entry.

## THE NAV DECISION — Option B (Templates under Admin, gated on `templates.view`)

**Chosen: (B).** Templates is an **admin-group** entry, not a top-level nav entry, but — unlike
every other admin entry — it is gated on **`templates.view` specifically**, not on `admin.view`.
The Admin group header renders whenever **any** admin-group entry is visible
(`visibleAdmin(perms).length > 0`).

Why B over A (a top-level "Templates" beside Orders/Customers):

- **Spec §5.5 is explicit:** "One admin surface … **under the existing admin area UI**, gated on
  the `templates` area." A top-level entry would contradict "under the existing admin area UI";
  gating it on the `templates` area is exactly B.
- **Both correctness constraints hold under B:**
  - a `templates.view`-only user (no `admin.view`) sees an Admin group containing **just**
    Templates, and so reaches `/admin/templates` — the §5.15 silent-dead-end rule;
  - an `admin.view`-only user **without** `templates` sees the other admin entries but **not**
    Templates (it is a different area).
- The gating is a pure filter over each entry's own `area`, so it generalizes (no `admin.view ||
  templates.view` special-case sprinkled through the render).

**Implementation:** `NAV`/`ADMIN` + the decision moved out of `Shell.tsx` into a pure client-safe
`src/lib/nav.ts` (the `permission-ui.ts` precedent) so the gating is unit-testable without
rendering React. `Shell.tsx` now renders `visibleNav(me.permissions)` and, for the Admin group,
`visibleAdmin(me.permissions)` (header shown iff non-empty). **The nav is never the gate** — the
page's data all comes from `/api/templates`, which does `mustCan(requireUser(), "templates",
"view")` itself (Task 4; the 403-without-`templates.view` case is already pinned by
`tests/template-routes.test.ts:86`).

`tests/nav.test.ts` pins the decision directly: `templates.view`-only → `["Templates"]` under
Admin; `admin.view`-only → admin entries **without** Templates; neither → empty (header hides);
`visibleNav(["templates.view"]) === []` (Templates is NOT top-level).

## The list + lifecycle UI (`/admin/templates`, a client component — the house pattern)

Matches the surcharges/step-codes admin pattern (client component hitting the guarded API,
`usePermissions` + `gate`/`gateDo`, list + detail split, `BlockerPanel` from the refusal).

- **List:** the 8 docTypes in spec order (headers from `contractFor(dt).name` — the single source
  of truth, so no drift), each with its templates, the **default starred** (`★`,
  `aria-label="default"`), per-template published/draft badges and the **live assignment count**.
- **Create:** a docType picker + name, POSTs `/api/templates` (which opens the v1 draft in one
  act), then selects the new template. **§5.16:** disabled-with-reason on `templates.create`.
- **Lifecycle** (chosen layout: a per-template **detail pane** beside the list — the surcharges
  shape — rather than inline-per-row, because version history + the delete blocker panel need
  room): open-draft / discard-draft / **publish** (behind `edit_templates` — the tooltip names
  whichever of `templates.edit`/`edit_templates` is missing, the PricingSection "whichever is the
  blocker" rule) / **set-default** (also `edit_templates`; hidden when already default, disabled
  with a reason when never published). Rename behind `templates.edit`.
- **Version history:** newest-first table, each PUBLISHED version offering **"open draft from this
  version"** (`openDraft({fromVersion})`, the §5.1 revert flow), disabled while a draft is open.
- **Reasoned delete (§5.17):** a reason prompt (the customers/roles idiom; the service enforces it
  too), and on a 400 the §5.14 **blocker list** (the assigned customers, linked to their pages) via
  a new `GET /api/templates/[id]/blockers` route, rendered in `BlockerPanel` with the Excel export.
- **Editor:** a stub `Link` to `/admin/templates/[id]/edit` (Tasks 17–18).

## The two carried Task-4 minors

- **(a) `getTemplate` torn read — FIXED.** The detail pane renders the version history *and* the
  draft-vs-published state together, so it can show the torn state (a publish committing between
  the two autocommit reads leaves history listing a version as DRAFT while the draft read returns
  null). Wrapped both reads in one **RepeatableRead** `$transaction` (the `aging.ts` precedent) so
  they see one snapshot. A plain Read Committed `$transaction` would **not** fix it — each statement
  gets a fresh snapshot; RepeatableRead pins one. Read-only, no lock, no retry.
- **(b) Blocker export from the refusal only — DONE.** The `/blockers/export` workbook (and the new
  `/blockers` JSON list) are reachable **only** from the delete-refusal `BlockerPanel`, never as a
  standalone control.

## Tests / RED evidence

- **`tests/nav.test.ts` (7 tests) — TDD RED first:** written against `@/lib/nav` before it existed
  → `Error: Cannot find module '@/lib/nav'`. GREEN after creating the module. Pins both nav-decision
  directions (`templates.view`-only and `admin.view`-only) and that Templates is not top-level.
- **Route/page auth:** the page is a client component, so its `templates.view` enforcement is the
  guarded `/api/templates` (403 without `templates.view` already pinned by
  `tests/template-routes.test.ts`). No duplication added.
- **`getTemplate` isolation:** a pure hardening with no observable single-threaded change (the
  torn read needs a concurrent publish between two statements, not deterministically forceable), so
  no new unit test — the existing `templates.test.ts` getTemplate assertions stay green, and the
  change follows the tested `aging.ts` precedent. Verified live in the browser (the detail pane
  renders the v1 PUBLISHED-current history + draft state correctly).
- **E2E:** the new `templates-admin` flow exercises the screen end to end (below).

## Gates (five, watched, real numbers — final HEAD `2ee7b5f`)

| Gate | Result |
|------|--------|
| vitest (full, `erp_test`) | **2675/2675, 145 files** (261.3s; +7 nav tests / +1 file over Task 15's 2668/144) |
| tsc `--noEmit` | PASS (exit 0) |
| eslint `src tests` | PASS (exit 0) |
| E2E (`npm run test:e2e`, `erp` dev DB) | **20/20 PASS, EXIT:0** (detached, sentinel `e2e-task16-run2.done`; the new 20th flow `templates-admin` + all 19 existing; "All 20 flows passed" + "cleanup ok"). **Run 1 FAILED 19/20** — see below. |
| build (`npm run build`) | PASS (exit 0; run after E2E, shared `.next`) |

Dev-DB fixture hygiene verified after run 2: 0 leftover `E2E Doc Template` / `e2e_*` users / `E2E*`
customers; the 8 seeded templates all present, live, and default.

### E2E run 1 failure (honest record) — a flow race, not a screen bug

Run 1 failed 19/20: `templates-admin.mjs` asserted "8 starred defaults" and got **0**. Root cause:
the list rows come from a **client-side `GET /api/templates`** (a `useEffect` fetch), which lands
**after** the static heading — and on the 20th flow `next dev` compiles the route on first hit,
widening that gap to seconds. `locator.count()` does **not** auto-wait, so it counted against a
not-yet-loaded list. **The screen was correct throughout** — verified live in the browser (8 stars,
`aria-label="default"`) and against the dev DB (8 `isDefault` rows). Fix (`2ee7b5f`): wait for a
starred default (and, in the restricted section, a Standard row) to be **visible** before counting.
Run 2 with the fix: **20/20, EXIT:0**.

Browser-verified live (admin/admin against the dev DB): the page renders all 8 docType groups with
Standard starred + Published v1 + 0 assigned, the create picker offers all 8 types, and selecting a
template renders the detail pane (Delete/Rename/Open-draft + the version-history table with "v1
PUBLISHED (current) · Open draft from this version"). The nav shows the Admin group with the
Templates entry.

## Deviations / notes

- **New route added (in scope):** `GET /api/templates/[id]/blockers` (JSON list) — Task 4 built
  only the xlsx export; the linked blocker list the brief requires needs a JSON read. Mirrors the
  surcharge blockers-list route; gated on `templates.view`, no `includeModel` (the template panel
  has no in-place "clear" escape hatch — that is Task 20's customer-page picker).
- **No CLAUDE.md / spec §15 change:** the nav decision is a task-level UI choice, and the
  `getTemplate` isolation is a small hardening — neither alters a binding convention or the spec
  contract. Recorded here and in the ledger; HANDOFF §4 carries the build-state update.
- **E2E fixtures:** the restricted role gains `templates.view` (it is the designated view-only
  user); the flow creates one fully-owned `DocumentTemplate` reaped by name
  (`deleteDocumentTemplatesByName`, called from both `cleanup()` and `reapLeftovers()`); no
  seeded/shared state is mutated (never sets a default, never assigns).

## Notes for Task 17 (the editor panels + logo)

- The stub link target is `/admin/templates/[id]/edit`. The list page selects the template after
  create and exposes "Edit draft" (when a draft is open) — the editor lands on that route.
- The editor reads the draft config from `GET /api/templates/[id]` (`detail.draft` carries the
  config) and saves via `PATCH /api/templates/[id]/draft` with the `updatedAt` precondition (the
  409 concurrency contract is Task 18's UX).
- **Carried from Task 1's review → Task 17:** `lockedElements` returns a flat `{key, reason}` list
  mixing section and field keys — tighten the namespace before rendering padlocks (§5.6).
- The editor renders from the contract (`contractFor(docType)`), which the list page already
  imports client-side — the client-safe boundary holds.

# Task 16 brief — Templates admin: list, lifecycle UI, version history, nav

**Branch:** `phase-7-template-designer` (Tasks 1–15 APPROVED; the whole template service + assignment/resolution exist; suite at 2668; E2E 19/19). First real template-designer screen.
**Read first:** the spec §5.5 (the admin surface — list + editor; this task is the LIST + lifecycle, the editor is Tasks 17–18) + §7 (permissions: `templates` area CRUD; `edit_templates` special on publish/set-default/assign) + §5.16 (disabled-with-reason) + §5.14 (blocked-delete names blockers + Excel export); the plan Task 16; **Task 4's report + the ledger's carried Task-4 minors** (both are YOURS: (a) `getTemplate` is two autocommit reads — wrap in one `$transaction` if this UI's version-history view can show a torn state; (b) the blockers-export route returns an empty workbook for an unknown/deleted id — link it ONLY from the §5.14 delete-refusal, never as a standalone button); **Task 15's report** (Shell nav is Step 1). Then `erp/src/components/Shell.tsx` (the `ADMIN` array + the `canView("admin")` group gate — the nav decision below), the template service `erp/src/server/templates.ts` (the reads/mutations this UI calls), an existing admin list page for the house pattern (e.g. `erp/src/app/admin/surcharges/` or `/step-codes/`), and the shared permission-gating helper the parts/customer pages use (`me.permissions.includes(...)` — §5.16).

## The nav decision (plan pre-delegated it to you — MAKE it and RECORD it)

The Admin group in `Shell.tsx` hides entirely unless `admin.view`, and its entries carry no per-entry gate. The `templates` area is DISTINCT from `admin` — so a user granted `templates.view` but not `admin.view` must still reach the templates screen (the §5.15 silent-dead-end rule, and §5.16). Choose ONE and justify in the report:
- **(A)** a top-level NAV entry "Templates" gated on `templates.view` (alongside Orders/Customers/Reports), OR
- **(B)** keep it visually under Admin but gate the entry on `templates.view` specifically AND show the Admin group header when ANY admin-group entry is visible (admin.view OR templates.view).
Constraint that decides correctness either way: a `templates.view`-only user sees a working path to `/admin/templates`; an `admin.view`-only user without `templates` does NOT see the Templates entry (it's a different area). Whatever you pick, the route/page still enforces `requireUser` + `mustCan(user, "templates", "view")` itself — the nav is not the gate.

## Deliverable — `erp/src/app/admin/templates/**` + `Shell.tsx`

Server-rendered page (or client component hitting guarded APIs — match the house pattern) that **calls `requireUser` + `mustCan(templates.view)` itself** (the proxy doesn't authorize; §5-conventions item 8).

1. **List page** (`/admin/templates`): the 8 docTypes, each with its templates (the default starred), a live-assignment count per template, and create/rename. Create opens a template + its v1 draft (the Task 4 service does this in one act) — after create, the natural next step is the editor (Task 17), so link there (a stub link is fine; the editor lands next task). §5.16: create/rename/delete controls disabled-with-reason (`templates.create`/`.edit`/`.delete`), each naming the missing permission.
2. **Lifecycle UI** (on the list page or a per-template detail — your call, record it): open-draft / discard-draft / **publish** (publish behind `edit_templates` — §5.16 tooltip when the special is missing) / **set-default** (also `edit_templates`); **version history** with "open draft from version N" (the Task 4 `openDraft({fromVersion})` parameter); **reasoned delete** — the reason prompt, the §5.14 blocker list (naming the assigned customers, linked) with the Excel export reachable ONLY from that refusal (carried minor b), and the default-delete refusal surfaced.
3. **The two carried Task-4 fixes**: (a) if the version-history view reads `getTemplate` and can show a draft-vs-published torn state, wrap that read in one `$transaction`; (b) wire the blocker export from the refusal only.

## Tests (TDD; RED evidence REQUIRED)

- Route/page auth: the page enforces `templates.view` (a `templates.view`-less session is refused); publish/set-default/delete routes already gated (Task 4) — the UI must not offer them without the permission (§5.16), assert the disabled/tooltip state.
- If you add any server code (a page loader, a torn-read fix), unit-test it; the nav-gating logic (which entries a permission set sees) is unit-testable — test the `templates.view`-only and `admin.view`-only cases.
- Existing suites green.

## Gates — E2E REQUIRED (UI + nav touched)

Four unit gates + full E2E **detached, sentinel `e2e-task16.done`**, `build` after E2E. **The E2E must exercise the new screen** — add a flow (or extend one) that logs in, navigates to `/admin/templates` via the nav entry, sees the 8 types with the Standard default starred, and opens a draft; the permission-gating flow (a `templates.view`-only user reaches it; the nav decision holds). Recall §5a's Playwright traps. Rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-16-report.md`: **the nav decision (A or B) and its justification**; the lifecycle-UI layout choice; the two carried-minor dispositions; RED evidence; all five gates watched; deviations; notes for Task 17 (the editor panels — the contract drives them; the `lockedElements` namespace minor from Task 1's review is Task 17's). Final message: 5-line summary + report path. Update your ledger row.

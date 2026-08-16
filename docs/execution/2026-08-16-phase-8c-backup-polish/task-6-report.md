# Task 6 report — The Backups admin page

Commit: `a7e8ceca60e3abb3a63b0db43e71aebccfa829b5` (branch `phase-8c-backup-polish`)

## What I implemented

**`erp/src/app/admin/backups/page.tsx`** (new) — a `"use client"` page matching the brief's Step 2
code essentially verbatim, with two small style adjustments to match house convention observed in
`src/app/admin/surcharges/page.tsx` and `src/app/admin/settings/page.tsx`:

- `h1` uses `text-2xl font-semibold` (the house size) rather than the brief's `text-xl`.
- Buttons/backgrounds use the `slate` palette (`bg-slate-800`, `bg-slate-100`, `text-slate-600`,
  `disabled:cursor-not-allowed disabled:bg-slate-400`) to match every other admin page's controls,
  and the error banner uses the single-`<p>` `bg-red-50 p-2 text-red-700` shape used by
  Surcharges/Settings/Templates rather than a bordered `<div>`.

Everything else — the `usePermissions()` + `gateDo(permissions, "manage_backups")` gating, the
§5.13 refresh-then-report error handling in `backUpNow`, the health banner (green only on
`state === "ok"`), the archive table, and the "restoring is a terminal command" note — is exactly
as specified. No business logic lives in the page; it renders whatever `GET /api/admin/backups`
returns and the green/red decision is `evaluateHealth`'s (`src/server/backups.ts`), not the page's.

No component test was added for this page, per the brief's explicit call: it's a thin render over
one endpoint, covered by Task 9's E2E flow; the component-test precedent (`tests/practice-banner.test.tsx`)
is earmarked for Task 7's banner instead.

## The nav-model change

`erp/src/lib/nav.ts`:

- `NavEntry` is now a discriminated union: `{ label; href; area; action?: never }` XOR
  `{ label; href; action; area?: never }`. An entry declares exactly one gate.
- Added `canSeeEntry(perms, entry)`: resolves `action.<name>` for an action entry, `<area>.view`
  (via the existing `canViewArea`, kept exported since `tests/nav.test.ts` uses it) for an area
  entry. An absent `perms` array (still loading) resolves to "no grants" on either branch.
- Both `visibleNav` and `visibleAdmin` now filter through `canSeeEntry` instead of calling
  `canViewArea` directly.
- Added `{ label: "Backups", href: "/admin/backups", action: "manage_backups" }` to `ADMIN`, after
  Audit log, with an inline comment explaining the action-gate choice.

**Extended the file's header comment** (the file's design record) with a new paragraph titled
"PHASE 8C ADDENDUM — gating on a special ACTION, not just an area", placed directly under the
existing Task 16/Templates nav-decision paragraph. It states: `manage_backups` is one of the 10
special actions, not one of the 12 permission areas, so `backups.view` doesn't exist and never
will; gating on `admin.view` would repeat the exact §5.15 silent-dead-end mistake the Templates
paragraph above it already documents, just for an action instead of an area; and that's why
`NavEntry` became a discriminated union with `canSeeEntry` as the single resolver both list
builders now share.

**`erp/tests/nav.test.ts`** — added three cases per the brief, placed after the existing Templates
`toEqual` case, matching the file's existing `describe`/`it` style:

- `"shows Backups to a manage_backups holder who has no admin.view"` — `visibleAdmin(["action.manage_backups"])` yields exactly `["/admin/backups"]`.
- `"hides Backups from an admin.view user without manage_backups"` — `admin.view` alone shows Users etc. but not Backups.
- `"hides Backups while permissions are still loading"` — `visibleAdmin(undefined)` never contains `/admin/backups`.

The pre-existing `toEqual({ label: "Templates", href: "/admin/templates", area: "templates" })`
case still passes unmodified — `toEqual` treats the union's absent `action` key as equivalent to
not being present, so the discriminated-union type change didn't require touching that assertion.

## Browser verification

Ran `cd erp && mkdir -p backups` and added `BACKUP_DIR="./backups"` to `erp/.env` (gitignored, not
committed). Started `npm run dev`, logged in as `admin`/`admin`.

**First load surfaced a real, useful finding, not a bug in the page**: `/admin/backups` returned
`GET /api/admin/backups → 403 Forbidden` and the page correctly rendered "You do not have
permission for that" via the folded-in `usePermissions().error`. Root cause: the dev DB's seeded
Admin role predated Tasks 1–5 adding `manage_backups` to `SPECIAL_ACTIONS`, so the existing
`RolePermission` rows didn't include `action.manage_backups` yet. `prisma/seed.ts` grants
`ALL_PERMISSIONS` (which includes every special action) to the Admin role via `upsert` on every
run, so `npm run db:seed` picked up the new grant with no code change needed. This is exactly the
gating working as designed — I did not touch permissions/seed code.

After reseeding:
- Reloaded `/admin/backups`: red "Backups need attention" banner rendered
  (`border-red-300 bg-red-50 text-red-900`), reason text "No readable backup status file was found
  in the backup folder…", "No successful backup on record. · Threshold: 36 hours". Backup folder
  resolved to the absolute path `/home/cojoa13/Desktop/HeatSynQ/erp/backups`. Archive table showed
  "No backup archives in this folder yet." Console clean (no new errors post-reseed); network shows
  `GET /api/admin/backups → 200 OK`.
- Confirmed the "Backups" nav entry appears in the Admin group (verified via DOM query — the
  accessibility-tree read truncated the visible list but the underlying `<a>` elements, including
  Backups, Templates, Audit log, Billing, Surcharges, were all present).
- Clicked **Back up now**. Page updated to green "Backups are up to date"
  (`border-green-300 bg-green-50 text-green-900`), "Last successful backup: 8/16/2026, 2:36:13 AM
  · Threshold: 36 hours". Archive table showed one row:
  `erp_manual_2026-08-16_023612_50c43ebf.sql.gz · On demand · 25 KB · OK`. Network log:
  `POST /api/admin/backups/run → 200 OK` followed by a fresh `GET /api/admin/backups → 200 OK`.
  Console stayed clean through the click.

Cleaned up afterward: removed `erp_manual_2026-08-16_023612_50c43ebf.sql.gz` and
`backup-status.json` from `erp/backups/`, then removed the now-empty `erp/backups/` directory
itself. Stopped the dev server.

## Gate output (exact commands, real output)

```
$ cd erp && npx vitest run tests/nav.test.ts tests/permissions-sweep.test.ts && npx tsc --noEmit && npx eslint src tests

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms
 ✓ tests/nav.test.ts (10 tests) 2ms

 Test Files  2 passed (2)
      Tests  16 passed (16)
   Start at  02:36:41
   Duration  208ms (transform 21ms, setup 11ms, collect 16ms, tests 18ms, environment 0ms, prepare 46ms)
```

`npx tsc --noEmit` produced no output (clean). `npx eslint src tests` produced no output (clean,
zero warnings/errors) — this is the sweep that matters: `permissions-sweep.test.ts`'s "no client
component imports from `src/server/**`" case passed, confirming the new page only imports from
`@/lib/**`.

## Commit

`a7e8ceca60e3abb3a63b0db43e71aebccfa829b5` on `phase-8c-backup-polish`:

```
feat(backups): add the Backups admin page

Adds /admin/backups (Phase 8C Task 6), a thin client render over
GET /api/admin/backups and POST /api/admin/backups/run showing the
health indicator, resolved backup folder, and archive list, gated
throughout on the manage_backups special action via gateDo.

Extends the nav model to gate an entry on a special action as well as
an area: NavEntry becomes a discriminated union (area XOR action),
canSeeEntry resolves either shape, and both visibleNav/visibleAdmin
route through it. Backups has no backups.view and never will, so
gating it on admin.view would leave a manage_backups-only user able
to use the page but unable to find it.
```

Files touched: `erp/src/app/admin/backups/page.tsx` (new), `erp/src/lib/nav.ts`,
`erp/tests/nav.test.ts`. No attribution trailer, conventional-commit style, per repo convention.

## Concerns for the reviewer

- The dev-DB permission gap I hit (Admin role missing `action.manage_backups` until reseeded) is
  not a code defect — it's `prisma/seed.ts` working exactly as designed (upsert grants
  `ALL_PERMISSIONS` idempotently). Any dev/reviewer environment whose DB was seeded before Tasks
  1–5 landed `manage_backups` will hit the same 403 until they run `npm run db:seed` again. Worth
  a one-line callout if Task 9's E2E harness seeds a fresh DB per run (it likely already does, via
  `truncateAll`/migrate+seed, in which case this is a non-issue there).
- I did not add a component test for this page per the brief's explicit instruction (Task 9 E2E +
  Task 7's `tests/practice-banner.test.tsx` precedent cover it instead).

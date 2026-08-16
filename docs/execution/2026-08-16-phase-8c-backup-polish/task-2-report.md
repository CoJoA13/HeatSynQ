# Task 2 report: `manage_backups` action and the `backup_stale_hours` setting

## What I implemented

Exactly the four files specified in the brief:

1. `erp/src/lib/permission-constants.ts` — added `"manage_backups"` to the `SPECIAL_ACTIONS` array,
   with the brief's exact comment (Phase 8C §6.2/§12 item 6 rationale). No edit to
   `src/app/admin/roles/page.tsx` — it renders by mapping over `SPECIAL_ACTIONS`, so the checkbox
   appears automatically.
2. `erp/src/server/settings.ts` — added the `import { DEFAULT_STALE_HOURS } from "@/lib/backup-constants";`
   line, and added `backup_stale_hours: { schema: int(1, 8760), default: DEFAULT_STALE_HOURS, label:
   "Backup staleness threshold (hours)", group: "System" }` directly beside `session_timeout_minutes`
   in the "System" group, with the brief's exact comment.
3. `erp/tests/backup-settings.test.ts` — created verbatim from the brief's Step 1 listing (4 test
   cases: default value, sane override, rejection of 0/-1/1.5/8761, and `manage_backups` membership
   in `SPECIAL_ACTIONS`).
4. `erp/tests/permissions.test.ts` — added the brief's Step 5 case
   (`manage_backups is denied by default and granted by an explicit action grant`) verbatim, using
   the file's existing local `user()` helper. Also fixed the count assertion this task's own change
   invalidates (see below).

## Deviations from the brief

None in the four files' substance — every added block matches the brief's listings verbatim,
comments included. The one addition beyond the brief's explicit listing is the count-assertion fix
in `permissions.test.ts`, which the brief itself calls out as in-scope ("scan the rest of the file
... for any case that enumerates `SPECIAL_ACTIONS` or asserts a count ... update it").

## The permission-count trap (Step 5's warning)

`ALL_PERMISSIONS` grows by one (13 areas × 4 CRUD + one new special action) whenever
`SPECIAL_ACTIONS` grows. I searched the whole tree for both symbols before and after the change:

```
$ cd erp && grep -rn "ALL_PERMISSIONS\|SPECIAL_ACTIONS" tests/ src/
```

Findings, and what happened to each:

- **`tests/permissions.test.ts:46`** — `expect(ALL_PERMISSIONS.length).toBe(13 * 4 + 12);`
  **Hardcoded count. Fixed** to `13 * 4 + 13`, with the comment updated to name Phase 8C's
  `"manage_backups"` addition alongside Phase 5B's `"write_off"`.
- **`tests/demo-seed.test.ts:28`** — `expect(admin!.role!.permissions.length).toBe(ALL_PERMISSIONS.length);`
  Compares against `ALL_PERMISSIONS.length` dynamically (not a literal), and the seed
  (`prisma/demo-seed.ts:300`, `for (const permission of ALL_PERMISSIONS)`) grants every permission in
  the constant to the admin role. **No edit needed** — verified by running the file (see below).
- **`prisma/seed.ts:30`** and **`prisma/demo-seed.ts:300`** — both loop over `ALL_PERMISSIONS`
  dynamically to seed the admin role's grants. No hardcoded list, no edit needed.
- **`src/app/api/auth/me/route.ts`** — filters `ALL_PERMISSIONS` dynamically for the caller's
  effective permission set. No hardcoded list, no edit needed.
- **`tests/permissions-sweep.test.ts`** — does not reference `ALL_PERMISSIONS` or `SPECIAL_ACTIONS`
  at all (it's a structural route/audit sweep, not a permission-count test). No edit needed; ran it
  anyway per the brief's instruction to run the whole file.
- **`tests/roles.test.ts`** and **`tests/users.test.ts`** — grepped for count-shaped assertions
  (`.length`, `.toBe(NN)`); found none tied to `ALL_PERMISSIONS`/`SPECIAL_ACTIONS`. Ran both as an
  extra sanity check (see commands below) — both pass.

So the only file requiring a code change beyond the brief's explicit listing was
`tests/permissions.test.ts` itself, and the fix was inside the same file/line range the brief already
had me editing for Step 5.

## Commands run, verbatim output

### Target three files (as instructed)
```
$ cd erp && npx vitest run tests/backup-settings.test.ts tests/permissions.test.ts tests/permissions-sweep.test.ts

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms
 ✓ tests/permissions.test.ts (9 tests) 2ms
 ✓ tests/backup-settings.test.ts (4 tests) 259ms

 Test Files  3 passed (3)
      Tests  19 passed (19)
   Duration  718ms
```

### tsc
```
$ cd erp && npx tsc --noEmit
(no output — clean)
```

### eslint
```
$ cd erp && npx eslint src tests
(no output — clean)
```

### Extra sanity checks (not required by the brief, run to be sure the count-fix trap was fully closed)
```
$ cd erp && npx vitest run tests/demo-seed.test.ts tests/roles.test.ts tests/users.test.ts

 ✓ tests/users.test.ts (12 tests) 1338ms
 ✓ tests/demo-seed.test.ts (2 tests) 1263ms
 ✓ tests/roles.test.ts (10 tests) 863ms

 Test Files  3 passed (3)
      Tests  24 passed (24)
```

### Full suite (extra — whole-repo regression check)
```
$ cd erp && npx vitest run

 Test Files  173 passed (173)
      Tests  2917 passed (2917)
   Duration  373.71s
[exited with code 0]
```
All 173 test files / 2917 tests pass, including `tests/backup-paths.test.ts` (Task 1's file,
unaffected) and every test that touches roles/permissions/demo-seed. No pre-existing failures
observed anywhere in the repo.

## Commit

```
$ git add erp/src erp/tests
$ git commit -m "feat(backups): add the manage_backups action and backup_stale_hours setting"
[phase-8c-backup-polish cce97df] feat(backups): add the manage_backups action and backup_stale_hours setting
 4 files changed, 67 insertions(+), 3 deletions(-)
 create mode 100644 erp/tests/backup-settings.test.ts
```

`git show --stat` confirms the commit contains exactly:
- `erp/src/lib/permission-constants.ts` (4 insertions)
- `erp/src/server/settings.ts` (10 insertions)
- `erp/tests/backup-settings.test.ts` (new file, 40 lines)
- `erp/tests/permissions.test.ts` (16 insertions, 3 deletions — the new test case plus the count fix)

Commit SHA: `cce97df5b9270e4eb05a8607623893fe1213fd4e`

No attribution trailer, conventional commit style, per repo convention.

## Things a reviewer should look at closely

- **The count-assertion fix** in `tests/permissions.test.ts` (`13 * 4 + 12` → `13 * 4 + 13`) — this
  is the change most likely to be missed by a less careful implementation, and it's the one place I
  touched a file/line the brief didn't literally hand me text for.
- **`backup_stale_hours` placement** — confirmed it sits immediately after `session_timeout_minutes`
  inside the `"System"` group in the `SETTINGS` object, per the brief's explicit instruction.
- **No other file needed changes.** I verified this by grepping the full tree for
  `ALL_PERMISSIONS|SPECIAL_ACTIONS` both before writing any code and after, and by running the full
  2917-test suite, not just the three files named in the brief's final verification step.

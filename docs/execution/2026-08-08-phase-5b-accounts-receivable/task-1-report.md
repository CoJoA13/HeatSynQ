# Task 1 report — `ar-constants.ts`, the `receivables` permission area, and the batch-number counter

**Status:** DONE
**Commit:** `492bffe` — `feat(5b): A/R constants, receivables permission area, receipt-batch counter`
**Branch:** `phase-5b-accounts-receivable`

## What was implemented

1. **`erp/src/lib/ar-constants.ts`** (new file) — pure, client-safe constants for Phase 5B:
   `APPLICATION_TYPES`/`ApplicationTypeValue`/`APPLICATION_TYPE_LABELS`,
   `RECEIPT_BATCH_STATUSES`/`ReceiptBatchStatusValue`,
   `AGING_BUCKETS`/`AgingBucketValue`/`AGING_BUCKET_LABELS` — verbatim per the brief's block. No
   imports from `src/server/**`.
2. **`erp/src/lib/permission-constants.ts`** — appended `"receivables"` to `AREAS` and
   `"write_off"` to `SPECIAL_ACTIONS`, each as its own new line, existing groupings left
   untouched (append, don't reflow).
3. **`erp/src/server/settings.ts`** — registered `receipt_batch_number_next: { schema:
   numberSeed, default: 1000, label: "Next receipt-batch number", group: "Numbering" }` in the
   `SETTINGS` registry (multi-line form, matching the style already used for
   `cert_required_default`/`cert_scope_default`/etc.).
4. **Tests touched:**
   - `tests/permissions.test.ts` — added `AREAS`/`SPECIAL_ACTIONS` to the import, added the
     brief's `"has a receivables area and a write_off special action"` case, and updated the
     pre-existing `"ALL_PERMISSIONS covers areas × actions plus specials"` assertion from
     `12 * 4 + 11` to `13 * 4 + 12` (see "Incidental fix" below).
   - `tests/allocate-number.test.ts` — added `"allocates receipt-batch numbers from the new
     counter"`, mirroring the existing `credit_number_next` case.
   - `tests/partial-unique-sweep.test.ts` — added `"ReceiptBatch.batchNumber"` to the documented
     `ALLOWED` set, with a comment noting the model doesn't exist until Task 2 and this entry
     sits unused until then, plus the required "allocation-only, never reissued — a voided batch
     keeps its number" rationale.

## TDD evidence

### Step 1–4: permissions test (`receivables` area / `write_off` special action)

RED — `npx vitest run tests/permissions.test.ts -t "receivables area"`:
```
 × permission resolution > has a receivables area and a write_off special action 4ms
   → expected [ 'orders', 'parts', …(10) ] to include 'receivables'
 Test Files  1 failed (1)
      Tests  1 failed | 7 skipped (8)
```

GREEN (after Step 3 edit) — `npx vitest run tests/permissions.test.ts`:
```
 ✓ tests/permissions.test.ts (8 tests) 2ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### Step 5–8: allocate-number test (`receipt_batch_number_next` counter)

RED — `npx vitest run tests/allocate-number.test.ts -t "receipt-batch numbers"`:
```
 × allocateNumber > allocates receipt-batch numbers from the new counter 97ms
   → Unknown setting: receipt_batch_number_next
 Error: Unknown setting: receipt_batch_number_next
  ❯ allocateNumber src/server/settings.ts:124:44
 Test Files  1 failed (1)
      Tests  1 failed | 11 skipped (12)
```

GREEN (after Step 7 edit — registry entry + `ar-constants.ts` created) —
`npx vitest run tests/allocate-number.test.ts`:
```
 ✓ tests/allocate-number.test.ts (12 tests) 452ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

### Step 9–10: sweeps

`npx vitest run tests/permissions-sweep.test.ts tests/partial-unique-sweep.test.ts`:
```
 ✓ tests/permissions-sweep.test.ts (6 tests) 14ms
 ✓ tests/partial-unique-sweep.test.ts (2 tests) 8ms
 Test Files  2 passed (2)
      Tests  8 passed (8)
```

**Watch-point resolved:** the `"ReceiptBatch.batchNumber"` allow-list entry sat harmlessly ahead
of the schema column — `partialUniqueColumns()`/the soft-deletable-model offender scan both parse
`prisma/schema.prisma` directly and only ever *subtract* the `ALLOWED` set from what they find
there; an allow-list entry with nothing in the schema to match just never gets used. The sweep
passed with no forcing needed, so I proceeded per the brief's instructions.

## Full gate chain (all run in the foreground; no backgrounded commands)

- `npm test` — **PASS**: 109 test files, 1694 tests, 0 failures (154.66s).
- `npx tsc --noEmit` — **PASS**, no output.
- `npx eslint src tests` — **PASS**, no output.
- `npm run build` — **PASS**, standalone build completed (all routes compiled, no errors).

E2E (`npm run test:e2e`) was not run: this task adds no route, no UI component, and no service —
`AREAS`/`SPECIAL_ACTIONS` are consumed dynamically everywhere in the app (the admin roles page
maps over them; `ALL_PERMISSIONS` is built from them), and the new `receivables` area/`write_off`
action are granted to no role, so no existing flow's rendered output or behavior changes. The
orchestrator's brief for this task scoped gates to `npm test` / `tsc` / `eslint` (the `/gates`
skill's core chain); I added `npm run build` on top of that since it's cheap and part of the
skill's documented chain, but left E2E out as genuinely inapplicable here.

## Self-review

- **Completeness against the brief:** all 11 steps followed in order; `ar-constants.ts` matches
  the brief's code block character-for-character (diffed by eye against the brief).
- **YAGNI:** no schema, service, or route code added — Task 1 stays scoped to constants +
  permission area + counter, as instructed. Nothing in `ar-constants.ts` is unused/speculative
  beyond what the brief specifies (all six exports are named directly in the brief's interface
  block, for later tasks to consume).
- **Test hygiene / incidental fix:** `tests/permissions.test.ts`'s pre-existing
  `"ALL_PERMISSIONS covers areas × actions plus specials"` test hardcodes
  `ALL_PERMISSIONS.length` as `12 * 4 + 11`. Adding a 13th area and 12th special action (Step 3)
  makes that literal stale — `ALL_PERMISSIONS.length` becomes `13 * 4 + 12 = 64`, not `59` — so
  the test would fail on the very next full-suite run if left alone. This isn't called out as an
  explicit step in the brief, but it's a direct, mechanical consequence of Step 3's edit and
  necessary to keep `npm test` green (Step 10 requires PASS). I updated the literal to
  `13 * 4 + 12` with a one-line comment explaining the new count, rather than rewriting the
  assertion to derive the expected count from `AREAS.length`/`SPECIAL_ACTIONS.length` — the
  latter would make the assertion tautological against `ALL_PERMISSIONS`'s own implementation
  (`AREAS.flatMap(...).length + SPECIAL_ACTIONS.length`), destroying its value as a canary that
  forces a conscious update whenever the permission surface grows. Kept the literal-with-comment
  style consistent with how the file already documents itself.
- **No other hardcoded-count breakage found.** Checked `src/app/admin/roles/page.tsx` (iterates
  `AREAS.map`, no fixed count), `prisma/seed.ts`/`src/server/roles.ts`/`src/server/users.ts`
  (all iterate `ALL_PERMISSIONS` dynamically), and `tests/settings.test.ts` (its
  `it.each([...])` Int4-overflow list and its `allSettings()` assertions don't enumerate every
  `*_number_next` key — `credit_number_next` was already absent from that list before this task,
  so `receipt_batch_number_next`'s absence is consistent with existing practice, not a new gap).
  Ran `tests/settings.test.ts` standalone (27/27 pass) to confirm.
- **Pristine output:** `tsc` and `eslint` both produced zero output (clean). Full suite is
  109/109 files, 1694/1694 tests, no skips introduced.
- **Naming note (not a defect, recorded for visibility):** `AREAS` already contained a plain
  `"ar"` entry (used only by `Shell.tsx`'s nav link and one `DENY`-beats-`GRANT` test fixture,
  with no CRUD permissions wired to it anywhere else). The brief's interface section explicitly
  specifies a *new*, differently-named `"receivables"` area, so I added it alongside `"ar"`
  without touching or renaming the existing entry — that pre-existing naming decision predates
  this task and isn't something Task 1's brief asked to reconcile.

## Session note

An earlier pass in this task ran a diagnostic `git stash` (to compare a `schema.test.ts` failure
against a pre-change baseline) and did not pop it back before pausing to wait on a backgrounded
`npm test` run — leaving the working tree looking reverted. This was caught and corrected: the
stash was popped (`git stash pop`), the diff was re-verified against what's described above, and
every command from that point forward (all TDD steps' RED/GREEN runs, the full gate chain, and
the commit) was re-run in the foreground with no backgrounding. The `schema.test.ts` failure
itself does not reproduce on a clean full-suite run (109/109 files, 1694/1694 tests passed above)
and reproduced neither before nor after re-running in isolation — it was a flaky/pre-existing
artifact unrelated to this task's diff, not something introduced by these changes.

## Concerns

None blocking. The one thing worth the controller's attention for Task 2 planning: the
`"ReceiptBatch.batchNumber"` sweep exemption is now sitting in `tests/partial-unique-sweep.test.ts`
ahead of the model it describes, exactly as the brief anticipated — Task 2's implementer should
not need to touch that allow-list line, only add the matching `@unique` column to the schema.

# Task 1 report: The pure leaf — constants and path safety

## What I implemented

Exactly the four files specified in the brief, transcribed verbatim (comments included, as
instructed):

1. `docs/execution/2026-08-16-phase-8c-backup-polish/progress.md` — the Phase 8C execution ledger,
   committed first per CLAUDE.md's rule that the record is never deferred to the end.
2. `erp/tests/backup-paths.test.ts` — 14 test cases across three `describe` blocks (`backup archive
   names`, `resolveBackupDir`, `archivePath`).
3. `erp/src/lib/backup-constants.ts` — client-safe constants/types leaf: `DEFAULT_STALE_HOURS`,
   `BACKUP_STATUS_FILENAME`, `NIGHTLY_ARCHIVE_RE`/`MANUAL_ARCHIVE_RE`, `archiveSourceOf`,
   `isArchiveName`, the `BackupSource`/`BackupHealthState`/`BackupHealth`/`ArchiveInfo`/
   `BackupsView`/`BackupStatusFile` types, and `isHealthy`.
4. `erp/src/server/backup-paths.ts` — the pure, filesystem-free path/name leaf:
   `DEFAULT_BACKUP_DIR`, `resolveBackupDir`, `archivePath`, `statusPath`, `stampFor`,
   `manualArchiveName`, `tempNameFor`. Imports only `node:path`, the `errors.ts` leaf
   (`HttpError`), and the lib constants module — no `fs`, no database.

## Deviations from the brief

None in the code or test files — they are byte-for-byte transcriptions of the brief's listings,
comments included.

One out-of-band fix, not part of the brief's file list: before starting Step 1 I found
`.superpowers/sdd/.gitignore` modified in the working tree (uncommitted) back to a bare `*` —
exactly the recurring clobber CLAUDE.md documents ("twice across sessions and once within one").
This was pre-existing dirty state from before this session started, not something I introduced. It
was actively hiding this task's own brief directory
(`.superpowers/sdd/2026-08-16-phase-8c-backup-polish/`, containing `task-1-brief.md`) from
`git status`/`git add`. I ran `git restore .superpowers/sdd/.gitignore` to bring it back to the
committed (correct) version before doing anything else, since leaving it clobbered would have put
this task's own brief and this report at risk of the same loss CLAUDE.md describes for Phase 3 and
nearly Phase 5A. This did not touch any file inside my two commits — verified both commits below
contain only the intended paths.

The three ambiguity resolutions in the brief (raw-string `..` check before `path.resolve`, local
time in `stampFor`, and the `process.cwd()` cwd assumption in the relative-path test) all held as
given — none needed the brief's fallback (the `./backups` test passed as originally written, so no
test edit was needed).

## Commands run, verbatim output

### Step 1 — ledger commit
```
$ git add docs/execution/2026-08-16-phase-8c-backup-polish/
$ git commit -m "docs: open the Phase 8C execution ledger"
[phase-8c-backup-polish bbc2611] docs: open the Phase 8C execution ledger
 1 file changed, 20 insertions(+)
 create mode 100644 docs/execution/2026-08-16-phase-8c-backup-polish/progress.md
```

### Step 3 — confirm the test fails first
```
$ cd erp && npx vitest run tests/backup-paths.test.ts
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/backup-paths.test.ts [ tests/backup-paths.test.ts ]
Error: Cannot find module '@/server/backup-paths' imported from '/home/cojoa13/Desktop/HeatSynQ/erp/tests/backup-paths.test.ts'.

- If you rely on tsconfig.json's "paths" to resolve modules, please install "vite-tsconfig-paths" plugin to handle module resolution.
- Make sure you don't have relative aliases in your Vitest config. Use absolute paths instead. Read more: https://vitest.dev/guide/common-errors
 ❯ tests/backup-paths.test.ts:2:1
      1| import { describe, it, expect } from "vitest";
      2| import {
       | ^
      3|   resolveBackupDir, archivePath, statusPath, stampFor, manualArchiveNa…
      4| } from "@/server/backup-paths";

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  no tests
```
Matches the brief's expected failure exactly (`Cannot find module '@/lib/backup-constants'` was the
brief's prediction; the actual first failure was the same shape one import line earlier —
`@/server/backup-paths` — because that import appears first in the file. Same root cause: neither
module existed yet.)

### Step 6 — tests pass
```
$ cd erp && npx vitest run tests/backup-paths.test.ts
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-paths.test.ts (14 tests) 3ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Duration  119ms (transform 21ms, setup 10ms, collect 14ms, tests 3ms, environment 0ms, prepare 25ms)
```

### Step 7 — fast gates
```
$ cd erp && npx tsc --noEmit
(no output — clean)

$ cd erp && npx eslint src tests
(no output — clean)
```

### Final combined verification (as requested in the task instructions)
```
$ cd erp && npx vitest run tests/backup-paths.test.ts && npx tsc --noEmit && npx eslint src tests
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-paths.test.ts (14 tests) 3ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Duration  ~120ms
(tsc: no output, clean)
(eslint: no output, clean)
```
All three gates green. No pre-existing unrelated tsc/eslint errors were observed (both commands
produced zero output against `src` and `tests`, i.e. a fully clean repo-wide check, not just the
new files).

### Step 8 — code commit
```
$ git add erp/src/lib/backup-constants.ts erp/src/server/backup-paths.ts erp/tests/backup-paths.test.ts
$ git commit -m "feat(backups): add the pure backup-path leaf and client-safe constants"
[phase-8c-backup-polish e5f2c56] feat(backups): add the pure backup-path leaf and client-safe constants
 3 files changed, 244 insertions(+)
 create mode 100644 erp/src/lib/backup-constants.ts
 create mode 100644 erp/src/server/backup-paths.ts
 create mode 100644 erp/tests/backup-paths.test.ts
```

## Commit SHAs

1. `bbc26116b46e0fd0fbe7ce23e792734005a5befb` — `docs: open the Phase 8C execution ledger`
   (only `docs/execution/2026-08-16-phase-8c-backup-polish/progress.md`)
2. `e5f2c562a6320de9056df0627816810ffade5644` — `feat(backups): add the pure backup-path leaf and client-safe constants`
   (only `erp/src/lib/backup-constants.ts`, `erp/src/server/backup-paths.ts`, `erp/tests/backup-paths.test.ts`)

Verified with `git show --stat` on each SHA that no unrelated file leaked into either commit.

## Things a reviewer should look at closely

- **The `.superpowers/sdd/.gitignore` restore** described above under "Deviations" — it's not part
  of either commit (that directory is still gitignored by design; only the review-package `.diff`
  files are meant to stay ignored per CLAUDE.md), but it's a working-tree change I made outside the
  brief's file list. Worth confirming the restored `.gitignore` content matches what later tasks in
  this phase expect to find when they start (it should — I only reverted it to `HEAD`, I didn't
  edit its content).
- **No filesystem coupling was introduced.** `backup-paths.ts` imports only `node:path`, `./errors`,
  and `@/lib/backup-constants` — confirmed by reading the file back after writing it; no `fs`,
  no Prisma, no `node:async_hooks`.
- **`archivePath`'s `path.dirname(full) !== dir` belt-and-braces check** is dead code today (the
  regex already forbids `/` and `..`) — the brief's own comment says to keep it as a documented
  invariant assertion, not to simplify it away. Left as-is.
- Test count: 14 tests across 3 describe blocks, all passing, matching the brief's Step 6
  expectation of "PASS, all cases."

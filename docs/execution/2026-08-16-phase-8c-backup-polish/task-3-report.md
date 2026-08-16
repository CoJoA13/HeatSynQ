# Task 3 report — Health evaluation and archive listing

## What was implemented

Per `task-3-brief.md`, verbatim:

- **`erp/src/server/backups.ts` (new)** — the read side of the Backups service:
  - `evaluateHealth(i: HealthInputs): BackupHealth` — pure, encodes the owner's green rule (§6.4).
  - `type HealthInputs`.
  - `integrityOk(fullPath)` — private `gzip -t` wrapper, returns `false` rather than throwing.
  - `listArchives(dir?)` — lists both writers' archives, verifies every one's integrity, sorted
    newest-first.
  - `parseStatus`/`readStatus(dir)` — parses `backup-status.json`, returns `null` on any
    missing/unparseable/wrong-shaped input (never throws to the caller).
  - `newestIntactAt(dir)` — private; walks newest-first, stops at the first `gzip -t` pass (the
    cheap path the shell banner polls).
  - `backupHealth(dir?)` — reads `backup_stale_hours` from the DB via `getSetting`, derives
    `newestSuccessAt`/`status`/`folderError`, and calls `evaluateHealth`.
  - `backupsView()` — the full page payload: health + every archive with per-file integrity.
- **`erp/src/server/practice-mode.ts` (modified)** — added `assertNotPracticeDatabase(db?)`
  directly below `assertPracticeDatabase`, exactly as specified in Step 3.
- **`erp/tests/backup-health.test.ts` (new)** — the 17-case table-driven suite from the brief,
  verbatim, covering `evaluateHealth`'s branch table, `listArchives`'s filtering/sorting/integrity,
  and `backupHealth`'s DB-setting integration (with the required `truncateAll()` in `beforeEach`
  for the filesystem-backed `describe` block that reads `backup_stale_hours`).

No implementation deviation from the brief — every function signature, message string, and branch
order in `backups.ts` and `practice-mode.ts` was copied from the brief's code blocks verbatim, and
the test file is an exact copy of the brief's Step 1 code.

## Deviation from the brief: commit shape (environmental, not implementation)

The brief's Step 7 asks for one commit: `git add erp/src erp/tests && git commit -m "feat(backups):
evaluate staleness and list archives with integrity"`.

When I went to stage the work, `git status` showed that **two of the three files were already
present in HEAD, byte-identical to what I had just written**, having been swept into two earlier
commits on this same branch with unrelated-looking messages:

- `29b162d docs: pin the E2E harness's backup-folder plumbing for Task 9` — includes
  `erp/tests/backup-health.test.ts` (168 lines) alongside its stated topic (a plan-doc edit for the
  Task 9 E2E harness).
- `c1de215 chore: match the gitignore convention for the e2e backup folder` — includes the
  `assertNotPracticeDatabase` addition to `erp/src/server/practice-mode.ts` (16 lines) alongside its
  stated topic (a `.gitignore` entry).

Both commits are timestamped 2026-08-16 01:13:47/54, essentially concurrent with my own Write/Edit
tool calls on the same two files. I found no active git hooks (`.git/hooks/` has only the stock
`*.sample` files), so this was not a hook firing on my own actions — it looks like a **separate,
concurrent process operating on this same checkout/branch** (plausibly another agent authoring the
later-task plan sections, paired with some kind of periodic safety-net commit that stages
everything currently in the working tree and writes a message describing whatever doc diff it was
aware of). I verified byte-for-byte identity (`git show HEAD:<path> | diff - <path>` → empty) and a
full green `npx tsc --noEmit` (no duplicate-declaration errors), so there is no corruption or
double-definition — the content landed correctly, just under a commit message that doesn't describe
it.

**What I did about it:** nothing destructive. I did not rewrite history, amend, or reset. I staged
and committed only the one file that was genuinely still uncommitted —
`erp/src/server/backups.ts` — under the brief's exact intended message. The net result is that all
three files the brief specifies are in HEAD, tests pass, and the working tree is clean; the only
divergence from the brief is that the `practice-mode.ts` and test-file changes ride in commits
`c1de215`/`29b162d` instead of the single commit the brief describes, purely because of that
concurrent activity. Flagging this because the SDD execution record depends on commit messages
accurately narrating "why" — these two carry the wrong "why" for the code lines they contain — and
because it's evidence of a second process writing to this branch, which the owner may want to be
aware of for the remaining tasks (4 onward).

## Commands run, with real output

```
$ cd erp && npx vitest run tests/backup-health.test.ts
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/backup-health.test.ts (17 tests) 338ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
   Start at  01:22:44
   Duration  625ms (transform 116ms, setup 10ms, collect 180ms, tests 338ms, environment 0ms, prepare 26ms)

$ npx tsc --noEmit
(no output — clean)

$ npx eslint src tests
(no output — clean)

$ echo "Exit code of full chain: $?"
Exit code of full chain: 0
```

```
$ npx vitest run tests/permissions-sweep.test.ts
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/permissions-sweep.test.ts (6 tests) 16ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  01:23:03
   Duration  125ms (transform 15ms, setup 10ms, collect 7ms, tests 16ms, environment 0ms, prepare 24ms)
```

`backups.ts` passes the sweep trivially as predicted: it performs no Prisma model mutation
(`getSetting` is the only Prisma-touching call, and it's a read), so there is nothing for the sweep
to flag.

I additionally ran the full suite once (not requested, but `practice-mode.ts` is a shared leaf
several other modules depend on, so I wanted the safety margin before reporting done):

```
$ npm test
 Test Files  174 passed (174)
      Tests  2934 passed (2934)
   Start at  01:14:53
   Duration  375.56s
[exited with code 0]
```

No `tsc` or `eslint` findings unrelated to this change — both ran clean start to finish; there is
nothing pre-existing to disclaim.

## Commit

`8c703c2` — `feat(backups): evaluate staleness and list archives with integrity` (adds
`erp/src/server/backups.ts`, 170 insertions). The `practice-mode.ts` and
`erp/tests/backup-health.test.ts` changes are present in HEAD via `c1de215` and `29b162d`
respectively (see "Deviation" above) — no attribution trailer on any of the three, per the
no-trailer convention.

## `evaluateHealth`'s branch ordering — what it does to the messages

The six branches are checked in this order, and **every** branch below the first true one is
short-circuited — `BackupHealth` carries exactly one `state`/`reason` pair, never a list of
concurrent problems:

1. `folderError` → `unknown`, "folder could not be read"
2. `!status` → `unknown`, "status file" missing/unparseable
3. `!status.ok` → `failed`, "last backup run failed"
4. `!newestSuccessAt` → `stale`, "no backup archive"
5. `ageHours > staleHours` → `stale`, "N hours old, past threshold"
6. else → `ok`

Two interactions worth flagging:

- **The failed-run check runs before the staleness check, which is the entire mechanism behind the
  owner's "red immediately" rule.** If the last run failed *and* the newest intact archive is also
  past the staleness window, the operator only ever sees the "last backup run failed" reason — the
  staleness fact is real but never surfaced, because branch 3 returns before branch 5 is reached.
  That's correct per §6.4 ("a recorded failure is red immediately, even when a 25-hour-old success
  still sits inside the window") — the test at brief line 46 pins exactly this — but it does mean
  the single-reason type can hide a second true problem. If a future task ever wants "tell me
  everything wrong," the type would need to grow beyond one `reason` string; nothing here bothers
  with that today, and I did not add it since the brief doesn't ask for it.

- **`folderError` beats the missing-status message even though a missing directory would fail
  *both* underlying reads.** `backupHealth`'s two reads are sequential (`newestSuccessAt = await
  newestIntactAt(dir); status = await readStatus(dir);`), not run in parallel. `newestIntactAt`
  calls a bare `readdir(dir)` that throws on a missing directory, so for a missing folder the
  function never reaches the `readStatus` call at all — `status` stays at its initial `null` but
  `folderError` gets set from the `readdir` throw. `readStatus` itself never throws to its caller
  (it has its own internal try/catch that always resolves to `null` on any failure, including
  ENOENT on the status file specifically) — so `folderError` is reserved for directory-level
  failures, and a status-file-specific failure (present directory, absent/corrupt status file)
  always reads as the more specific "status file" message rather than the generic "folder" one.
  This is why the "reads RED for a folder that does not exist" test asserts `state: "unknown"`
  without asserting *which* `unknown` message — both branches 1 and 2 return the same `state`, and
  the ordering only decides which sentence the operator reads, not the color.

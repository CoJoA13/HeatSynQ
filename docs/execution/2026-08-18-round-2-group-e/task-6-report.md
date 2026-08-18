# Task 6 — #132 retention health in a shell-only sidecar — implementer report

**Commit:** `3f879e9` `fix(backups): retention health rides a shell-only sidecar the manual path cannot clear (#132)`
**Branch:** `group-e-close-gl`

## What landed

The issue's failure mode: the nightly `scripts/backup.sh` records a retention failure as
`ok:false` in `backup-status.json` (#120), but the Node manual path's `writeStatus` overwrites
that file whole with `ok:true` on the next successful "Back up now" — no read-merge exists and
read-merge is forbidden by design (backups.ts module header, CLAUDE.md Backups §). So the light
went green while retention stayed broken. Fix per the brief: a second, SHELL-ONLY sidecar
`retention-status.json` that the Node writer never touches — the erasure is impossible by
construction, not by discipline.

- `erp/src/lib/backup-constants.ts` — `RETENTION_STATUS_FILENAME` + `RetentionStatusFile` type
  (no `source` field — the nightly script is its only writer). The constant's comment cites the
  un-merged-overwrite property as the reason a field inside the main status could never work.
- `erp/src/server/backup-paths.ts` — `retentionStatusPath(dir)`, `statusPath`'s mirror. The leaf
  stays pure (path + constants only, no fs, no db).
- `erp/scripts/backup.sh` — `write_retention_status()` (same printf/temp-then-rename shape and the
  same character sanitization as `write_status`), called on every run that reaches retention:
  `ok:false` with `retention cleanup failed for: <patterns>` when `RETENTION_ERR` is non-empty,
  `ok:true` on a clean run. **The sidecar write comes FIRST in both branches, deliberately**:
  under `set -e` a failing sidecar write then aborts before the main status can go green
  (fail-toward-red); the reverse order could leave a fresh green main status behind a non-zero
  exit. #120's main-status behavior and exit codes are otherwise byte-identical — the sidecar is
  additional evidence, not a replacement.
- `erp/src/server/backups.ts` —
  - `parseRetentionStatus` beside `parseStatus`: same shape discipline (tolerant of unknown
    fields; `lastRunAt` parseable string, `ok` boolean, `error` optional string/null; anything
    else rejects the whole file → null). `readRetentionStatus` mirrors `readStatus`.
  - `HealthInputs` gains `retention: RetentionStatusFile | null` (required — every caller must
    decide), read in `backupHealth`'s same inspection pass as the main status.
  - `evaluateHealth` gains ONE branch, after `!i.status.ok`: a readable sidecar with `ok:false` →
    `state: "failed"`, reason `The last backup succeeded, but the nightly retention cleanup is
    failing[: <error>] — old archives are accumulating.` — the error segment is elided when null
    (the `!status.ok` branch's null-handling pattern), so the sentence reads correctly either way.
  - **The documented exception:** absence or corruption of the sidecar contributes NOTHING. The
    comment states the brief's three reasons in place: (1) the main status file's absence rule
    already covers "the nightly never ran"; (2) the sidecar self-refreshes every night, so a real
    failure is re-recorded within 24h even if the file is lost; (3) absence-as-failure would red
    every existing install for up to 24h mid-upgrade, before the first post-upgrade nightly writes
    the file.
- Structural non-interference, pinned rather than assumed: `retention-status.json` fails
  `isArchiveName` (so `listArchives` ignores it and `archivePath` refuses it) and matches none of
  the script's three prune globs. The listing-ignore pin and a paths-level pin both name it now.

## RED table (all watched failing before implementation)

Two RED batches, so the pure-branch failures were visible as assertion REDs rather than being
masked by unresolved imports. Batch 1: the pure `evaluateHealth` cases (no new imports). Batch 2:
after adding ONLY the inert declarations (constant, type, path helper — build step 1), the
filesystem/script/manual-path tests.

| Test | RED failure |
|---|---|
| evaluateHealth: readable failing sidecar → failed (batch 1) | `expected 'ok' to be 'failed'` — no retention branch exists; the input is ignored |
| evaluateHealth: null-error sidecar reads as a full sentence (batch 1) | `expected 'ok' to be 'failed'` — same |
| backupHealth real folder: retention failure survives a green manual main status | `expected 'ok' to be 'failed'` — `backupHealth` never reads the sidecar |
| backup-run: manual success never touches the sidecar, health stays red | `expected 'ok' to be 'failed'` — the byte-unchanged assertion passed even pre-fix (the manual writer never touched that path), the HEALTH assertion is what was impossible before |
| backup.sh: failing prune writes sidecar ok:false naming the pattern | `ENOENT … retention-status.json` — the script never writes it |
| backup.sh: clean run writes sidecar ok:true | `ENOENT … retention-status.json` — same |
| drift guard: script literal matches `RETENTION_STATUS_FILENAME` | `expected '#!/bin/sh…' to contain 'RETENTION_STATUS="$DIR/retention-stat…'` |

Watched-green-in-RED (deliberate direction pins, passing vacuously pre-fix and meaningfully now):
clean sidecar → ok; absent sidecar → ok; main `!status.ok` outranks the sidecar;
`retentionStatusPath` pin (pure helper added in batch 2's declarations, a pin not a behavior).

## UI verification (brief item 5)

No UI change needed, verified by reading both render sites:

- `erp/src/app/admin/backups/page.tsx:157` — `const green = health?.state === "ok"`; `:179`
  renders `health.reason` verbatim. The retention state is `"failed"`, an existing
  `BackupHealthState` member, so the page shows the red panel with the retention sentence.
- `erp/src/components/BackupBanner.tsx:126` — `if (!health || health.state === "ok") return
  null`; `:134` renders `⚠ {health.reason}`. Same: the banner appears with the retention sentence.

`health.reason` is the entire operator-facing surface (recon), and the new branch fills it.

## Gate results

| Gate | Result |
|---|---|
| `npx vitest run tests/backup-script.test.ts tests/backup-health.test.ts tests/backup-run.test.ts tests/backup-paths.test.ts` | 4 files, 86 tests, all pass |
| `npx vitest run` (adjacent: backup-banner, backups-routes, backups-page-state, backup-settings, backup-permission-backfill) | 5 files, 48 tests, all pass |
| `npm test` (full suite) | 184 files, 3210 tests, all pass (409s) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run test:e2e` | deferred to the group-level run near merge, per the brief's sequencing (this task touches no UI component; the brief's E2E note names ShipmentDetail/BatchDetail/Close.tsx from tasks 1–3) |

## Reviewer-attention items

1. **Sidecar-before-main-status write order in backup.sh** — the brief said "after the prune
   block, write the sidecar" without fixing the order relative to `write_status`. I put the
   sidecar write FIRST in both branches: under `set -e` a failing sidecar write aborts before the
   main status can go green (fail-toward-red, §6.2's standing bias); the reverse order could
   stamp a green main status and then exit non-zero. In the normal case the order is
   unobservable, and both #120 script tests plus the two new ones pin main-status behavior and
   exit codes unchanged.
2. **`HealthInputs.retention` is required, not optional** — forces every caller (there is exactly
   one, `backupHealth`, plus the tests) to state a value; an optional field would let a future
   call site silently drop the sidecar. Cost: the test fixture `base` gained `retention: null`.
3. **The manual-path test's sidecar-bytes assertion passed pre-fix** (noted in the RED table): the
   Node writer never wrote to that filename even before the change, so "unchanged bytes" alone
   would have been test theater. The load-bearing assertion is the health one — red retention
   surviving a green manual overwrite — which was RED for the right reason.
4. The sidecar carries no `source` field, diverging from `BackupStatusFile` — deliberate (single
   writer), stated on the type.

# Task 3 review — Health evaluation and archive listing

## Spec Compliance
✅ Spec compliant.

- Green rule (§6.4) branch order in `evaluateHealth` (erp/src/server/backups.ts:141-177):
  folderError → missing/unparseable/wrong-shaped status → `!status.ok` (failed) → no intact
  archive → stale-past-threshold → ok. A recorded failure returns `failed` even when an
  intact archive is still inside the window (test at erp/tests/backup-health.test.ts:46-54
  pins exactly this; `newestSuccessAt` at 25h with `status.ok:false` → `failed`, not `ok`).
  Boundary is inclusive-fresh (36h ok, 36.01h stale) per erp/src/server/backups.ts:170,
  tests at :387-390.
- `lastSuccessAt` is derived only: `evaluateHealth` computes it from `i.newestSuccessAt`
  (backups.ts:143), and `newestIntactAt`/`backupHealth` (backups.ts:237-264,354-368) never
  read or write a stored value. Grepped `backups.ts`/`practice-mode.ts`/
  `backup-constants.ts` — no persisted `lastSuccessAt` field anywhere.
- Absence is failure (§6.2): `parseStatus` (backups.ts:211-224) rejects non-object,
  non-string/unparseable `lastRunAt` (`Number.isNaN(Date.parse(...))`), non-boolean `ok`,
  and any `source` outside `"nightly"/"manual"` — all fall through to `null`, which
  `evaluateHealth` reads as `unknown`/red. Verified the wrong-shape test
  (`{hello:"world"}`, backup-health.test.ts:186-190) and the unparseable-JSON test
  (:180-184) both pass. A thrown fs error (missing dir) is caught in `backupHealth`
  (backups.ts:375-380) and turned into `folderError`, which is checked first — no path
  returns `ok` from a thrown error.
- `archivePath` is the only filename→path conversion used for archives in this file
  (backups.ts:194,240); no hand-rolled `path.join(dir, name)` for an archive anywhere in
  `backups.ts`. (`statusPath` is the separate sanctioned helper for the status file.)
- Reads never mutate: only Prisma call is `getSetting` (a read); no `auditedCreate/Update`,
  no `$transaction`, no row claim, no Serializable isolation anywhere in the file.
- `newestIntactAt` (backups.ts:354-368) stops at the first intact archive walking
  newest-first; `listArchives` (backups.ts:307-326) verifies every archive via
  `Promise.all`. Deliberately separate per the brief/spec — confirmed not unified.
- `assertNotPracticeDatabase` (practice-mode.ts:298-306) is byte-for-byte the mirror of
  `assertPracticeDatabase`: calls the un-memoized `currentDatabase(db)` directly (never
  `practiceMode()`), takes the caller's `db` client (default `prisma`), throws
  `HttpError(403, ...)`.
- Shared-database trap: `truncateAll()` is present in the `beforeEach` of the
  `describe("backupHealth against a real folder")` block (backup-health.test.ts:451) —
  the only block that reads `backup_stale_hours` from the DB.
- Unsafe-green checks I ran independently, beyond reading the code:
  - Zero-byte archive: `gzip -t` on an empty `.sql.gz` exits 1 ("unexpected end of file"),
    confirmed by direct shell test — `integrityOk` correctly returns `false`, so a
    zero-byte archive can never become `newestSuccessAt`.
  - Directory named like an archive: both `listArchives` and `newestIntactAt` `stat()`
    every candidate and filter on `s.isFile()` (backups.ts:314, 359) before it can count.
  - Ran `npx vitest run tests/backup-health.test.ts` directly: 17/17 pass, pristine output
    (no warnings), matching the report's claim. Ran `npx eslint` on the three changed files:
    clean.

## Strengths
- `evaluateHealth`'s ordering is exactly the priority the owner's rule requires, and the
  brief's own adversarial test (failure beating a fresh-inside-window success) passes.
- The stop-early (`newestIntactAt`) vs. verify-all (`listArchives`) split is implemented
  correctly and matches the documented rationale (cheap banner poll vs. full-page detail).
- `assertNotPracticeDatabase` correctly avoids the memoized `practiceMode()` trap that the
  house rules explicitly warn about.
- `parseStatus` closes every wrong-shape gap named in the ask (missing fields, non-string
  dates, unparseable dates, bad `source` enum, non-boolean `ok`).

## Issues
### Critical (Must Fix)
None.

### Important (Should Fix)
None.

### Minor (Nice to Have)
- No direct test for a zero-byte or directory-named archive, even though the logic is
  correct (verified above by direct `gzip -t` check and code reading). A regression here
  would only be caught incidentally.
- `parseStatus` (backups.ts:219) treats a missing `error` key the same as an explicit
  `error: null` rather than rejecting it as wrong-shaped; harmless (never causes a false
  green — `error` only feeds the `failed` reason string) but is a small leniency beyond
  the brief's stated four-key shape.
- Controller-flagged commit-hygiene artifact (test file and `practice-mode.ts` change
  landing in `29b162d`/`c1de215` instead of the Task 3 commit) is out of scope per the
  dispatch instructions and not reflected in these findings.

## Assessment
**Task quality:** Approved
**Reasoning:** `evaluateHealth`'s branch order, the derived-not-stored `lastSuccessAt`,
`parseStatus`'s wrong-shape rejection, and `assertNotPracticeDatabase`'s un-memoized mirror
all match the spec exactly and were independently verified (including the zero-byte-archive
and directory-named-archive edge cases the controller asked about); no path returns a false
green.

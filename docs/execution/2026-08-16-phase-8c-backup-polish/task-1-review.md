# Task 1 review: The pure leaf — constants and path safety

## Spec Compliance
✅ Spec compliant.

- `DEFAULT_STALE_HOURS = 36` (`erp/src/lib/backup-constants.ts:170`) and
  `BACKUP_STATUS_FILENAME = "backup-status.json"` (`:175`) match spec §6.4/table row 155/158.
- Naming shapes match `scripts/backup.sh` exactly: `TMP="/backups/.erp_${STAMP}.sql.tmp"`,
  `erp_${STAMP}.sql.gz`, prune `erp_*.sql.gz` (`erp/scripts/backup.sh:6-15`) line up with
  `stampFor`/`tempNameFor`/`NIGHTLY_ARCHIVE_RE` (`backup-paths.ts:301-320`,
  `backup-constants.ts:178`).
- Verified with node: `NIGHTLY_ARCHIVE_RE`/`MANUAL_ARCHIVE_RE` are fully literal outside their
  digit/hex captures (`\d{4}-\d{2}-\d{2}`, `[0-9a-f]{8}`), so `isArchiveName` cannot return true
  for any string containing `/`, `..`, or a trailing/embedded newline (JS `$` without `/m` only
  matches true end-of-string) — `erp_....sql.gz/../x` and `erp_....sql.gz\n` both correctly
  return `false`.
- `UNSAFE_CHARS` (`backup-paths.ts:261`) is a well-formed character class (verified by
  execution): every metachar plus `[`, `]`, `{`, `}`, `'`, `"`, `\` is individually matched;
  no accidental range or premature `]` closure.
- `..`-segment check runs on the raw, pre-`path.resolve` string (`backup-paths.ts:271-275`) —
  satisfies the stated ordering requirement.
- `src/lib/backup-constants.ts` has zero imports (client-safe); `src/server/backup-paths.ts`
  imports only `node:path`, the zero-import `./errors` leaf, and the lib constants — no `fs`,
  no DB, no permissions. Confirmed by direct read, matches the leaf precedent.
- All three new files are byte-for-byte identical to the brief's code blocks (diffed
  programmatically, zero deltas) — implementer's "verbatim" claim holds.
- Commits: `bbc2611` (ledger only) then `e5f2c56` (the three source files only), no attribution
  trailer, conventional style — matches the squash-merge convention.
- `npx tsc --noEmit` / `npx eslint src tests` clean per report; `npx vitest run
  tests/backup-paths.test.ts` re-run here independently — 14/14 pass, pristine output.

No ⚠️ / ❌ items.

## Strengths
- The threat-model comment block (`backup-paths.ts:245-251`) correctly identifies that
  root-confinement is meaningless for a deploy-set `BACKUP_DIR`, and the filename-shaped guard
  actually delivers on that (verified, not just asserted).
- Belt-and-braces `path.dirname(full) !== dir` check left in as documented dead code per the
  brief's own instruction, not "simplified away."
- Test suite exercises the actual defeat attempts named in the task (`..` raw-string, shell
  metacharacters, `/etc/passwd`, embedded `..` after a valid extension) rather than just
  happy-path shapes.

## Issues
### Critical (Must Fix)
None.

### Important (Should Fix)
None.

### Minor (Nice to Have)
- `isHealthy` (`backup-constants.ts:232-234`) is exported but untested — trivial one-liner,
  and it's inherited verbatim from the brief's code block (not itemized in the brief's own
  "Produces" interface list), so this is a brief-level gap, not an implementer defect.

## Assessment
**Task quality:** Approved
**Reasoning:** Both leaves are verified pure/client-safe, the escape-guard regexes were checked
against defeat attempts and hold, values match the owner-settled spec exactly, and the code/test
files are confirmed verbatim transcriptions of the brief with a clean TDD (RED→GREEN) record.

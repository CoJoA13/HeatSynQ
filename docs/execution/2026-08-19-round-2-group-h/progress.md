# Round 2 Group H — the polish batch — progress ledger

Branch `group-h-polish`, opened 2026-08-19 from `d539f8a`.
Issues in this PR: #14 (items 1, 2, 4), #37, #38, #33 (bounded slice), #100 (items 1, 2, 4,
5, 8, 9), #101, #72, #99, #24, #9. #144–#149 → separate H2 PR (controller call, recon
recommendation). Stale strikes at close: #14 item 3, #100 items 3/6/7.

## Kickoff (2026-08-19)

- Recon: six parallel agents over 16 candidate issues; 15 verified still real in whole or
  part. Key corrections: #9's cost collapsed L→M (tx-threading shipped since filing); #24 has
  a third unordered collection (`user.overrides`); #72 needs a data migration (seeded `ar.*`
  grants); #33's named seam is the ragged one.
- Owner ruling: **#33 → bounded slice + defer the create/edit split** (issue stays open,
  retitled; evidence recorded).

## Task verdicts

**Task 1 (#24 + #9, audit snapshot fidelity)** — implementer `9afba47`/`ecb6d43`/`a05e36e`.
Review: **Spec ✅ · Approved (round 1)**. The center of gravity was the implementer's
deviation — **`FOR NO KEY UPDATE` instead of the brief's `FOR UPDATE`** — diagnosed live off
`pg_locks` (plain `FOR UPDATE` conflicts with FK RI triggers' `FOR KEY SHARE` probes, turning
the reciprocal-parent customers test into a trigger-internal ABBA deadlock no claim ordering
can reach) and verified by the reviewer against the Postgres conflict matrix: writers still
mutually exclude, no audited mutation performs a key update, and the brief's own
"deadlock-surface unchanged" requirement becomes true rather than aspirational. The sweep test
survived adversarial probes (future list-include caught; parser rot fails loudly, not
vacuously). Four minors; two **controller-applied** (`8ccd8a2`): the stale setting
first-refusal comment, and a no-`@@map` tripwire pinning the claim's table-name derivation.

**Task 2 (#72 + #99 + #100 item 4, cleanups)** — implementer `7ba09a9`/`f73b1df`/`249f555`/
`1d59ddf`. Review: **Spec ✅ · Approved (round 1)**. The reviewer verified the migration
applied to both DBs, proved nothing at seed or startup can re-mint `ar.*`, confirmed the
drift-guard rework keeps the frozen SQL untouched while still catching future drift in both
directions, checked #99's 404 parity string-for-string, and enumerated every users-page
control for §5.16 coverage. Three minors, all record-only (the entry-time-only residual race
is documented in-code as an accepted decision; a report count typo — `permissions` is 9/9, not
10/10; the SQL-splitting helper caution).

**Task 3 (#100 items 1/2/5/8/9 + #101, quoting surface)** — implementer `486123b`/`096d200`/
`2cbca1a`/`784dc86`/`485a813`/`2adda98`/`950107d`. Review: **Spec ✅ · Approved (round 1)**.
The reviewer traced the item-1 skip as correct-by-construction (the customerId-immutability
guard makes echo ⇒ empty patch true without comparison logic), verified the lock-poll's
DB-scoping join, and judged the flagged stop-panel draft-reset sound. Two record-only minors;
the poll-filter one was **controller-applied — badly, then fixed** (see incidents).

## Process incidents (controller's own, recorded for the record)

1. **A controller minor applied without solo verification was wrong** (`f02ffe5`): the
   lock-poll filter matched the counter key's TEXT, but Prisma binds it as `$1` — the poll
   could never match and the test timed out. Task 1's implementer caught it by bisect;
   corrected to matching the statement SHAPE (`"Setting"…FOR UPDATE`) and verified 3/3 on an
   isolated DB (`1b1e591`). Rule tightened: controller minors get solo verification like any
   other change.
2. **A whole-file pathspec commit swept another implementer's uncommitted hunk** (`8ccd8a2`
   carries Task 4's `part: { material: true }` edit): explicit pathspecs prevent staging
   unrelated FILES, not another's hunks in the SAME file. No damage — the change is correct
   and in history; Task 4's implementer was informed and cites `8ccd8a2`. Rule tightened: the
   controller does not commit a file while an implementer owns a region of it.
3. **Shared-infrastructure contention**: three parallel implementers cycling `npm test`
   against the one `erp_test` DB corrupt each other (40P01 truncate deadlocks, half-seeded
   fixtures). The working convention that emerged — per-task scratch DBs
   (`CREATE DATABASE` + `migrate deploy` + DATABASE_URL override, dropped after) and clean
   `git worktree`s for suite-level proof — belongs in the next group's brief from the start.

## Gates

_(pending)_

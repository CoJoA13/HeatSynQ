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

**Task 4 (#14 items 1/2/4 + #37 + #38, parts/attachments/combobox)** — implementer
`4a05738`/`b6ffe85`/`79824de`/`af22661`/`4d7cb24`/`8d68eee`/`c6194af`. Review: **Spec ✅ ·
Needs fixes (round 1) → fixed same round** (`c4c30f4`): the one Important was a raw NUL byte
(0x00) embedded in HistoryPanel.tsx's key template, which made git classify the file as
BINARY — it blinded the review package's own diff of the very file it needed to read. One
character; also applied the neutral load-failure wording minor. The substance was clean: the
FK-suppression leaf's two hard edges pre-pinned, the failed-refetch path honest by
construction, the blur-save normalize guard genuinely composing with the controlled inputs.
The `part: { material: true }` hunk rode `8ccd8a2` (the controller sweep, incident 2) and was
reviewed there under this task's scope.

**Task 5 (#33 bounded slice)** — implementer `39788bc`/`7143589`/`57d0ab4`/`e27043d`/
`8f137da`. Review: **Spec ✅ · Approved (round 1)**. The reviewer independently extracted
every moved region from the pre-move blob and confirmed byte-parity (only the disclosed
mechanical deltas exist), verified nothing concurrency-bearing moved and the #115/§5.14
blocks line-identical, confirmed the orders↔shippers runtime cycle is retired at the import
sites (not merely re-pointed), and judged the trafficSettings deviation forced-and-sound.
#33 commented + retitled, stays open for the deferred create/edit split. Three record-only
minors.

## Group tally

Five implementation tasks, five reviews — **four Approved round 1, one Needs-fixes whose
single Important was fixed and verified the same round**. Reviewer minors: five
controller-applied across the group (one badly, then corrected — incident 1), the rest
record-only. Nine issues closed by the PR (#9, #14, #24, #37, #38, #72, #99, #100, #101);
#33 partially landed and retitled (owner ruling); stale strikes recorded on #14 item 3 and
#100 items 3/6/7. One migration (`20260819003000_remove_ar_permission_area`), applied to both
DBs.

## The group-level E2E catch (why that gate exists)

The first full E2E run failed **14 of 23 flows** — every flow that drives a combobox.
Diagnosis: #37's (correct) ARIA pass gave the picker options an explicit `role="option"`,
which REPLACES the implicit button role in the accessibility tree, so the shared
`pickCombobox` helper's `getByRole("button")` locator stopped matching. Not a product
regression — the product change is right, the test helper encoded the old semantics. One-line
helper fix (`5941a52`, mechanism documented in its comment), then **23/23**. Recon had
predicted "switching the flows to getByRole is the durable assertion" — the helper was the
one place still holding the old locator.

## Codex round (PR #152, 2026-08-19)

One P2, **verified real and accepted** (`716ff21`): #24's orderBy fixed the ORDER but not the
IDS — delete/recreate mutations mint fresh generated ids every save, so a same-set re-save
still JSON-differed under HistoryPanel's whole-key compare, and Task 1's behavioral pin
compared mapped names, missing it. Fixed by projecting all three delete/recreate relations
onto stable fields (`permission`; `permission`+`mode` in both user maps; the four meaningful
`ProcessStepFieldDef` columns — the same class extended to the entry Codex didn't name), with
the behavioral pin strengthened to FULL deep-equality (RED watched on the exact id-churn
construction first). Full suite 3310/198 green after, on an isolated DB and the shared one.
Replied + resolved per the loop.

- **Round 2** (one P2, real — `bf72649`): #99's entry guard is a plain read, so a
  `deleteReference` committing between guard and write could still land the patch on a
  just-deleted row — the exact residue the task-2 review had recorded as an accepted decision.
  Codex re-found it; closing it turned out cheap in the reviewer's own suggested shape: the
  WRITE is now a guarded `updateMany` conditional on `deletedAt: null` (the `auditedSoftDelete`
  precedent), zero-count raising the same 404 and aborting entry-less at any isolation. The
  entry guard stays as the fast-path 404; `RefDelegate` gained `updateMany`. All six reference
  suites (111 tests) + the full suite (3310/198) green after.

- **Round 3** (one P2, **triaged → filed as #153**, no push): the History invalidation's
  child-section calls refresh a parent-only query — verified as a PRE-EXISTING display
  boundary, not a regression (`readAudit` has always been an exact `(entity, entityId)` match;
  child-entity rows were never visible in the part panel, reload or not). Parent-panel child
  aggregation is a real enhancement affecting customers/orders panels equally — fix directions
  recorded on #153; the child-section invalidation wiring deliberately stays so it goes live
  the day aggregation lands.

## Merge (2026-08-19)

Squash-merged as `a8ed769` (PR #152). GitHub's closing keyword bound only the first reference
in the PR body's list, so #14/#24/#37/#38/#72/#99/#100/#101 were closed manually as completed
with the pointer (lesson: one `Closes #n` per issue, not a comma list). #33 stays open,
retitled. 15 issues open after (the H2 six, the deferred #33, five parked, #134, #137, #153).

## Gates (final tree `bf72649`; E2E at `5941a52`, unit gates re-run after each Codex fix)

| Gate | Result |
|---|---|
| `npm test` | **3310 passed / 198 files** (solo run; Group G closed at 3260/191 — a mid-run
48-failure reading was shared-DB contamination from a concurrently-running reviewer, see
incident 3) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean |
| `npx prisma migrate status` | clean on both `erp` and `erp_test` |
| `npm run test:e2e` | **23/23 flows** (after the helper fix above; first run 9/23) |

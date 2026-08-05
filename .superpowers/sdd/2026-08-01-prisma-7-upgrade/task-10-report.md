# Task 10 report — rewrite the documentation this branch invalidates

## Status: DONE

Committed as `1b7fb21` on `prisma-7-upgrade`. Only `CLAUDE.md` and `docs/HANDOFF.md`
were touched — no code, test, schema, or migration file changed (`git diff --stat`
before commit showed exactly those two files).

## Sections changed and why

### `CLAUDE.md`

- **"Commands" first-run block**: added `npx prisma generate` after `npm install`
  (v7's `migrate dev` no longer generates the client for you, and it's gitignored).
  Fixed the stale `# vitest, 75 integration tests` comment to `258`.
- **"Schema changes apply to two databases"**: rewrote the recipe to insert
  `npx prisma generate` between `migrate dev` and the `erp_test` `migrate deploy`
  (per the brief's Step 1 text), and added a paragraph naming the CLI flags that
  no longer exist (`--skip-generate`, `--skip-seed`) and the renamed
  `migrate diff --to-schema` flag, plus where seeding is now declared
  (`prisma.config.ts`'s `migrations.seed`, not `package.json`'s `prisma.seed`).
- **"Deletion is always soft"**: replaced "Reviving a soft-deleted name must clear
  the stale permissions attached to it" with the brief's new rule verbatim — unique
  columns on soft-deletable models are unique only among live rows, there is no
  revival-on-create, never `findUnique`/`upsert` on such a column, use `findFirst`
  with `deletedAt: null`, and the sweep test enforces both halves.
- **"Constraints that will bite you"** (addition beyond the brief's literal text,
  see "Judgment calls" below): added a bullet documenting that `npx prisma migrate
  dev` refuses to run in a non-interactive shell (confirmed by Task 4's report —
  "the environment is non-interactive, which is not supported", fails even with
  `CI=true` or `--create-only`), and the `migrate diff --from-config-datasource
  --to-schema=... --script` + hand-written-migration + `migrate deploy` workaround,
  since that's exactly how this branch's one migration was made and a fresh Claude
  Code session following the "Schema changes" recipe verbatim would otherwise get
  stuck.

### `docs/HANDOFF.md`

- **Header (line 3)**: now states the Prisma 7 upgrade and revival removal are done
  on `prisma-7-upgrade`, pending merge — not folded into "Phase 2B merged" framing.
- **§4a** ("RESUME HERE"): retitled to "Prisma 7 upgrade complete". Issue #10's
  bullet marked DONE with the branch name. The "What to do next" numbered list
  was rewritten: item 1 (upgrade) replaced by a short "done, not yet merged" note
  above the list; Phase 2C (formerly item 2) promoted to item 1, with an added
  sentence that revival-on-create is deliberately not one of its five inherited
  obligations; issue #4 (formerly item 3) renumbered to item 2.
- **§4b**: fully rewritten from a pre-work survey ("what it actually means for
  THIS repo") into an outcome record ("what actually happened"), per the brief's
  Step 5. Kept every prediction that held (six import files, no `tsc` target
  bump, driver adapter, generator shape) and marked them "as predicted." Called
  out what the survey got wrong or didn't anticipate: `engine` was *removed*, not
  adapted; ESM's blast radius was zero files (`vitest.config.ts`'s `__dirname`
  didn't actually break, because Vite injects it into its own bundled config
  regardless of module type); `dotenv`/`tsx` moving to `dependencies` and the
  Dockerfile needing to copy `prisma.config.ts` (not predicted at all — this
  caused a real crash-loop, per the branch's authoritative facts); and the
  non-interactive `migrate dev` refusal (also not predicted). Confirmed the "also
  removed, worth confirming" line (`prisma.$use`) with a fresh grep — still zero
  hits in `src/` or `prisma/`.
- **§5.10**: added the `npx prisma generate` step and a pointer to the
  non-interactive workaround now documented in `CLAUDE.md`.
- **§5.11**: replaced the "SUPERSEDED... do not add a new site" placeholder with
  the actual current rule — no revival-on-create, partial-unique columns instead,
  `User.username` is the deliberate plain-`@unique` exception, sweep test named.
- **§5.18**: prefixed `**DONE (2026-08-01, branch \`prisma-7-upgrade\`)**` and
  corrected the three factual errors *in place* (not silently dropped), each
  flagged so a future reader doesn't re-derive them:
  1. `@@unique` does take `where`; the plan had written `@@index(..., unique:
     true)` and claimed `@@unique` takes no `where` — both wrong. Corrected to
     `@@unique([col], where: raw("…"))`.
  2. `partialIndexes` is a **preview feature** in 7.9.1, not stable — the plan
     didn't know this; noted the owner's 2026-08-01 approval and why the
     packages are pinned exactly.
  3. The plan predicted the compiler would force `findUnique` → `findFirst`
     ("the column is no longer a declared unique field on the client"). That's
     false — `WhereUniqueInput` still types the column unique, so `findUnique`
     silently returns the soft-deleted row and the conversion is a manual audit
     backed only by `tests/partial-unique-sweep.test.ts`. Called this out as
     "the dangerous kind of false — silent, not a build error."
- **§6**: struck the three items named in the brief (renaming onto a
  soft-deleted unique value 400s "already exists" in `customers.ts`/`reference.ts`;
  `renameRole` → 500 edge; "make revival-on-create ONE shared helper before 2C
  adds a fifth site") using the document's own existing strikethrough-plus-note
  convention (already used elsewhere in §6 for a closed DELETE-idempotency bug).
  **Beyond the brief's explicit list** (see "Judgment calls" below), also struck
  two more items that were now flatly false and actively dangerous to leave for
  a future 2C reader: "Any model with `@unique` + soft delete needs
  revival-on-create" (Carried out of Phase 2A), and "revival keeps stale extra
  columns from the deleted row" (Smaller, none blocking, same section) — both
  describe a mechanism that no longer exists and the first explicitly told 2C to
  apply the now-banned pattern to parts.
- **§8**: added `npx prisma generate` to the fresh-machine command block, fixed
  `# expect 255 passing` → `# expect 258 passing`, added a note about the
  non-interactive `migrate dev` limitation.
- **§9**: deleted the Prisma 7 upgrade kickoff prompt entirely, replaced with a
  one-line pointer that it's done and Phase 2C's prompt (unchanged) is now the
  live one. Fixed the section header's "paste one of these" (plural) to "paste
  this" since there's only one prompt now.

**Beyond the two files' explicit brief targets**, also corrected two more stale
factual claims discovered while reading the rest of `docs/HANDOFF.md` for
consistency (neither in the brief's list, both now definitely false per the
authoritative facts, both misleading if left):
- §4 "What Phase 1 delivers" — Admin pages bullet said Roles "revival of a
  soft-deleted name clears stale permissions." Struck and corrected: reusing a
  soft-deleted role's name now creates a new role; nothing is revived.
- §4 "Phase 2A" paragraph — said reference-table `reference.ts` "revives" a
  soft-deleted name. Struck and corrected to the new create-only behavior.

## Judgment calls (flagging per the task's instructions)

1. **Non-interactive `migrate dev` note added to `CLAUDE.md` and HANDOFF §5.10/§8**,
   beyond the brief's literal Step 1/Step 2/Step 6 snippets. The brief's exact
   text for those steps doesn't mention this. I added it because the outer task
   prompt's authoritative facts list explicitly flagged it as "worth documenting
   so the next person is not stuck," and because I am a Claude Code session
   driving Bash non-interactively — exactly the case that fails. Source for the
   exact failure message and the working `migrate diff --from-config-datasource
   --to-schema=prisma/schema.prisma --script` workaround: Task 4's report
   (`task-4-report.md`), which hit this for real when creating the branch's one
   migration.
2. **Struck two extra backlog/build items beyond the brief's named three**
   (§4 "revival of a soft-deleted name" for Roles and reference tables; §6's
   "Any model with `@unique` + soft delete needs revival-on-create" and "revival
   keeps stale extra columns"). These weren't in the brief's explicit list, but
   they are unambiguously false under the authoritative facts (revival-on-create
   is deleted everywhere) and, in the §6 case, actively told a future 2C reader
   to build the now-banned pattern for parts. Left the strikethrough-plus-note
   convention the document already uses elsewhere, rather than deleting the
   original text outright.
3. **README.md (`erp/README.md`) still documents the stale recipe** — step 3
   ("`npm install && npx prisma migrate dev`") is missing `npx prisma generate`,
   same bug class as the one this task fixed in `CLAUDE.md`. Left it alone: the
   brief's file list and the outer task's "Documentation only" instructions name
   only `CLAUDE.md` and `docs/HANDOFF.md`. Flagging it here rather than silently
   fixing or silently leaving it.
4. **`docs/superpowers/plans/2026-07-30-phase-2-kickoff.md` §2.6 still tells 2C
   to build revival-on-create** ("Any model with a `@unique` column plus soft
   delete needs revival-on-create... Customer `code` is the first case in 2B;
   parts will have more"). Also out of this task's explicit scope (not
   `CLAUDE.md` or `docs/HANDOFF.md`), so left unedited. Partially mitigated:
   `docs/HANDOFF.md` §4a now explicitly tells the next 2C session "Revival-on-
   create is deliberately not on this list — see §5.11," and §6 now warns
   "Parts (2C) must not add a revival site" right where the stale claim used to
   be — and `CLAUDE.md`, which a fresh session reads before the kickoff brief,
   states the current rule plainly. But the kickoff brief itself still contains
   the wrong instruction verbatim and could mislead a reader who starts there.
   Recommend a future task correct it.
5. Left `docs/HANDOFF.md` §4a line "main is green on all four gates — 255
   tests" (describing the Phase 2B merge snapshot from earlier the same day)
   unchanged — it's a historical record of `main`'s state at that specific
   point in time, not a current instruction, and correctly stays at 255.

## Verbatim transcript — clean-clone verification (Step 8)

Ran after committing `1b7fb21` (a `git clone` only sees committed history, so
verification had to follow the commit, not precede it as the brief's step
numbering literally suggests — noting this because it's a deliberate reordering,
not an oversight).

```
$ rm -rf /tmp/handoff-check
$ git clone /home/cojoa13/Desktop/HeatSynQ /tmp/handoff-check
Cloning into '/tmp/handoff-check'...
done.

$ cd /tmp/handoff-check && git checkout prisma-7-upgrade
Already on 'prisma-7-upgrade'
Your branch is up to date with 'origin/prisma-7-upgrade'.
$ git log --oneline -1
1b7fb21 docs: rewrite the schema-change workflow for Prisma 7

$ cd erp && cp .env.example .env

$ docker compose up -d db
 Container erp-db-1 Recreate
 Container erp-db-1 Recreated
 Container erp-db-1 Starting
 Container erp-db-1 Started
```

**Observation, not a doc bug**: this recreated the shared `erp-db-1` container
(compose resolved the same project name "erp" from the clone's own `erp/`
directory basename and detected a config diff — almost certainly the resolved
absolute paths of the `./db-init`/`./scripts/backup.sh`/`./backups` bind mounts,
which differ between `/tmp/handoff-check/erp` and the real checkout). Verified
this did **not** lose data — the named `dbdata` volume (`erp_dbdata`) is a
separate lifecycle from the container:

```
$ docker volume ls | grep erp
local     erp_dbdata
$ docker exec erp-db-1 psql -U erp -d erp -c 'SELECT count(*) FROM "User";'
 count
-------
     1
(1 row)
```

Continuing the documented recipe:

```
$ npm install
added 670 packages, and audited 671 packages in 5s
[... npm deprecation warnings, no errors ...]

$ npx prisma generate
Loaded Prisma config from prisma.config.ts.
Prisma schema loaded from prisma/schema.prisma.
✔ Generated Prisma Client (7.9.1) to ./prisma/generated/prisma in 105ms

$ npx prisma migrate deploy
Datasource "db": PostgreSQL database "erp", schema "public" at "localhost:5432"
9 migrations found in prisma/migrations
No pending migrations to apply.

$ DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
Datasource "db": PostgreSQL database "erp_test", schema "public" at "localhost:5432"
9 migrations found in prisma/migrations
No pending migrations to apply.

$ npm run db:seed
Seeded Admin role + admin user (password: admin — change it after first login).

$ npx tsc --noEmit
$ echo $?
0

$ npm test
 Test Files  31 passed (31)
      Tests  258 passed (258)
   Duration  27.60s

$ npx eslint src tests
$ echo $?
0
```

Every documented step worked exactly as written — no missing step, no wrong
step found. `npm test` truncated `erp_test` as the task's note said to expect;
the `erp` dev database was never dropped or reset, only the container was
recreated (data preserved via the named volume, confirmed above).

Cleanup:

```
$ rm -rf /tmp/handoff-check
$ ls /tmp | grep -i handoff
(no output — removed)
```

## Final state of the real checkout (post-verification sanity check)

```
$ docker ps --format "table {{.Names}}\t{{.Status}}" | grep erp
erp-db-1   Up About a minute (healthy)
$ git status --porcelain
(clean)
$ git log --oneline -1
1b7fb21 docs: rewrite the schema-change workflow for Prisma 7
$ npm test   # re-run in the real checkout after the clone's truncation
 Test Files  31 passed (31)
      Tests  258 passed (258)
```

## All four gates (real checkout, pre-commit and post-commit)

- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm test` — 258/258, 31 files.
- `npm run build` — succeeded (standalone Next build, all routes listed, no
  errors).

## Files changed

- `/home/cojoa13/Desktop/HeatSynQ/CLAUDE.md`
- `/home/cojoa13/Desktop/HeatSynQ/docs/HANDOFF.md`

## Concerns

- Items 3 and 4 under "Judgment calls" above (`erp/README.md` and the Phase 2
  kickoff brief §2.6) are real, verified staleness of the same bug class this
  task fixed, but outside this task's explicit file scope. Worth a follow-up.
- None of the four quality gates are at risk from this change (docs only), but
  flagging per the verification-before-completion discipline: this was
  confirmed with actual command output, not assumed.

---

# Follow-up fix — the three remaining stale live docs (coordinator-directed)

## Status: DONE

Committed separately as `1e68e59` on `prisma-7-upgrade` (after `1b7fb21`). The
coordinator swept every `.md` in the repo after reviewing Task 10 and confirmed
Concern 1 above was correct, then scoped exactly three files to fix and named
four archive plans to leave untouched (`2026-07-29-phase-1-foundation.md`,
`2026-07-30-phase-2a-foundation-reference-data.md`,
`2026-07-30-phase-2b-customers.md`, `2026-08-01-prisma-7-upgrade.md`) — none of
those four were touched, confirmed by `git status --porcelain` showing exactly
the three target files changed before commit.

## 1. `erp/README.md`

- **"Development" recipe (was line 8)**: same defect as `CLAUDE.md` had —
  `npm install && npx prisma migrate dev` with no `npx prisma generate` after
  it. Renumbered the list to insert `npx prisma generate` and split the single
  `migrate dev` step into `migrate deploy` (dev DB) matching `CLAUDE.md`'s
  corrected first-run block, since a first-run checkout should be *applying*
  committed migrations, not drafting a new one. Added a short note pointing
  schema-authors at `migrate dev` for that case, and at `CLAUDE.md`'s
  non-interactive-shell workaround.
- **"Production" seeding note (was line 35 area)**: this needed more than a
  one-line fix, so I verified it rather than pattern-matching off `CLAUDE.md`.
  Built the prod image (`docker compose --profile prod build app` — succeeded)
  and checked the pruned run image directly:
  ```
  $ docker run --rm --entrypoint sh erp-app -c "ls node_modules/.bin/tsx; ls -d node_modules/dotenv"
  node_modules/.bin/tsx
  node_modules/dotenv
  ```
  Both **are** present now — `dotenv` and `tsx` moved to `dependencies` in this
  branch (Task 3) specifically so `npm prune --omit=dev` doesn't strip them,
  since `prisma.config.ts` needs `dotenv` at every container-start `migrate
  deploy`. So the README's original reason for seeding externally ("doesn't
  carry tsx or other dev tooling") is now false. But the underlying advice
  (seed from an external checkout, not in-container) is still correct, for a
  different reason — confirmed by actually trying it:
  ```
  $ docker run --rm --network host -e DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" \
      --entrypoint sh erp-app -c "npm run db:seed"
  ...
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/server/permissions'
  imported from /app/prisma/seed.ts
  ```
  It gets past loading `tsx` and `dotenv` and fails only because the run image
  doesn't ship `src/` (the Dockerfile's run stage copies `.next/standalone`,
  `.next/static`, `public`, `prisma/`, `prisma.config.ts`, and `node_modules` —
  never raw `src/`), and `prisma/seed.ts` imports `../src/server/permissions`
  directly. Rewrote the note to give the real reason and note the tsx/dotenv
  status explicitly so a future reader doesn't "fix" this by chasing the wrong
  cause. Ran the seed test against `erp_test` (already sanctioned as safe to
  touch), not `erp` — no dev-database data touched.
- Checked the rest of the file (Reference data / Customers / Backups /
  Updating sections) for the same class of staleness — nothing else in it
  describes a Prisma CLI workflow or a test count.

## 2. `README.md` (repo root)

- Line 5: `75 integration tests` → `258 integration tests`. Exactly the
  one-line fix requested; left the rest of that line (`Phase 1 (Foundation)
  complete...`) and everything else in the file untouched, since the
  coordinator scoped this file narrowly (no "check the rest of the file"
  instruction, unlike `erp/README.md`).
- **Found but deliberately left alone, flagging per instructions rather than
  guessing at scope**: line 13's repo-layout table still says "Next.js 15 +
  Prisma 6 + PostgreSQL" — now Prisma 7.9.1. Same staleness class as the fixed
  item, on the project's front page, but outside the coordinator's explicit
  one-line-fix scope for this file. Recommend a follow-up if the front page
  should stay current.

## 3. `docs/superpowers/plans/2026-07-30-phase-2-kickoff.md`

- **Line 22** (Customer `code`): the forward reference to §2.6 no longer says
  "needs revival-on-create" as settled fact — now points at §2.6 and states
  plainly that it's superseded (partial-unique index, not revival).
- **§2.6** ("Rule learned in Phase 2A"): retitled to flag the supersession,
  then rewritten per the coordinator's instruction — marked superseded in
  place, original reasoning kept intact (why a plain `@unique` + soft delete
  is dangerous, the two Critical bugs it caused), the *prescription* portion
  struck through (`~~Any model with a @unique column plus soft delete needs
  revival-on-create~~`, `~~Revival must clear deletedAt...~~`) using this same
  document's own existing strikethrough convention (already used for the
  removed `Salesperson` reference table and the answered open questions in
  §6), and replaced with a short "what actually governs now" paragraph
  pointing at `docs/HANDOFF.md` §5.11/§5.18 and
  `tests/partial-unique-sweep.test.ts` rather than restating the whole rule.
  Also corrected the pointer to `createReference` in `src/server/reference.ts`
  — that function no longer contains revival, and the brief's original text
  told a future author to copy it expecting that behavior.
- Grepped the file afterward for any other `revival`/`revive` mentions —
  the only remaining ones are inside the now-corrected §2.6 block and line
  22's pointer, both accurate.

## Verification

- Did **not** repeat the full clean-clone run for the root README's test
  count (not needed, per the coordinator's instruction).
- Sanity-checked `erp/README.md`'s revised "Development" sequence against the
  clean-clone run already proved to work in the original Task 10 pass: the
  command sequence (`.env` → `docker compose up -d db` → `npm install` →
  `npx prisma generate` → `npx prisma migrate deploy` ×2 → `npm run db:seed`)
  is identical in content and order to `CLAUDE.md`'s corrected first-run
  block, which was verified command-by-command in `/tmp/handoff-check`. No
  re-clone needed since it's the same sequence, not a new one.
- The production-section fix **was** independently verified with real
  commands (image build + two `docker run` probes), not inferred — see
  transcript above.
- Four gates re-run after all three doc edits, on the real checkout:
  - `npm test` — 258 passed, 31 files, 0 skipped.
  - `npx tsc --noEmit` — clean (exit 0).
  - `npx eslint src tests` — clean (exit 0).
  - `npm run build` — succeeded, standalone build produced.
- `git status --porcelain` before commit showed exactly `README.md`,
  `erp/README.md`, `docs/superpowers/plans/2026-07-30-phase-2-kickoff.md` —
  no code, test, schema, or migration file touched; none of the four named
  archive plans touched.

## Files changed (this follow-up)

- `/home/cojoa13/Desktop/HeatSynQ/README.md`
- `/home/cojoa13/Desktop/HeatSynQ/erp/README.md`
- `/home/cojoa13/Desktop/HeatSynQ/docs/superpowers/plans/2026-07-30-phase-2-kickoff.md`

## Concerns

- Root `README.md` line 13's "Prisma 6" is stale (should be 7) — left alone,
  out of the scoped one-line fix for that file. Flagging rather than fixing
  or silently ignoring.
- No new concerns about the three files fixed here — each fix was either a
  direct match to the already-verified `CLAUDE.md` recipe (erp/README.md
  Development section, root README test count) or independently verified
  with real commands (erp/README.md Production section, via built image) or
  grounded in code already read and verified during the original Task 10 pass
  (`docs/HANDOFF.md` §5.11/§5.18, `tests/partial-unique-sweep.test.ts`, the
  kickoff brief fix).

---

# Second follow-up — root README's stale "Prisma 6" (coordinator-directed)

## Status: DONE

The coordinator clarified their earlier "one-line fix" instruction for root
`README.md` was scoped to the test count specifically, not a cap on that
file, and asked me to fix the "Prisma 6" mention I'd flagged as a concern,
plus sweep the rest of the file for the same class of drift (stack
description, setup steps, versions, workflows) against what this branch
changed.

**Fix**: line 13's repository-layout table, "Next.js 15 + Prisma 6 +
PostgreSQL" → "Next.js 15 + Prisma 7 + PostgreSQL" (confirmed `next@15.5.22`,
`prisma@7.9.1` in `erp/package.json` — "Next.js 15" was already accurate,
only the Prisma major number was stale).

**Swept the rest of the file**: `grep -n -iE
"prisma|next\.js|postgres|node|version|migrate|npx"` against the whole file
returned exactly the one line just fixed — no other version number, setup
command, or workflow description appears anywhere else in root `README.md`.
Nothing else to fix in that category.

**Deliberately left alone, not in scope**: the "Status" line's "Phase 1
(Foundation) complete" framing and the "Build phases" table's phase
descriptions (e.g. "process masters" under Phase 2, a term the Process Steps
model doc superseded back in Phase 2A) are stale against the *project's*
current state, but that drift predates this branch by weeks and isn't a
version/stack/workflow claim — it's project-milestone status, a different
class of staleness than what this branch introduced. The coordinator's
instruction named "stack description, setup steps, anything naming a version
or a workflow"; milestone/phase status doesn't fit those categories, so I
left it and I'm noting it here rather than guessing whether it was meant to
be included.

## Verification

- Re-ran all four gates after the fix (docs-only, no regression expected,
  confirmed anyway):
  - `npm test` — 258 passed, 31 files, 0 skipped.
  - `npx tsc --noEmit` — clean.
  - `npx eslint src tests` — clean.
  - `npm run build` — succeeded.
- No remote tracking existed for `prisma-7-upgrade` (`git branch -vv` showed
  no `[origin/prisma-7-upgrade]`, confirming the branch hasn't been pushed),
  so per the coordinator's explicit "amend or add a commit as you judge
  cleanest," I **amended** the previous follow-up commit (`1e68e59` →
  `0759773`) rather than adding a fourth commit for one line, since this
  fix completes the same "fix the three remaining live docs" intent on the
  same file that commit already touched. Updated the commit body to mention
  the second staleness caught on the follow-up pass. Working tree is clean;
  `git log` on `prisma-7-upgrade` now shows `0759773` in place of `1e68e59`
  with no other history disturbed.

## Files changed (this follow-up)

- `/home/cojoa13/Desktop/HeatSynQ/README.md` (only file touched this round)

## Concerns

- None. This was a narrow, fully verified fix (grep-confirmed no other
  version/workflow drift in the file) folded into the existing follow-up
  commit at the coordinator's explicit direction. The branch is now, per the
  coordinator's message, headed to final review — no further doc work
  identified or pending on my end.

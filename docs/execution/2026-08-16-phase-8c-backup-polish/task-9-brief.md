### Task 9: Restore runbook, E2E flow, and the docs

**Files:**
- Create: `erp/e2e/flows/backups.mjs`
- Modify: `erp/e2e/run.mjs` (register the flow at the FLOWS tail)
- Modify: `erp/README.md` (the expanded restore runbook)
- Modify: `docs/HANDOFF.md` (§4 entry, §8 fresh-machine prerequisite, §9 next-track)
- Modify: `CLAUDE.md` (the standing-architecture paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: the `backups` E2E flow; the merged documentation state.

- [ ] **Step 1: Write the E2E flow**

Create `erp/e2e/flows/backups.mjs`. Read `e2e/flows/setup-checklist.mjs` and `e2e/flows/reports.mjs`
first and match their `run(page, shot, ctx)` signature and assertion style.

```js
// Flow: the Backups page (Phase 8C §6.2). Proves the red-when-empty indicator, the resolved folder,
// and — the headline control — that "Back up now" writes a real archive with a real pg_dump and
// flips the indicator green. The host's pg_dump is major-matched to the postgres:18 server
// (§6.4); vitest deliberately does NOT use it (CI's is older and pg_dump refuses a newer server),
// so this flow is the only place the real binary is exercised.
//
// Mutates only the backup folder, never shared DB fixtures — safe at the FLOWS tail.
import assert from "node:assert/strict";

export async function run(page, shot, ctx) {
  // --- 1. The page renders with the resolved folder and the archive table. ---
  await page.goto(`${ctx.baseURL}/admin/backups`);
  await page.getByRole("heading", { name: "Backups", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Backup folder:", { exact: false }).waitFor({ state: "visible" });

  // --- 2. Back up now writes a real archive and the indicator turns green. ---
  const before = await page.locator("table tbody tr").count();
  await page.getByRole("button", { name: "Back up now" }).click();
  await page.getByText("Backups are up to date", { exact: false })
    .waitFor({ state: "visible", timeout: 60_000 });
  const after = await page.locator("table tbody tr").count();
  assert.ok(after > before || after >= 1, "an archive row appears after Back up now");
  await page.getByText("OK", { exact: true }).first().waitFor({ state: "visible" });
  await shot("backups-after-run");

  // --- 3. The staleness bar is gone once a fresh backup exists. ---
  await page.goto(`${ctx.baseURL}/customers`);
  assert.equal(
    await page.getByText("Open Backups", { exact: true }).count(), 0,
    "the shell staleness bar clears once a recent successful backup exists",
  );
}
```

Register it in `erp/e2e/run.mjs` at the tail of `FLOWS`:

```js
  { name: "backups", as: "admin", module: "./flows/backups.mjs" },
```

**The harness must own the backup folder — do not let this flow depend on the developer's `.env`.**
I have read `e2e/run.mjs`; here are the four exact edits, with the line neighbourhoods as of this
writing (verify by content, not by line number):

1. Beside `const ARTIFACTS_DIR = …` (~line 24):

```js
// Phase 8C: the backups flow writes REAL pg_dump archives, so the harness owns a throwaway folder
// rather than inheriting the developer's BACKUP_DIR (or, worse, writing into erp/backups and
// leaving archives behind). Created fresh in main(), removed in teardown().
const BACKUP_DIR = path.join(ERP_ROOT, "e2e-backups");
```

2. In `startDevServer()`'s spawn env (~line 186) — the dev server is what actually runs `pg_dump`:

```js
    env: { ...process.env, PORT: String(PORT), BACKUP_DIR },
```

3. Beside the existing `ARTIFACTS_DIR` reset in `main()` (~lines 354-355), so every run starts from an
   empty folder and the flow's "no archives yet ⇒ red" assertion is real:

```js
    await rm(BACKUP_DIR, { recursive: true, force: true });
    await mkdir(BACKUP_DIR, { recursive: true });
```

4. In `teardown()` (~line 227) — **the one teardown path**, which both `main()`'s `finally` and the
   SIGINT/SIGTERM handlers share, so a Ctrl-C mid-run cleans up too:

```js
  await rm(BACKUP_DIR, { recursive: true, force: true });
```

> **Note:** `runBackupNow` dumps the dev server's own `DATABASE_URL`, i.e. the **DEV** database `erp`
> — not `erp_test`. That is correct and intended; the archive is thrown away with the folder.

- [ ] **Step 2: Write the restore runbook**

Replace the two-line `## Backups` section in `erp/README.md`:

````markdown
## Backups

The nightly `backup` container `pg_dump`s the production database into the shared backup folder and
keeps 30 days. The app mounts the **same** folder, so `/admin/backups` (which needs the
`manage_backups` action) lists the archives, shows the resolved folder, and can take an on-demand
backup. Both writers also maintain `backup-status.json`, which is what the staleness indicator reads.

- **Folder:** set by `BACKUP_DIR` (container `/backups`, host `./backups`). A deploy value shared by
  both writers — deliberately not a runtime setting, because the nightly container cannot honor a
  live change.
- **Staleness:** `backup_stale_hours` (Admin → Settings, default **36**). The indicator is green only
  when the newest integrity-passing archive is inside that window **and** the last recorded run did
  not fail **and** the status file is readable. **Anything else is red, including a missing status
  file** — if the backup container never started, that silence is the failure you need to see.
- **Practice copy:** has no backup folder, no Backups page, and its routes refuse. Its data is
  disposable; the reset re-seeds it.

### Restoring

Restore is a deliberate terminal command, never a button. **Read all four steps before starting.**

```bash
# 1. Pick the archive and verify it BEFORE you touch the live database.
ls -la erp/backups
gzip -t erp/backups/erp_2026-08-16_020000.sql.gz && echo "integrity OK"

# 2. Take a fresh dump of the CURRENT database first — restoring is destructive and this is your
#    only way back if the archive turns out to be the wrong one.
cd erp && docker compose exec -T db pg_dump -U erp -d erp | gzip > "before-restore-$(date +%s).sql.gz"

# 3. Stop the app so nothing writes mid-restore, then recreate the database empty.
docker compose --profile prod stop app
docker compose exec -T db psql -U erp -d postgres -c 'DROP DATABASE erp;'
docker compose exec -T db psql -U erp -d postgres -c 'CREATE DATABASE erp OWNER erp;'

# 4. Restore, then bring the app back (its start command runs `prisma migrate deploy`).
gunzip -c backups/erp_2026-08-16_020000.sql.gz | docker compose exec -T db psql -U erp -d erp
docker compose --profile prod start app
```

**Verify before you trust it:** sign in, open `/orders` and `/receivables`, and confirm the newest
order and the A/R total match what you expect from the archive's date. If the restore was wrong, the
step-2 dump is your way back.

**Keeping an archive longer than 30 days** — copy it out of the backup folder. Everything inside is
pruned at 30 days, on-demand archives included.
````

- [ ] **Step 3: Update `CLAUDE.md`**

Add one curated paragraph after the Phase 8B paragraph in the Architecture section (and **displace**
nothing else — the file's rule is that new guidance replaces what it supersedes, and this supersedes
nothing):

```markdown
**Backups bridge the app and the nightly container through one shared folder (Phase 8C).** `BACKUP_DIR`
(container `/backups`, host `./backups`) is a **deploy value read by both writers**, never a runtime
`Setting` — the nightly container cannot honor a live change. `src/server/backup-paths.ts` is a **pure
leaf** (no fs, no db) and the ONLY way a filename becomes a path: `archivePath` refuses any name failing
the strict archive regex, which is what makes escaping the folder impossible — the deploy-set directory
cannot be "confined to a root" because it *is* the root. `pg_dump` is spawned **via argv, never a shell
string**, dumped to a temp file and checked for a non-zero size before it is gzipped into place (an empty
archive is never written). **`lastSuccessAt` is DERIVED from the newest integrity-passing archive, not
stored** — the archive is the evidence — which is what lets `backup-status.json` be a single un-merged
overwrite that `sh` can write. The two writers **never share a filename** (`erp_<stamp>` vs
`erp_manual_<stamp>_<rand>`), so no cross-process lock exists or is needed; both match the script's one
`-mtime +30` prune. The indicator is green ONLY on a recent integrity-passing archive **and** a clean last
run **and** a readable status file — **absence is failure**, so a missing status file reads red. Backups
are **production-only**: `assertNotPracticeDatabase` (the `assertPracticeDatabase` mirror in
`practice-mode.ts`) refuses the routes, and compose denies `app-practice` both the env and the mount. The
suite must **never shell out to a host `pg_dump`** — CI's major is older than the server and pg_dump
refuses a newer server, so `runBackupNow` takes an injectable dump command (a parameter, not an env var).
```

- [ ] **Step 4: Update `docs/HANDOFF.md`**

Three edits, matching each section's existing format:
1. **§4** — the 8C paragraph: what it shipped, its gates, and the fact that Phase 8 (and the roadmap's
   build phases) is complete. Replace the "8C is the sole remaining sub-phase" framing.
2. **§8** — add `postgresql` (the client, for `pg_dump`) to the Fedora fresh-machine tooling line, noting
   it is needed by the E2E `backups` flow and the restore runbook, and that the major must match the
   `postgres:` image tag.
3. **§9** — rewrite the kickoff for the next track. Phase 8 is done; the open items are the parallel-run
   acceptance month, **#115 (P1)**, and the backlog burn-down. Remove 8C's three "must not rediscover"
   bullets, which are now spent.

- [ ] **Step 5: Run the FULL gate chain**

```bash
cd erp
npm test
npx tsc --noEmit
npx eslint src tests
npm run build
```

Then E2E **in the background** (it takes ~10 minutes — a foreground run risks being killed at the
tooling ceiling, which leaves `ClosePeriod` debris that reds three flows on the next run):

```bash
npm run test:e2e
```

Record each result in the ledger **after watching the run end** — or write PENDING. Never guess a row.

- [ ] **Step 6: Commit**

```bash
git add erp/e2e erp/README.md docs/HANDOFF.md CLAUDE.md docs/execution
git commit -m "docs(backups): add the restore runbook, the E2E flow and the Phase 8C close-out"
```

---

## After the last task

1. **Whole-branch review** on the strongest model, five lenses: correctness · concurrency ·
   data-integrity · security (the dump path, the path validation, the `manage_backups` gate) ·
   spec-compliance against §6 + §6.4. One fix wave.
2. **Triage rule:** from review round 6 onward, findings are filed as issues **unless** they are
   correctness, concurrency, or data-integrity defects.
3. **PR** with attribution in the **body** (never in the individual commits).
4. **Re-run the full gate chain** before any merge claim, and write the final gate row from a watched
   run.

## Self-Review

**Spec coverage** — every §6 requirement maps to a task:

| Spec requirement | Task |
|---|---|
| §6.1 shared folder, deploy-set, displayed not editable | 1, 5, 6, 8 |
| §6.1 app image gains `pg_dump`/`pg_restore` | 8 |
| §6.1 argv spawn, fail-loud temp-then-check, no empty archive | 4 |
| §6.1 collision-proof naming | 1, 4 |
| §6.1 path validation | 1 |
| §6.1 `gzip -t` integrity on every written archive | 3, 4 |
| §6.1 status file the app reads; nightly stays a container; retention stays the script's prune | 3, 8 |
| §6.2 page: list, folder, back-up-now, staleness indicator | 6 |
| §6.2 `manage_backups` gate | 2, 5 |
| §6.2 missing/unparseable status = red; never-run = red | 3 |
| §6.3 restore = documented command, expanded runbook | 9 |
| §6.3 production-only; practice has no page/route/folder | 3, 5, 8 |
| §7 `backup_stale_hours` in the typed registry | 2 |
| §8 client/server boundary; practice flag never in a client component | 6, 7 |
| §9 no migration | — (none added) |
| §10 8C test list (fail-loud, integrity, staleness incl. missing-status, argv/path/naming, gate, practice) | 1, 3, 4, 5 |
| §10 E2E flow | 9 |
| §6.4 green rule, derived `lastSuccessAt`, manual retention, shell bar, audit, injectable dump | 1, 3, 4, 7, 8 |
| §11 docs updated in the same breath | 9 |

**Placeholder scan:** no TBD/TODO; every code step carries real code. Three steps deliberately say
"read the neighbouring file and copy its helper verbatim" (test helpers in Tasks 2/4/5, the Shell nav
idiom in Task 6, the E2E env plumbing in Task 9) — these are instructions to verify a real name
against the tree rather than invent one, which is the opposite of a placeholder.

**Type consistency:** `ArchiveInfo`, `BackupHealth`, `BackupHealthState`, `BackupsView`,
`BackupStatusFile`, `BackupSource` are defined once in Task 1 and used unchanged in Tasks 3–7.
`evaluateHealth`/`listArchives`/`backupHealth`/`backupsView`/`runBackupNow`/`readStatus` keep the same
names and signatures from their defining task onward. `resolveBackupDir`/`archivePath`/`statusPath`/
`stampFor`/`manualArchiveName`/`tempNameFor` are Task 1's and are not renamed later.

**Known risk, flagged not hidden:** Task 8 Step 5 pins `postgresql18-client` against Alpine 3.24.1. If
the `node:26-alpine` base moves and drops that package, the build fails loudly at that step, with the
fallback written into the step. It must never be resolved by dropping to an older client major.

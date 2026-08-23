# Task 4 report — Gate infrastructure (#167b): CI runs the E2E suite

Branch `gate-infrastructure`. One file of substance: `.github/workflows/ci.yml`, plus the two
standing docs.

**Headline, and the honest limit up front: this job has never run on a GitHub runner.** Everything
below is verified by static analysis, by executing each shell block against synthetic fixtures, and
by reading the harness — never by a real CI run. Section 8 lists exactly what a first push will
teach us that I could not.

---

## 1. The job

A **third parallel job**, `e2e`, alongside `ci` and `docker` — the `docker` job's precedent and for
its stated reason (the main job already runs 12+ minutes against a 15-minute cap, so a serial E2E
step would blow it while a parallel job costs no wall clock). No path filter, same argument
`docker` makes: the flows drive the whole app through a browser, so nearly every change affects them.

| # | Step | Notes |
|---|---|---|
| 1 | `actions/checkout@v7` | matches both existing jobs |
| 2 | `actions/setup-node@v7`, node 26, `cache: npm`, `cache-dependency-path: erp/package-lock.json` | copied verbatim from `ci` |
| 3 | `cp .env.example .env` | |
| 4 | `docker compose up -d --wait db` | **once, before everything** — see §2 |
| 5 | Install PostgreSQL 18 client tools | **not in the brief; §3 explains why it is mandatory** |
| 6 | `npm ci` | |
| 7 | `npx prisma generate` | |
| 8 | `npx prisma migrate deploy` | dev `erp` only — `erp_test` is deliberately left unmigrated |
| 9 | `npm run db:seed` | |
| 10 | `npx playwright install --with-deps chromium` | |
| 11 | `npm run test:e2e`, teed to `$RUNNER_TEMP/e2e-console.log` | `timeout-minutes: 25` |
| 12 | Collect the console log into `e2e-artifacts/console.log` | `if: always()` |
| 13 | Check for retried flows | `if: always()`, `id: retries` — §5 |
| 14 | `actions/upload-artifact@v7` → `erp/e2e-artifacts/` | `if: failure() \|\| retried` |

Job `timeout-minutes: 35`. Job-level `defaults.run` sets `working-directory: erp` (matching the
`docker` job's block) **and** `shell: bash` — the latter is not decoration: GitHub's default is
`bash -e {0}`, without `pipefail`, and `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`,
which step 11's `tee` requires. §7 has that RED-verified.

`actions/upload-artifact@v7` is the current major (`gh api repos/actions/upload-artifact/tags`
— v7.0.1 latest), consistent with checkout/setup-node being at v7 here, and dependabot's
`github-actions` group (`patterns: ["*"]`) will maintain it.

**Task 2's change to the documented lint gate was already in `ci.yml`** (`npx eslint src tests e2e`,
commit `6e89d53`). Checked before writing anything; not duplicated.

---

## 2. Container churn — the comment, and why it is a comment rather than a hope

Task 2's measured cause of #184's false failures: Chromium flushes its socket pools and aborts every
in-flight request — `127.0.0.1` included — when the **host's** network configuration changes, and on
Linux every container start or stop creates or destroys a `veth` pair, which is exactly such a change.

In CI that is benign **only if nothing starts or stops a container while the suite runs**. So the
database comes up at step 4 and is never touched again, and the job carries a block comment saying
so in the terms that make it un-undoable by accident:

> NOTHING MAY START OR STOP A CONTAINER WHILE THE SUITE RUNS. […] Do not add a mid-run `docker`
> step, a service container that restarts, or a compose down/up between flows — it would
> deliberately reintroduce the exact flake this group removed.

Worth recording for whoever reads this next: GitHub `services:` containers also start before the
job's steps and do not churn mid-run, so a future migration from compose to `services:` would not
break the property — but a `docker build`, a testcontainers-style step, or a `compose restart`
inserted between steps 10 and 11 would.

---

## 3. Found and fixed: without a PostgreSQL 18 client, the `backups` flow reds in CI

**Not in the brief, and the job would have failed on its first push without it.**

`e2e/flows/backups.mjs` clicks "Back up now" and asserts a real archive row plus a green indicator.
That spawns a genuine `pg_dump` inside the app (`src/server/backups.ts:536`, `opts.dumpBin ??
"pg_dump"`), and the flow's own header says why it is special:

> The host's pg_dump is major-matched to the postgres:18 server (§6.4); vitest deliberately does NOT
> use it (CI's is older and pg_dump refuses a newer server), so this flow is the only place the real
> binary is exercised.

That sentence is a statement about CI written by someone who knew the E2E suite did not run there.
`CLAUDE.md` says the same thing twice, and `Dockerfile` solves it for the image with
`apk add --no-cache postgresql18-client`. `ubuntu-latest` ships an older client, and `pg_dump`
hard-refuses a newer server — so the flow would fail ~8 minutes into the run with a failure that
looks nothing like its cause.

The job therefore adds the PGDG apt repo and installs `postgresql-client-18`, version-locked to
`docker-compose.yml`'s `postgres:` tag (the same rule the Dockerfile follows, and the reason
dependabot is already told not to auto-bump that image). **It asserts the resulting major rather
than trusting the `postgresql-client-common` alternatives wrapper to pick the newest** — the whole
point is that a silent 16 is the failure mode. The assertion was exercised against four version
strings:

```
  ACCEPT   pg_dump (PostgreSQL) 18.2 (Ubuntu 18.2-1.pgdg24.04+1)
  REFUSE   pg_dump (PostgreSQL) 16.10
  ACCEPT   pg_dump (PostgreSQL) 18
  REFUSE   pg_dump (PostgreSQL) 181.0
```

---

## 4. Task 3's pre-flight cannot trip on a CI database — read, not assumed

`e2e/lib/preflight.mjs` refuses on exactly three conditions, and each is false by construction on a
`migrate deploy` + `db:seed` database:

| Condition | Source | On a fresh CI DB |
|---|---|---|
| a `ClosePeriod` row covering the current month | `prisma.closePeriod.findFirst({ where: { year, month } })` | no `ClosePeriod` rows exist → `null` |
| an OPEN receipt batch carrying a payment dated in it | `preliminaryReport().unpostedBatchCount` | no `PaymentBatch`/`Payment` rows → `0` |
| a non-zero continuity variance | `schedule.variance = (rf.endingCents - cents(agingEndingAr)) / 100` (`close-periods.ts:206`) | no invoices, no payments → `0 - 0 = 0` |

`preflightRefusal` returns `null` when all three are clear, so the run proceeds. The refusal exists
for a **dev box carrying the demonstration dataset**; a CI database is pristine by definition, and
the recipe it would print (`npm run db:reset`) is never reached.

Corroborating rather than substituting for that reading: the brief's measured fact — a pristine
`erp` runs the suite green, verified repeatedly — could not be true unless the pre-flight passed,
since it runs before flow 1 and throws.

Also confirmed by reading `main()`: `assertDevDb` requires the database to be named exactly `erp` on
a local host, which `.env.example`'s `DATABASE_URL` satisfies.

---

## 5. `RETRIED` in CI — the decision, and the argument I decided against

**Decision: CI SURFACES a retry and does not fail on it — provisionally, with the flip condition
named in the file rather than left to taste.** This is the judgement call to challenge hardest.

The case for **failing**, which I took seriously and rejected:

- The repo's own principle, from Task 2's report: *a red run that names its cause beats a green one
  bought by re-running.* In CI the retry's entire justification — host container churn the developer
  cannot control — is absent by construction (§2), so a granted retry there really is a green bought
  by a re-run with no excuse.
- A warning nobody reads is how #167 happened in the first place.

The case for **surfacing**, which won:

1. **The flows passed.** #184's retry gate grants a second attempt only when the failure was
   transport-level *and* the flow had provably mutated nothing. It is a statement about the wire, not
   about the app under test, and never about the PR's diff. Reddening someone's unrelated PR for a
   runner-level fact is the "gate that lies" failure this whole group exists to remove — and it is
   precisely why the brief ordered Task 2 before Task 4: *"putting a gate with a ~50% false-failure
   rate in front of every PR would be worse than not having it."* Introducing this gate and
   simultaneously arming a red trigger on an unmeasured condition contradicts that ordering.
2. **There is no CI measurement, and one plausible mechanism is not churn at all.** Task 2's
   classifier treats a `page.goto:` navigation timeout as network-level. A 4-core runner compiling
   `next dev` routes under Chromium can plausibly produce one. Hard-failing on day one would be an
   inference dressed as a policy — the prime directive's exact prohibition.
3. **Failing on it also loses information.** "Retry still runs, but reds the run" strictly dominates
   "disable the retry" (you learn whether attempt 2 passes, and you get both attempts' artifacts), so
   the only real question was red-vs-warn, not retry-vs-no-retry.

So it is made impossible to miss instead of impossible to merge:

- a `::warning::` annotation, which lands on the run's summary page, not buried in a log;
- a `### E2E: a flow was retried` block in `$GITHUB_STEP_SUMMARY`, listing the retry artifact dirs;
- the **full artifact package** — the same one a failure gets, both attempts included.

**And the flip is one line, stated in the file:** *"once a baseline of clean CI runs exists and the
expected retry rate is zero: change the `exit 0` at the end of this step to `exit 1`. Nothing else
needs to move."*

**Two detectors, OR'd**, because each couples to something the harness owns and neither should be
the only one:

- `e2e-artifacts/*__attempt-*` — the directory `runFlow` creates for a second attempt
  (`run.mjs:417`). Fires whether the retry passed or failed.
- `^  RETRIED ` in the console log — the summary-table verdict (`run.mjs:688`), which prints only
  when `r.ok && r.retried`, i.e. **only when the run went green BECAUSE of a retry** — the case that
  would otherwise be silent.

A format change in one does not silently lose the signal. The coupling is real and is called out in
the comment; it is not pinned by a test (see §9).

---

## 6. `e2e-artifacts-prev/` in CI — asked, answered

**It does not matter, and it is deliberately not in the upload path.** `main()` (`run.mjs:566-575`)
`rm -rf`s `e2e-artifacts-prev/`, then `rename(ARTIFACTS_DIR, PREV_ARTIFACTS_DIR)` inside a
`try`/`catch` that swallows `ENOENT`. On a fresh CI workspace `e2e-artifacts/` does not exist, so the
rename hits `ENOENT`, `rotated` stays false, and `e2e-artifacts-prev/` is **never created**.

It is an affordance for a developer habit CI does not have — re-running after a red to see whether it
clears — and adding it to the upload glob would upload nothing while implying otherwise.

---

## 7. Verification — what was actually run

Not a single gate in `CLAUDE.md`'s list is affected: the diff is one YAML file and two markdown
files, no source and no tests. Running `npx vitest run` or `npx tsc --noEmit` would have proved
nothing about it and would have contended with the concurrent task on the shared databases, so I did
not. Per the brief, `npm run test:e2e` was **not** run.

What was run instead:

| Check | Result |
|---|---|
| `python3 -c "yaml.safe_load(...)"` — full-file parse, jobs/steps/`if`/timeouts dumped | parses; `jobs: ['ci', 'docker', 'e2e']`, job timeout 35, step 11 timeout 25, `if` on steps 12–14 as intended |
| **actionlint 1.7.12** (downloaded at the pinned latest tag) | **exit 0, no findings** |
| **actionlint + shellcheck 0.11.0** integration over every `run:` block | one finding, **pre-existing and not mine**: `ci.yml:95 SC2034 "i appears unused"` in the `docker` job's `for i in $(seq 1 60)` retry loop. Left alone. |
| `bash -n` on all 25 `run:` blocks in the workflow | all OK |
| tabs / CRLF / trailing whitespace | clean |

**The three scripted steps were extracted and executed** under GitHub's real shell invocation
(`bash --noprofile --norc -eo pipefail`) against synthetic fixtures:

*Step 13, four scenarios:*

```
A: clean run, no retry           -> retried=false, no annotation, no summary written
B: retry granted AND passed      -> retried=true,  1 annotation, 396-byte summary
C: retry granted, failed twice   -> retried=true,  1 annotation, 396-byte summary
D: RETRIED line only, dir absent -> retried=true,  1 annotation, 326-byte summary
```

plus the degenerate case — no `e2e-artifacts/` and no console log at all, which is what an earlier
step failing produces — which correctly prints `No flow needed a retry`, writes `retried=false`, and
exits 0 rather than dying under `set -e`.

*Step 11, `pipefail` RED-verified rather than asserted.* With a stub `test:e2e` that prints and exits
1:

```
with    -o pipefail : step exit=1   and the log was still captured
without -o pipefail : step exit=0   -> the gate would lie
```

That is the whole reason `shell: bash` is in the `defaults` block, demonstrated rather than argued.

*Step 12* was run with the log present (copies to `e2e-artifacts/console.log`) and absent (exit 0).

---

## 8. What only a real CI run can settle

Listed plainly, because a reviewer should not have to infer them.

1. **The two timeouts.** 25 min on the suite step, 35 on the job. Derivation: three clean local runs
   at 298/301/317 s on a 16-core box (call the suite 5.3 min), plus ~5–7 min of CI setup — the
   `postgres:18` pull, the pg client install, `npm ci`, `prisma generate` + `migrate deploy`, the
   seed, and `playwright install --with-deps`, which downloads Chromium *and* apt-installs its system
   libraries — and a 3x working / 4x pessimistic runner-speed factor on the suite itself (16–21 min).
   Pessimistic total ≈ 28 min. **These are estimates.** The comment says so and says to tighten them
   against the first green runs.
   The *structural* half is not an estimate and is the load-bearing part: **the step number must stay
   below the job number**, because a JOB timeout cancels the job and a cancelled job skips its
   remaining steps — including the upload. A hung suite under a job-level-only timeout produces a red
   run with no screenshots, no video and no `dev-server.log`, i.e. exactly the outcome #167b names.
2. **Whether the PGDG install works on the runner image as written.** The commands are the documented
   PGDG-for-Debian/Ubuntu recipe; I could not execute them here. If it fails it fails loudly, in its
   own named step, before anything expensive.
3. **Whether `--with-deps` needs anything else.** The runner's passwordless sudo is what Playwright's
   installer expects; unverified here.
4. **Timezone.** GitHub runners are UTC; this dev box is not. The pre-flight and `close-month-end`
   both derive their month in UTC and therefore cannot disagree with each other, but no flow was
   inspected for a *rendered* local-date assertion. UTC is the more canonical environment, so if this
   bites it is a latent bug the job has surfaced, not one it caused.
5. **Whether any flow is genuinely 4-core-hostile.** The suite is 25 flows of real browser work
   against `next dev`; nothing in it was profiled under CPU contention.

Expect one iteration. If the first push reds, the highest-prior candidates are (2), then a timeout,
then (5).

---

## 9. Found, not fixed

- **Step 13 couples to two harness-owned surface details** — a directory name (`__attempt-N`) and a
  console-log line shape (`^  RETRIED `) — and **nothing pins either.** `tests/e2e-harness.test.ts`
  is the natural home for an assertion that the summary-table verdict still starts with two spaces
  and the literal `RETRIED`. Not added here: the file belongs to Task 2, another task is live on the
  shared test DB, and I could not have run vitest to prove the assertion green. Filed as part of
  **#190** in the fix round (§11).
  *Corrected in the fix round:* the OR'd second detector is **not** a mitigation for the coupling in
  any strong sense. `runFlow` mkdir's the attempt directory unconditionally at the top of attempt 2,
  so detector 1 fires for every granted retry, passed or failed — it is already complete on its own,
  and the `RETRIED` verdict covers a strict subset (green-on-retry). The pair protects against a
  **rename** of one surface, not against a missed case. The risk is real but lower than stated here
  originally.
- **Branch protection still requires only the `ci` check**, so `e2e` will run on every PR but will
  **not block a merge** until the owner adds it to the required checks in repo settings. Recorded in
  HANDOFF §5a under "Still owed by the owner". Until then #167b's claim is honestly "runs in CI", not
  "gates merges".
- **No browser caching.** `npx playwright install` re-downloads Chromium every run (~60–120 s).
  Boring first, the `docker` job's stated philosophy; the upgrade is `actions/cache` on
  `~/.cache/ms-playwright` keyed on the `playwright` version in `package-lock.json`. Worth doing only
  once the real per-run cost is measured.
- **`ci.yml:95` `SC2034`** — pre-existing unused `i` in the `docker` job's retry loop. Cosmetic;
  untouched deliberately, since silencing it means editing a job this task does not own.
- **`npx eslint src tests e2e` does not cover `scripts/`** (Task 3 noted the same). Unchanged here.

---

## 10. Docs updated in the same breath

- **`CLAUDE.md`** — one paragraph after the "Run `npm run test:e2e` whenever…" rule, naming the four
  load-bearing properties of the job (container-churn rule, pg-client major lock, the `RETRIED`
  policy and its one-line flip, and the step-inside-job timeout reason).
- **`docs/HANDOFF.md` §5a** — the standing record, placed beside Task 2's `ERR_NETWORK_CHANGED`
  paragraph and Task 3's dataset paragraph, with the estimates flagged as estimates and the
  branch-protection gap flagged as owed by the owner.
- The spec decision log is **not** touched: this changes no product contract.

---

## 11. Fix round (2026-08-22) — one Important, ten minors

The reviewer's Important finding was correct and would have red every run. Everything below is
again verified by static analysis, primary-source reading and fixture execution — **this job has
still never run on a GitHub runner**, and §8 still lists what only a real run settles.

### The Important one: the PGDG step resolved to PostgreSQL 16

The reviewer's evidence chain, re-verified here from the upstream sources rather than taken on
trust (`pg_wrapper` and `PgCommon.pm`, salsa.debian.org `postgresql/postgresql-common`):

```perl
# pg_wrapper
($version, $cluster, $db) = user_cluster_map() unless ($cluster or $explicit_host or $explicit_port);
...
if (not $version or $cmdname =~ /^(psql|pg_archivecleanup|pg_isready)$/) {   # pg_dump is NOT on this list
```

```perl
# PgCommon.pm, user_cluster_map()
# if only one cluster exists, use that
return ($last_version, $last_cluster, undef) if $count == 1;
```

`/usr/bin/pg_dump` is a `pg_wrapper` symlink, not an alternatives link. `postgresql-client-18`
creates no cluster; the `ubuntu-24.04` runner image leaves a stopped-but-undropped `postgresql-16`
cluster at `/etc/postgresql/16/main`. One cluster ⇒ `user_cluster_map()` returns 16 ⇒ `$version` is
set ⇒ the newest-version override never applies to `pg_dump`. **A bare `pg_dump` on that image is
PostgreSQL 16's**, and the original step's assertion — faithful to the app's own resolution, which
is why it was worth keeping — would have failed in step 5 of every run.

**Fix chosen: the explicit `$GITHUB_PATH` prepend, not `pg_dropcluster`.** Both work. The prepend
was chosen because it removes the question rather than re-answering it: `pg_dropcluster 16 main`
hardcodes the image's *current* cluster version and name (a runner-image bump to 17 breaks the
command outright), and it works only by dropping the count to zero so that the newest-version
*heuristic* takes over — the same heuristic that produced the bug. An absolute path beats the
wrapper regardless of how many clusters exist or what the image ships next.

Because `$GITHUB_PATH` applies only to **subsequent** steps, the assertion moved into its own step,
`Verify a bare pg_dump resolves to PostgreSQL 18`. That is strictly better than asserting the
absolute path in the same step: it invokes a **bare** `pg_dump` under the exported PATH, which is
the same lookup `src/server/backups.ts`'s `spawn("pg_dump", …)` performs (no `-h`/`-p`,
`PGHOST`/`PGPORT` unset) — the assertion is the app's resolution, not a proxy for it.

**The wrong comment at the old `ci.yml:181-182` is gone.** It said the step declined to trust "the
`postgresql-client-common` alternatives wrapper to pick the newest", which is wrong twice. The
replacement states the mechanism — symlink to `pg_wrapper`, `user_cluster_map()` first, the
three-command newest-version list `pg_dump` is not on, the runner image's undropped 16 cluster —
and says why the prepend is the fix rather than a belt-and-braces extra.

Kept as-is, per the review: the ASCII-armored key at `signed-by=`, `$(lsb_release -cs)` → `noble`,
no `pgdg.list` collision.

### The ten minors

| # | Finding | Disposition |
|---|---|---|
| 1 | Cancellation mechanism stated wrongly in three places | Fixed in all three — `ci.yml`, `CLAUDE.md`, `HANDOFF` §5a |
| 2 | Invariant is `job ≥ step + setup + upload`, not `step < job` | Written as arithmetic in the comment |
| 3 | 25 min derived from the *fastest* runs | Re-derived from the slowest; **step 30, job 45** |
| 4 | Warm-up's 240 s aggregate budget refuses the whole run in CI | `E2E_WARMUP_BUDGET_MS: 600000` at job level, with the reasoning |
| 5 | "a parallel job costs no wall clock" no longer true | Sentence replaced; the decision restated on its real grounds |
| 6 | `CLAUDE.md` hardcodes 25/35 | Numbers removed; it states the *relation* and the sizing rule |
| 7 | `pg_dump --version \| grep -q` can SIGPIPE under `pipefail` | No pipe at all — captured to `$ver`, matched with `[[ =~ ]]` |
| 8 | Early failure ⇒ spurious empty-artifact warning | Fixed twice over — see below |
| 9 | No forcing function for the `RETRIED` flip | **Issue #190** filed, `ready-for-agent`, referenced in the workflow |
| 10 | Detector coupling described as stronger than it is | Comment and §9 corrected |

**(1) The cancellation mechanism.** A cancelled job does **not** skip its remaining steps —
`always()`- and `cancelled()`-conditioned steps are evaluated inside the cancellation window. The
upload is lost because a JOB timeout *cancels* the job, and for a cancelled job `failure()` is
FALSE and the suite step's `outcome` is `cancelled`, not `failure`, so the upload's condition never
becomes true; and a ~65 MB upload inside a short best-effort window is not something to stake the
evidence on regardless. The step-below-job ordering stays load-bearing; only the reason changed.

**(3) The re-derivation.** The old 25 came from Task 4's own 298/301/317 s. Task 3 ran the *same*
suite on the *same* box at **~6 min, twice** (report §, runs 1 and 5) — the slowest clean
measurement available, and the one a cap must be built on. 6 min × the 3–4x runner factor = 18–24
min, so 25 left one minute of margin against the pessimistic case. **Step 30 / job 45**, sized by
`job ≥ setup + suite + retry-check + upload` = `8 + 30 + 1 + 3 = 42`, 3 min spare. The comment now
says "raise the step and the job MUST move with it".

**(4) The warm-up budget.** `e2e/lib/warmup.mjs` defaults `budgetMs` to 240 000 and
`warmupRefusal` refuses the **whole run** if any route went unissued — a failure mode that looks
nothing like a timeout and appears only in CI. 240 s is ~8x a 30.6 s local cold compile; at 3–4x
that margin is ~2x. Set to 600 000 at job level (≈5x the pessimistic 120 s), inside the step's 30
min, and flagged to be tightened with the timeouts.

**(8) The empty-artifact warning, fixed at both ends.** `mkdir -p e2e-artifacts` moved *inside* the
`if [ -f … ]` guard, so a run that never reached the suite creates no directory; and the upload's
condition became
`always() && (steps.suite.outcome == 'failure' || steps.retries.outputs.retried == 'true')`
— keyed on the suite step (now `id: suite`) rather than a bare `failure()`, which is true for a
failure *anywhere* in the job. A skipped step is absent from the `steps` context, so
`steps.suite.outcome` is null and the comparison is false; the `retries` step is `always()`, so it
still runs and reports `retried=false`. Net: an `npm ci` or pg-version failure no longer fires an
upload at all.

**(10) What the two detectors actually buy.** `runFlow` calls `mkdir(flowDir, {recursive:true})`
unconditionally at the top of attempt 2 (`e2e/run.mjs`), so the `*__attempt-*` glob fires for
**every** granted retry, passed or failed — detector 1 alone is complete. The `RETRIED` verdict
fires only on green-on-retry. The pair is therefore redundancy against a **rename** of either
surface, not extra coverage. The comment and §9 now say that instead of implying the two are
complementary. Neither is pinned by a test; #190 names that too.

### Verification — what was actually run this round

| Check | Result |
|---|---|
| **actionlint 1.7.12** (downloaded, pinned tag) | one finding, the same **pre-existing** `ci.yml:95 SC2034` in the `docker` job's `for i in $(seq 1 60)`. Nothing in `e2e`. |
| **shellcheck 0.11.0**, via `actionlint -shellcheck` over every `run:` block | same single pre-existing finding |
| Full YAML parse + step dump (`yaml.safe_load`) | `jobs: ['ci','docker','e2e']`; job timeout 45; job `env.E2E_WARMUP_BUDGET_MS=600000`; `id: suite` / `timeout-minutes: 30`; the three `if:` expressions as intended |
| `bash -n` on **all 26** `run:` blocks | all OK |
| `ci`/`docker` jobs unchanged | lines 1–110 byte-identical to the pre-fix file (`md5sum`) |

**The changed scripted steps were executed** under GitHub's real shell invocation
(`bash --noprofile --norc -eo pipefail`) against synthetic fixtures.

*The new pg_dump assertion, six version strings — the two new rows are 17.x (the next plausible
wrong answer) and a beta:*

```
  ACCEPT   pg_dump (PostgreSQL) 18.2 (Ubuntu 18.2-1.pgdg24.04+1)
  REFUSE   pg_dump (PostgreSQL) 16.10          <- the bug this round fixes, RED-verified
  ACCEPT   pg_dump (PostgreSQL) 18
  REFUSE   pg_dump (PostgreSQL) 181.0
  REFUSE   pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)
  ACCEPT   pg_dump (PostgreSQL) 18.0-beta1
```

plus `pg_dump` absent from PATH entirely → `rc=127`, failing fast under `-e` rather than passing an
empty version string. No pipe remains in the step, so the SC/141 path from minor 7 is gone by
construction rather than by test.

*The collect step, both branches, checking the new property:*

```
  log present : rc=0, e2e-artifacts/console.log written
  log absent  : rc=0, e2e-artifacts/ NOT created      <- minor 8, first half
```

*The retry detector, re-run unchanged after the rewrite (5 scenarios):*

```
A clean run                    -> retried=false, no annotation, no summary
B retry granted AND passed     -> retried=true,  annotation, 390-byte summary
C retry granted, failed twice  -> retried=true,  annotation, 390-byte summary
D RETRIED line only, dir absent-> retried=true,  annotation, 326-byte summary
E no artifacts and no log      -> retried=false, exit 0 (does not die under set -e)
```

*The suite step's `pipefail` property, RED-verified again after adding `id:`:*

```
with    -o pipefail : step exit=1   and the log was still captured
without -o pipefail : step exit=0   -> the gate would lie
```

Per the brief, `npm run test:e2e`, the full `npx vitest run` and `npm run db:reset` were **not**
run — another task holds the dev database and port 3100. The diff is one YAML file and three
markdown files: no source, no tests, no gate in `CLAUDE.md`'s list is affected.

### Still only a real runner can settle it

§8's list stands, minus item 2, which this round converted from "unverified" to "verified wrong and
fixed" for the resolution half — the *apt* half (does the PGDG repo add and install cleanly on the
image?) is still unexercised, and still fails loudly in its own named step before anything
expensive. Added to that list:

6. **Whether `/usr/lib/postgresql/18/bin` is where the Ubuntu `postgresql-client-18` package puts
   the binaries.** It is the PGDG layout and it is where `pg_wrapper` itself execs from, but it was
   not observed on the image. If it is wrong the new verify step reds immediately, by name.
7. **Whether 8 min of setup and 3 min of upload are the right terms in the job-timeout arithmetic.**
   Both are estimates; the first green run replaces them with measurements.

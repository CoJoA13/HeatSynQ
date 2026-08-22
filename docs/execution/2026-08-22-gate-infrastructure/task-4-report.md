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
  shared test DB, and I could not have run vitest to prove the assertion green. Worth a follow-up
  issue; the OR'd second detector is the mitigation, not a substitute.
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

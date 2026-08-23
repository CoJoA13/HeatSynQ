# Gate infrastructure — the checks everything else is verified by

**Branch:** `gate-infrastructure` off `main` at `9090a4d`.
**Closes:** #167, #169, #184, #188.

Round 3 fixed defects the gates found. This group fixes the gates. All four issues were raised by
the pre-acceptance verification pass or by the reviews inside round 3, and they share one shape:

> **A check that does not run, cannot be reproduced, or can pass while the thing it checks is
> broken.**

- **#167** — the mandatory E2E gate never runs in CI, and the documented demonstration dataset
  reds two of its flows on any developer machine that follows the instructions.
- **#184** — that same gate produced a false failure on 3 of 4 runs in one group, three different
  flows, every failing run started straight after a full vitest.
- **#169** — `manual.html` fits under the publish ceiling only because someone ran ImageMagick by
  hand, twice, in two sessions, in a step recorded nowhere.
- **#188** — the invalidation census decides "does this file call `invalidateHistory()`?" with a
  regex over source text, so a string literal reads as a call.

**#188 was added to this group by owner ruling, 2026-08-22.** It was filed out of #158's review as
a deliberate non-fix. It belongs here rather than with the wording defects: it is a check that
shipped nine days ago with two known blind spots, and the code is still fresh.

## The ordering is forced by the defect itself, and that is worth noting

Task 5 (#169) needs the demonstration dataset **in the dev database** — the manual photographs it.
Tasks 2–4 need a dev database **without** it, because that dataset reds two E2E flows. The two
requirements are mutually exclusive today, which is precisely what #167 is about.

So: **1 → 2 → 3 → 4 on a pristine dev DB, then 5 last**, after seeding the dataset. Do not
re-order. The one group whose task order is dictated by the bug it is fixing.

You have standing permission to drop, reset and re-seed the local `erp` dev database.

---

## Task 1 — #188: parse the source, stop pattern-matching it

`tests/audit-children.test.ts`'s `callsInvalidate` strips comments by hand and tests the remainder.
It handles both comment forms, in the one order that works, with seven regression cases pinning
why. It does **not** exclude string or template literals:

```ts
const hint = "invalidateHistory()";   // ...and no real call anywhere
```

reads as wired. Both sweeps stay green while the mounted panel goes stale — the exact regression
the census exists to prevent.

**Do not add an eighth regex.** Four defects were injected into this file's own guards across two
review rounds, every one of them by hand-munging source, every one caught by running it rather than
by reading it. `typescript` is already a devDependency: `ts.createSourceFile` + a walk for a
`CallExpression` whose callee is an identifier named `invalidateHistory` answers the question
exactly, with comments, strings and template literals handled by the parser.

- Keep **all seven** existing detector cases green — they are the regression record, not scaffolding.
- Add the string-literal case, a template-literal case, and a property-access case
  (`x.invalidateHistory()` is not the imported function; decide and state which way that goes).
- RED-verify against a genuinely broken tree: replace a real call with a string literal holding the
  same text and watch the sweep go red. A guard that has never been seen to fail is not a guard.

**Out of scope, deliberately:** the wrapper-tracing half of #188 (an import-graph walk so a page
rendering `<HistorySection />` is seen as a panel page). No wrapper exists — all twelve files mount
the panel directly — and the right shape is informed by the first real case. The comment saying so
stays and stays honest. **Also out of scope:** re-cutting `issuesMutatingRequest` on the AST. It is
deliberately broad and fails CLOSED; narrowing it is a different decision than this one.

## Task 2 — #184: a gate that lies half the time teaches people to re-run

Three fixes, and one of them needs a design call.

**(a) Warm the dev server before flow 1.** `waitForServer` polls `/login` until anything under 500
comes back — that compiles exactly one route. Every other route compiles on its first hit, inside a
flow, under whatever load the machine is still carrying. Warm a representative set of routes with
real requests and discard the results. This is the fix that targets the diagnosed cause; the other
two make the next occurrence diagnosable.

**(b) Capture the dev server's output into the artifacts directory.** The harness already
accumulates it in `getOutput()` and prints it only when startup times out. Both implementers who
hit this had to reason from a screenshot. Write it on every run, not only on failure.

**(c) Classify the failure, and retry only when a retry is provably safe.** A `Failed to fetch`
with no HTTP status is categorically different from an assertion failure, and printing them
identically is what makes an honest report ("23 of 24, and I cannot show you a clean run")
indistinguishable from a careless one.

The issue asks for a single retry on a network-level failure. **A blind retry is not safe here:**
flows create real orders through the real UI, and `template-build-and-load` leaves a template three
later flows consume. Re-running a flow that failed at step 40 duplicates everything it did in steps
1–39.

**The retry is safe exactly when the flow has not yet successfully mutated anything, and that is
observable.** Count mutating requests that came back 2xx, via `page.on("response")`, excluding the
session endpoint (login is a POST, and re-login is idempotent). Retry once **iff** the failure is
network-level **and** that count is zero. Everything the issue's three observed failures look like
— every panel of a page failing at once, a 5 KB blank page — is a first-load failure, which is
exactly the case this admits.

A retried flow prints as `RETRIED`, never as a plain `PASS`, in the per-flow line **and** the
summary table. If it fails twice it is a failure like any other.

## Task 3 — #167a: two assertions about ambient state, and one that cannot be scoped

`npm run db:seed` followed by `prisma/manual-seed.ts` — the documented way to build the
demonstration dataset — reds two flows. Neither failure has anything to do with the code under test.

**`invoice-shipped-order:106` is straightforwardly wrong and gets option (1).** It asserts the
invoice carries exactly one SURCHARGE row, which is true only while the plant holds exactly one
active plant-wide surcharge. The dataset seeds three. Scope it to the fixture's **own** surcharge by
name — the assertion two lines below already reads that name, and with three rows on screen its
`.locator("input").first()` is reading whichever row sorted first, which is a latent bug of its own
independent of the count. Assert: exactly one SURCHARGE row carries `fixtures.invSurchargeName`.

**`close-month-end:378` cannot be scoped, and pretending otherwise would be worse than the bug.**
`unpostedBatchCount` and the continuity `variance` are **global figures for the month** — that is
what a month-end close is. The dataset deliberately leaves one OPEN receipt batch to demonstrate
that state, and an open batch's cash is invisible to `paymentTotal` while its on-account cash is
still visible to the aging column, so the variance is structurally nonzero. The flow already
refuses to post a batch it did not create ("never touch a stranger's dev-DB row"), and that
discipline is correct and stays.

So this half gets option (3), done properly rather than as a README note:

- **A pre-flight check in the harness**, before flow 1, that inspects the dev DB for the ambient
  conditions the suite genuinely cannot tolerate — today: an OPEN receipt batch the run does not
  own, dated the current month. Refuse the **whole run** with the reason, the evidence (the count),
  and the recipe. A named refusal in one second beats flow 20 failing on an opaque number after
  eight minutes.
- **Narrow it to what is actually incompatible.** Once the surcharge assertion is scoped,
  surcharges are no longer a precondition — do not list them. A pre-flight that over-refuses is a
  pre-flight people disable.
- **`npm run db:reset`.** There is currently no supported way to reset the dev database at all;
  `db:seed` and `db:seed:demo` neither of them truncate. The recipe the refusal prints has to
  exist.

Record the incompatibility in `docs/manual/dataset.md` and HANDOFF: **the demonstration dataset and
the E2E suite cannot share a database**, with the transition in both directions spelled out.

## Task 4 — #167b: CI runs the E2E suite

`grep -n "e2e" .github/workflows/*.yml` returns nothing. The gate the owner made mandatory on
2026-08-06 — *"whenever a change touches any UI, function, or flow"* — has never once run in CI.
PR #164 was green while shipping the dataset breakage in Task 3, because CI had neither the dataset
nor the flows.

A **separate parallel job**, the `docker` job's precedent and for its stated reason: the main `ci`
job already runs 12+ minutes against a 15-minute cap, and a serial E2E step would blow it.

- Pristine `erp` database: `migrate deploy` + `npm run db:seed`. The harness seeds its own
  order-entry-gate prerequisites (company identity, GL accounts, `arGlAccountId`) and restores them
  on cleanup, and the eight Standard templates come from migrations — so a migrated-and-seeded
  database should be sufficient. **Verify that claim by running it against a freshly dropped local
  `erp`, do not assume it.**
- `npx playwright install --with-deps chromium` — the suite drives bundled Chromium.
- Upload `e2e-artifacts/` on failure. A red CI run with no screenshot and no video is a red run
  nobody can act on.
- **Measure the wall time and set the timeout from the measurement**, with real headroom: a cold
  `next dev` in a CI container compiles slower than any developer machine, which is the same
  cold-compile effect Task 2 is fixing. State the number in the report.

Task 2 lands first for a reason: putting a gate with a ~50% false-failure rate in front of every PR
would be worse than not having it.

## Task 5 — #169: figures the repo can actually regenerate

`docs/manual/manual.html` is 14.60 MB against a 16 MB publish ceiling, and it only fits because
`magick -colors 256 -depth 8 -strip` was run over `docs/manual/img/` by hand. `manual:capture`
writes ~24 MB. The next person to run capture-then-build gets a ~28 MB page that cannot be
published, with nothing telling them why — the exact rot `manual:build` was written to end.

**Capture at `deviceScaleFactor: 1`** (option 1). The knob already exists —
`DEVICE_SCALE = Number(process.env.MANUAL_SCALE ?? 2)` — so this is the default, not new
machinery. The manual lays figures out in a 1200px column, so the extra density is not being used.

**The coupled change that must land in the same commit.** `build-manual.mjs` computes display size
as `round(intrinsic × 10/24)`, and that constant *is* `1200/2880` — it hardcodes the
DSF-2-at-1440 assumption. Change the capture scale without it and every figure renders at half size.

Make the rule resolution-independent: **display width = the column width when the image is at
least that wide, else its intrinsic width**, height scaled by the same ratio. Then any future
capture-size change is free. Note this also *fixes* a live distortion — a 600 CSS px element clip
captured at DSF 2 is 1200 physical px and currently displays at 500, when 1:1 would be 600.

**The acceptance test is the whole point of the issue:** capture → build → the page is under the
ceiling **with no hand step anywhere**. Report the byte count. A result that needs ImageMagick to
fit has not fixed this.

Two things to know going in:

- `invoicing-detail.png` is 5934×5736 — **wider than the 2880 every other full-page shot is**,
  because the invoice page overflows horizontally. That is #170 (the History panel printing raw
  snapshot JSON unwrapped). Not in scope; worth knowing that fixing #170 later shrinks the single
  largest figure in the manual by a lot.
- `img/` holds five screenshots no chapter references. That is correct by design — capture
  photographs every screen, the manual chooses a subset, and the build reports them as a note. Do
  not delete them and do not make it an error. **`orders-detail.png` going unused is a separate
  content observation** (chapter 2 carries no figure of the order hub); file it, do not fix it here.

---

## Process

House process, unchanged (owner ruling, 2026-08-22: *"Keep it as-is"*):

- This brief is committed **first**, before any task starts.
- A fresh implementer subagent per task; an independent `task-reviewer` per task; fix rounds until
  approved; a whole-branch review before the PR.
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution
  trailer on individual commits**.
- Full gates plus **`npm run test:e2e`** — which this group is largely about, and which therefore
  gets run more than usual and reported honestly each time, including the runs that go red.
- Updating `CLAUDE.md`, `docs/HANDOFF.md` and the spec decision log is part of the work, not a
  follow-up.

## What "done" looks like

| # | Claim the PR must be able to make |
|---|---|
| 188 | A string literal holding `invalidateHistory()` reds the census. Demonstrated, not argued. |
| 184 | The dev server is warm before flow 1; its log is in the artifacts; a network failure is named as one; a retry happens only when nothing was mutated. |
| 167a | A dev DB carrying the demonstration dataset is refused **by name, in one second**, with a recipe that exists. |
| 167b | E2E runs in CI, on every PR, with a measured timeout and artifacts on failure. |
| 169 | `manual:capture && manual:build` produces a publishable page with no hand step. Byte count stated. |

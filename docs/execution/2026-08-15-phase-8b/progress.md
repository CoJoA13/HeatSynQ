# Phase 8B — Practice DB & First-run Wizard: execution ledger

**Branch:** `phase-8b-practice-wizard` · **Plan:** `docs/superpowers/plans/2026-08-15-phase-8b-practice-wizard.md`
**Design spec:** `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` §5 (contract).

**Provenance.** Plan built from a 10-agent touchpoint-mapping pass + controller verification of the load-bearing anchors (render.ts:307 double-stamp seam, orders.ts:676-678 gate site, truncateAll arGlAccountId-NULL, layout.tsx/Shell early returns, Part.billForCert no-writer). A **3-lens adversarial plan review** (house-rules/data-integrity · feasibility · spec-coverage) ran 2026-08-15; every substantive finding folded into the plan before execution (opt-in gate-prereq harness, ambient-singleton demo seed + auth bootstrap, §5.7 password reminder, reprint-watermark test, banner-E2E home).

**Owner decisions (2026-08-15):** deploy = dedicated `practice` profile + port 8080; demo slice designed by controller, owner reviews at T12; order-gate = all three company fields; practiceMode db-identity authoritative (loud throw on dangerous mismatch); /setup admin-gated + surfaced-until-complete; first-population = documented one-time guarded seed command; §5.7 = live signal + client-side dismiss (no schema field).

**Execution loop:** fresh subagent per task (TDD, small commits, no attribution trailer) → controller runs full gates → independent task-reviewer per task → fix rounds → whole-branch review → PR → Codex bot rounds → merge on CI green.

## Task ledger

| Task | Title | Status | Notes |
|---|---|---|---|
| T1 | SetupState singleton migration + schema | in progress | foundational migration; commits the exec record |
| T2 | practiceMode() leaf | pending | |
| T3 | order-entry readiness predicate leaf | pending | |
| T4 | SetupState service + audit wiring | pending | depends T1 |
| T5 | practice banner in root layout | pending | depends T2 |
| T6 | PRACTICE watermark post-stamp in render.ts | pending | depends T2 |
| T7 | order-entry gate + opt-in harness | pending | depends T3 |
| T8 | readiness route + blocking notice | pending | depends T3, T7 |
| T9 | install-readiness rollup + route | pending | depends T3, T4 |
| T10 | /setup checklist + state route + reminder + nav | pending | depends T4, T9 |
| T11 | extract reseedSingletons | pending | depends T1 |
| T12 | demo-seed module | pending | depends T2, T6, T7 |
| T13 | reset-practice-data route + control | pending | depends T2, T11, T12 |
| T14 | deploy shape (erp_practice + practice app) | pending | infra |
| T15 | E2E flows | pending | depends T5, T8, T10, T14 |
| T16 | docs consolidation | pending | depends architecture tasks |

## Per-task record

### T1 — SetupState singleton migration + schema
- **Commits:** `2097912` (plan + exec record), `b39516d` (code). Full suite green (2852/158). Review (wave-1): **pass, approved, no findings.**

### T2 — practiceMode() db-identity leaf
- **Commit:** `d222daa`; fix commit pending. Review (wave-1): **pass, needs-fixes** — (IMPORTANT) memoized `??=` cached a *rejected* promise permanently → a transient first-call DB failure would poison every later layout render until process restart; fixed with `.catch(clear-cache-and-rethrow)`. (MINOR) memoization test strengthened to assert promise identity. Both applied.

### T3 — order-entry readiness predicate leaf
- **Commit:** `410b279`. Review (wave-1): **pass, approved.** One minor consideration (should GL-account count also require `active:true`?) resolved by the reviewer itself: `deletedAt:null` is the spec-faithful "live" per house rules (`active` is a hiding flag); the real teeth is `arGlAccountId` set.

### T4 — SetupState service + audit wiring
- **Commit:** `cf34e59`. DEFAULT isolation (no FKs); AuditableModel union + SNAPSHOT_INCLUDE both extended; audited via `auditedUpdate`. Checkpoint full suite running.

### T5 — practice banner in root layout
- **Commits:** `51e2cdb` (T2 fix), `dca088d`. Node-env element-tree test (repo has no DOM test env); mocked `@/app/globals.css` to bypass the Tailwind-v4 PostCSS pipeline in vitest. Checkpoint suite 161→green.

### T6 — PRACTICE watermark post-stamp in render.ts
- **Commit:** `c87281a`. Full suite green (163/2871). Split renderPdf→renderPdfCore; stampPractice short-circuits in prod (byte-golden), stamps merged bytes once in renderSheetGroups (no double-stamp). Test detects the stamp via inflated content-stream hex of "PRACTICE" (pdf-lib hex-encodes drawText) — count = pages stamped, so it catches a double-stamp.

### T7 — order-entry gate at createOrder + opt-in harness
- **Status:** gate landed in orders.ts (pre-transaction read between trafficSettings and the tx); `seedOrderGatePrereqs()` added to tests/helpers/db.ts (raw prisma, no audit, OPT-IN — not in truncateAll, to keep pristine suites + reseedSingletons clean); order-gate.test.ts green (3/3). **In progress:** the opt-in sweep of every order-creating test file (blast radius captured empirically from a full-suite run, not guessed).
- **Task-boundary note:** the E2E-fixture prereq seeding (e2e/lib/db-fixtures.ts — company identity) **moves to T15**, where E2E actually runs and the change is verifiable; editing it blind in T7 could not be checked. Recorded here so it is not lost.
- **Commits:** `f88b0cd` (gate+sweep), `124f90b` (docs). Blast radius captured empirically (38 files, 683 tests) from a full-suite run; sweep delegated to a subagent (~150 hooks), one straggler (an inline `truncateAll()` in a loop body) fixed by hand. Full suite green.

### T8 — entry-readiness route + blocking notice
- **Commit:** `3b1e38d` (+ polish in `fa713b4`). Route returns the same predicate as the gate. Wave-2 review: approved (minors — /setup forward-ref to T10 now resolved; benign TOCTOU spec-sanctioned; test status-assertion polish applied).

### T9 — install-readiness rollup + route
- **Commit:** `cbe96af`. Eight §5.5 steps incl. the password-still-default live signal (§5.7); recommended-vs-blocking flags; numbers/dismissed from SetupState. 7 tests green.

### T10 — /setup checklist + state route + banner + reminder
- **Commit:** `fa713b4`. Checklist page (ReportsIndex clone), PUT /api/setup/state (admin.edit), SetupBanner mounted in the root layout = dynamic surfacing (owner decision 5, not a static nav entry) + §5.7 client-dismiss password reminder. UI is E2E-covered in T15.

### Review wave 2 (T4, T6, T7, T8, T14) — 2026-08-15
All five **pass / approved**; T7 zero findings. Only MINORS, most self-resolved: T4 audit-`before` precision (house-sanctioned, no change); T6 cosmetic centering + the §10 reprint-of-stored-doc test correctly deferred to **T12**; T8 forward-refs (resolved) + status-assertion polish (applied); T14 `db:seed:demo` → **T12**, runbook note → **T16**.

### T11 — extract reseedSingletons
- **Commit:** `f04db4f`. New src/server/practice-seed.ts (reseedSingletons from defaultConfigFor); truncateAll calls it; templateId helpers relocated + re-exported. Full suite caught one sweep failure (practice-seed mutates without audit) → added to the permissions-sweep allowlist (a reset is not history, §5.3). Green.

### T12 — demo-seed module (subagent-built, controller-verified)
- **Commit:** `0918e9b`. prisma/demo-seed.ts — Summit Heat Treating slice through the services (guard-split: seedDemoSlice tested vs erp_test, seedPracticeDemo guarded; tsx entry + db:seed:demo). Reproduces seed.ts's admin bootstrap. Owner reviewed the fixture (decision 2). Added the §10 reprint-watermark test (practice-stored doc's reprint carries the mark, Buffer.compare-exact). Demo-seed 2/2 + reprint 1/1 green.

### T13 — reset-practice-data route + control
- **Commit:** `4526385`. Double-guarded reset (admin.edit + practiceMode gate + the load-bearing assertPracticeDatabase in-request re-check); non-atomic; singletons before demo rows. /practice page (server-resolved) + PracticeResetControl; PracticeBanner links to it. 4/4.

### T14 — deploy shape
- **Commit:** `342b739` (landed earlier, out of DAG order — infra-independent). Reviewed clean in wave 2.

### T15 — E2E flows
- **Commit:** `97fdd7e`. The order gate broke all order-creating E2E flows in the DEV erp db → the shared fixture now seeds company identity + arGl (snapshot/restore). New read-only setup-checklist flow (/setup renders; order entry unblocked). First E2E run: 21/22 (blocked-code-delete's loose `{name:'dismiss'}` collided with the SetupBanner password-reminder button) → renamed it 'Not now' → **full E2E 22/22 clean**. The block path is unit-tested (order-gate/readiness/rollup).

### T16 — docs
- **Commit:** `5daea6f` (CLAUDE.md standing architecture). Spec §15 Phase-8 amendment block already documents 8B's contract from design approval (no new amendment). HANDOFF §4 "merged" entry + the docs/history/ narrative are the **post-merge close-out** (the Phase 8A pattern).

### Final verification (2026-08-15)
- E2E: **22/22 clean** (`E2E_EXIT=0`). tsc + eslint: clean across the branch. Full vitest suite + `build`: running. Whole-branch 5-lens review: running.

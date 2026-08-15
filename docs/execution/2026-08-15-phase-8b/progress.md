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
- **Brief:** `briefs/T1.md`
- **Status:** in progress (controller-run — foundational migration via the TTY-less two-DB workflow).

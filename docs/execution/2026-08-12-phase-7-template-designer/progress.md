# Phase 7 — Template Designer — Execution Ledger

**Branch:** `phase-7-template-designer` (off `main` at `c5c1f62`)
**Spec:** `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` (owner-approved 2026-08-12, incl. `pdf-lib`)
**Plan:** `docs/superpowers/plans/2026-08-12-phase-7-template-designer.md` (owner-approved 2026-08-12; 21 tasks; two-lens plan review incorporated)
**Process:** fresh subagent per task → task-reviewer (spec compliance + quality) → fix rounds until approved → whole-branch review on the strongest model → one fix wave → PR (attribution in the body). Round-6+ findings triage to issues unless correctness/concurrency/data-integrity.

**Gate rows in this ledger are written after watching the run end, from the run's own output — or they say PENDING.** (The Phase 6 Task 10 rule.)

## Baseline (2026-08-12, before Task 1, watched)

| Gate | Result | Timing |
|---|---|---|
| vitest | 2133/2133, 130 files | 219.8s |
| tsc --noEmit | clean | 2.1s |
| eslint src tests | clean | 10.0s |
| build | exit 0 | ~60s |
| E2E | not run (baseline; no change) | — |

Both DBs: 32 migrations, `migrate status` clean. Docker active, `erp-db-1` healthy.

## Task ledger

| # | Task | Implementer | Review | State |
|---|---|---|---|---|
| 1 | Contract machinery + order-side contracts | subagent 2026-08-12 (`6142d33`, `0cae14f`; report filed; gates watched: vitest 2195/2195 in 213.4s, tsc 1.6s, eslint 9.0s, build exit 0 in 15.5s; E2E n/a — no UI/flow) | Spec ✅ / **Approved** (round 1; every binding value verified verbatim against the builders; 4 minors, none blocking — carried below) | **APPROVED** |
| 2 | Billing-side contracts | subagent 2026-08-12 (`2b3a37a` the carried section-hide lock fix, `eca1c9a` the four contracts + registry; report filed with RED evidence; gates watched: vitest 2226/2226 in 206.7s, tsc 1.9s, eslint 9.2s, build exit 0 in 16.9s; E2E n/a — no UI/flow) | — | **IMPLEMENTED — awaiting review** |
| 3 | Schema, migrations, seeds, registrations | — | — | — |
| 4 | Template service | — | — | — |
| 5 | Assignment + resolution | — | — | — |
| 6 | Render runtime | — | — | — |
| 7 | Traveler conversion + stamp plumbing | — | — | — |
| 8 | Traveler sheet groups (#36, #43) | — | — | — |
| 9 | Ticket + MOS conversion + tear-off reflow | — | — | — |
| 10 | BOL conversion | — | — | — |
| 11 | Cert conversion | — | — | — |
| 12 | Invoice/credit conversion (+#98) | — | — | — |
| 13 | Statement conversion (+#87) | — | — | — |
| 14 | Quote conversion (+#97, settings retirement) | — | — | — |
| 15 | Part.processName UI | — | — | — |
| 16 | Templates admin + nav | — | — | — |
| 17 | Editor panels + logo | — | — | — |
| 18 | Editor save/conflict UX | — | — | — |
| 19 | Preview | — | — | — |
| 20 | Customer-page assignment picker | — | — | — |
| 21 | Restyle E2E flow, docs, final gates | — | — | — |

## Carried minors (from per-task reviews; each routed to a named later task)

- **From Task 1 review → Task 2:** latent lock-bypass in the generic machinery — `assertLocksHonored` does not refuse hiding a *hideable* section that contains a non-removable field (Task 1's contracts compensate by pinning those sections non-hideable, but nothing enforces the pairing for later contracts). Task 2 fixes the semantics (a section-hide counts as hiding its fields for lock purposes) + tests it. **DONE in Task 2 (`2b3a37a`, RED-verified both directions).**
- **From Task 1 review → Task 9:** the shipping ticket prints TWO date styles (header `shortDate` M/D/YYYY vs tear-off `paddedDate` MM/DD/YYYY) against the contract's ONE date knob — Task 9's mapping must not let the single knob change the tear-off at the golden-compat gate (map the knob to the header; the tear-off keeps its own style, or gets its own knob).
- **From Task 1 review → Task 17 (editor):** `lockedElements` returns a flat `{key, reason}` list mixing section and field keys — tighten the namespace before rendering padlocks.
- **From Task 1 review → all future briefs:** implementer reports must include RED-run evidence (a failing-test output snippet), not just the claim.

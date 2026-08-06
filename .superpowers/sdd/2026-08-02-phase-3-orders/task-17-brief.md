### Task 17: E2E flows + demo walkthrough + docs

**Files:**
- Create: `e2e/flows/order-entry-full.mjs`, `e2e/flows/board-search-scan.mjs`, `e2e/flows/loads-after-print.mjs`, `e2e/flows/void-order.mjs`
- Modify: `e2e/lib/db-fixtures.ts` (order fixtures + exact-key cleanup — the reaper stays exact-key, fixture-customer-scoped, localhost-gated)
- Create: `docs/2026-08-XX-phase-3-demo.md` (dated on the day it's written)
- Modify: `docs/HANDOFF.md` (§4a Phase 3 state; §9 next-kickoff → Phase 4), `CLAUDE.md` only if a new bite-worthy constraint emerged (pdfmake/Node quirk, if any)

- [ ] **Step 1: Flows** (each screenshots named checkpoints to `erp/e2e-artifacts/`): key the two-line sibling order (serials via `{001-005}`) → hub shows "Lead · Rev N locked" → print traveler → documents list grows → board shows the order with its light → global search exact number lands on the hub → edit a load → amber printed-warning appears → void with reason → board hides it until include-voided. `npm run test:e2e` 6/6 existing + 4 new.
- [ ] **Step 2: Demo doc** — screenshots + narrative (2C-3 precedent), presented to the owner before merge.
- [ ] **Step 3: HANDOFF updates** — §4a "Phase 3 DONE" block (tests count, gates, owner rulings recap pointing at spec §3), §9 kickoff prompt for Phase 4 (certs & shipping; inherits list from spec §16).
- [ ] **Step 4: Full gates + `npm run build` + both-DB migrate status clean. Commit** — `feat: phase 3 E2E flows; docs: demo walkthrough + handoff`

---

## Execution notes for the orchestrator

- Fresh subagent per task; independent spec+quality review per task (the loop is not ceremony — it caught real bugs in every prior phase); fix rounds until approved; final whole-branch review before merge; PR body carries the attribution, once.
- Tasks 2–3 are parallel-safe after Task 1. Tasks 4–8 are sequential on the service layer (5 and 6 touch `orders.ts` output types; 7–8 independent of 5–6 but cheap to keep ordered). 9–10 after their services. 11 after 9 (route conventions), before 14 (hub mounts it). 12–14 after 9–10. 15 anytime after 1 (guards read `Order`). 16 after 14 and THE SAMPLES GATE. 17 last.
- If the samples gate stalls (owner unavailable), reorder: run Task 17's non-traveler flows and docs prep, leave Task 16 + the traveler-dependent E2E checkpoints pending — do NOT fake a layout to keep moving.

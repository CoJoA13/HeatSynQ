# Phase 5C SDD progress ledger

- **Plan:** docs/superpowers/plans/2026-08-09-phase-5c-close-qbo-export.md
- **Spec:** docs/superpowers/specs/2026-08-09-phase-5c-close-qbo-export-design.md (7 owner rulings, §3)
- **Branch:** phase-5c-close-qbo-export
- **Branch base (merge-base main):** 580e74406f7624e2fa737bf2e5189e8f8de705a6
- **Docs commits before Task 1:** 5780745 (spec), 56ae80a (plan + spec reconciliation)
- **Plan hardened pre-execution** by a 3-agent adversarial critique (coverage/reachability, cross-task consistency, code fidelity). Notable fixes folded in: per-event GL delta with isReversal-by-provenance + single (sourceType,sourceId) key; per-event balanced cash pairs (no aggregate A/R sourceId:""); advisory-locked period guard + two-concurrent-closes RED test; period-scoped readiness; getExportBatch{File,Register}; currentActor().id; GlPosting.memo. Verified false positive: close_ar_period/run_qbo_export already exist in SPECIAL_ACTIONS + granted via ALL_PERMISSIONS.
- **Environment note:** Postgres is up (29 migrations, schema current). The docker *CLI* is permission-blocked in agent shells (unix socket), but `npx prisma migrate deploy/generate` connect directly and work — do NOT run `docker compose up`.

## Tasks

- [ ] Task 1: Data model, migration, audit + counter registration
- [ ] Task 2: BillingConfig GL defaults — service, delete-blocker registry, admin UI
- [ ] Task 3: gl-mapping.ts — pure journal + readiness engine
- [ ] Task 4: period-locks.ts leaf + wiring into every A/R posting mutation
- [ ] Task 5: close-periods.ts — close/reopen lifecycle + preliminary report + routes
- [ ] Task 6: gl-export.ts — per-event delta, CSV, batch write + export/readiness routes
- [ ] Task 7: posting-register PDF
- [ ] Task 8: /receivables/close UI
- [ ] Task 9: E2E flow, demo doc, documentation

## Log

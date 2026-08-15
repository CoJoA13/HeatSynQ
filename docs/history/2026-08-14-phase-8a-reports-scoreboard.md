# Phase 8A — Reports & Scoreboard (2026-08-14)

**Merged to `main` as `7d3ebb1` (PR #106, squash, 2026-08-14).** First sub-phase of roadmap Phase 8 (Reports & parallel-run tools). Design spec: `docs/superpowers/specs/2026-08-14-phase-8-reports-parallel-run-design.md` §4 (approved 2026-08-14). Full execution record: `docs/execution/2026-08-14-phase-8a/`.

## What shipped

A real **`/reports` section** behind the previously-dead `reports` permission area, built as one reusable five-part report shape (pure-core service + shared `query.ts` parse + JSON/export routes + client UI + a client-safe `report-registry.ts` catalog) cloned from the A/R aging report. Every report is a **pure read** (no claim/audit/Serializable — main spec §12).

- **Five new reports:** Backlog (open orders incl. REOPENED, ordered qty/weight), Shipped (lbs & pcs by shipDate, reversals netted, released rows counted), Turnaround (avg order-to-ship days, completion date derived from shipments), Sales (invoiced revenue **ex-tax**, net of credits, by **finalizedAt**, reconciling to the GL export's revenue accounts by construction), Payments received (**POSTED-batch** cash by receivedDate).
- **Homed** the invoice register (the invoicing list) + A/R aging under `/reports`, each gated on its own source area.
- **Comparison scoreboard** — orders entered (receivedDate) / shipped (lbs+pcs) / invoiced $ (**invoiceDate**, the VS-eyeball basis — owner steer), our-numbers-only, three reads in one RepeatableRead snapshot.
- **Two indexes** (`Invoice.finalizedAt`, `Payment.receivedDate`); a `reports` E2E flow; a curated CLAUDE.md reports-platform convention paragraph; a shared client-safe `report-ui.tsx` (`GateNotice`/`ExportLink`) + `report-export-state.ts`.

## Owner decisions

D1 report set + slices; D2/D3 scoreboard our-numbers-only + lbs/pcs + **invoiceDate** basis; POSTED-only payments; full-ship turnaround; REOPENED-in-backlog; and — at the wrap-up — **"reports slice by part = ship as-is"** (each report does what fits its data; the released-row / multi-part-attribution edge quirks are rare and documented).

## Process & the three-layer review stack (each layer caught what the prior missed)

- **8 tasks**, subagent-per-task, each with an independent task review — **all Approved on round 1**, zero critical/important. Genuine RED-then-GREEN on the tricky measures (Turnaround completion-date, Sales SURCHARGE + GL reconciliation, Payments POSTED-only, scoreboard invoiceDate).
- **Whole-branch review** (5 lenses, opus/high): all APPROVE, only LOW findings, contract lens zero.
- **Consolidated fix wave** for the LOW minors (collision-free keys + orderBy, export-label humanize, a hardening test, a doc-citation fix).
- **Codex automated PR review (the GitHub bot), two rounds, 6 real P2s** the first two layers missed — cross-cutting error-handling / stale-state / read-consistency bugs cloned across the report screens (scoreboard multi-read snapshot; permission-fetch-failure misreported as authz-denial; options-error erased by report-success; inactive master data absent from filters; export link ahead of the table; and — round 2 — export enabled on a failed initial load, a regression the round-1 export fix introduced). All 6 fixed on-branch (a shared `report-ui.tsx` + `report-export-state.ts` killed the clones), fix-review Approved, threads replied + resolved.

**Final gates:** 2849 tests / 156 files, tsc/eslint/build clean, **E2E 21/21**; **CI green**.

## Deferred (follow-ups)

- **Unbounded `findMany` + JS aggregation** in the report wrappers — fine at this shop's scale; a candidate future optimization (DB-side aggregation) if a table grows large. (Issue filed.)
- The remaining Phase 8: **8B** (practice DB + first-run wizard), **8C** (backup polish).

## Lessons

- **No single review layer is sufficient — the per-task → whole-branch → automated-Codex stack is what caught everything.** The whole-branch review was clean (all LOW), yet Codex then found 5 genuine P2s, and a second Codex round caught a regression in the *fix* for one of them. Same pattern as Phase 7 (Codex caught a P1 the whole-branch missed). Keep all three layers, and expect a fix to draw a re-review — converge, but don't merge a fix's own regression.
- **The §5.13 sibling-page stale-load sweep the handoff flagged was real** — the new report pages inherited the stale-export/error-handling class; Codex surfaced it. The shared `report-ui.tsx`/`report-export-state.ts` extraction is the fix and the guard against future clones.
- **The `close-month-end` E2E flow is a documented Phase-5C intermittent hang** — it flaked several times mid-branch. Two operational lessons (memory-noted): a `timeout --signal=KILL` E2E orphans the dev server on `:3100` (use `timeout --kill-after=30` so the harness self-cleans); and when it hangs repeatedly, isolate (skip it, verify the rest) rather than fight it — the final full runs passed it clean.
- **Docker was disabled at boot / stopped at a session boundary**; a fix wave ran against a stand-in rootless-Podman Postgres 18 (`erp-db`, port 5432, both DBs migrated). The container runtime doesn't change test validity (Postgres is Postgres), but restore the documented Docker stack (`sudo systemctl start docker`; `podman rm -f erp-db`) for the normal workflow.

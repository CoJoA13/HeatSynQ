# HeatSynQ

A self-hosted web ERP for a commercial heat-treating shop — built to run in parallel with, and eventually replace, Visual Shop (Cornerstone Systems, Inc.).

**Status:** All eight build phases are complete and merged to `main` — the full order-to-cash flow (quotes, orders, travelers, shipping, certifications, invoicing, receivables, month-end close and GL export), owner-configurable roles & permissions with a full audit trail, data-driven document templates for every printed paper, reports, a separate practice copy with first-run onboarding, and Docker packaging with fail-loud nightly backups. The remaining headline goal is the parallel-run acceptance month (spec §13); the current state, gates and backlog are dated in [`docs/HANDOFF.md`](docs/HANDOFF.md) §4.

> **Continuing this project on a new machine or in a fresh session? Start at [`docs/HANDOFF.md`](docs/HANDOFF.md)** — it is the portable project memory: decisions, conventions, backlog, Fedora setup (§8), and the §9 kickoff for the next piece of work.

## Repository layout

| Path | What it is |
|---|---|
| [`erp/`](erp/) | The application — Next.js 15 + Prisma 7 + PostgreSQL. See [`erp/README.md`](erp/README.md) for dev setup and production deployment |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | The approved design specification (the contract for what gets built) |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | The 8-phase build roadmap and per-phase implementation plans |
| [`docs/2026-07-29-crossref-findings.md`](docs/2026-07-29-crossref-findings.md) | Cross-reference of the two Visual Shop reference documents |
| `Visual-Shop-ERP-Reference-Report.md` | Teardown of Visual Shop compiled from the vendor knowledge base (design reference) |

## Build phases

1. **Foundation** — auth, permissions, audit, settings, shell ✅
2. **Master data** — customers, parts, process steps & process step codes, reference tables
3. **Orders & loads** — order entry, auto load-split, order board, traveler PDF
4. **Certs & shipping** — certifications, shippers, MOS, BOL
5. **Invoicing & A/R** — pricing, surcharges, finance charges, QuickBooks Online export
6. **Quoting**
7. **Template designer** — self-service document layouts (traveler, certs, invoices…)
8. **Reports & parallel-run tools**

Full roadmap: [`docs/superpowers/plans/2026-07-29-roadmap.md`](docs/superpowers/plans/2026-07-29-roadmap.md).

## Ground rules

- Visual Shop remains the system of record until a full parallel-run month closes clean (spec §13).
- No scheduling, no shop-floor tracking, no equipment integration — deliberate scope decisions, see spec §3.
- Every mutation is audited; deletes are soft; permissions are enforced server-side.

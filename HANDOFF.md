# HeatSynQ — Session Handoff

**Last updated:** 2026-06-30
**Repo:** https://github.com/CoJoA13/HeatSynQ.git (branch `main`)
**Status:** ✅ Brainstorm + spec + Plan 1 complete. ⏳ **No application code written yet** (intentionally committed before scaffolding). Resuming on a fresh Ubuntu machine.

---

## TL;DR — how to resume

1. Install prerequisites on Ubuntu (see "Environment setup" below): git, GitHub CLI (`gh`), Node ≥ 20, npm.
2. Clone: `git clone https://github.com/CoJoA13/HeatSynQ.git && cd HeatSynQ`
3. Open Claude Code in the repo and paste this prompt:
   > "Read HANDOFF.md, then `docs/superpowers/plans/2026-06-30-heatsynq-foundation.md`. Execute Plan 1 using the superpowers:subagent-driven-development skill — one fresh subagent per task, verify tests green and review between tasks. I chose subagent-driven execution."
4. That's it — Claude will scaffold the app (Task 1) and proceed task-by-task.

**Chosen execution mode:** Subagent-driven (fresh subagent per task + review between tasks). This was decided; no need to re-ask.

---

## What HeatSynQ is

A new, modern, workflow-driven **ERP for a heat-treating / metal-processing job shop**. Visual Shop (the legacy prototype in this repo) is **reference only** — we are building a new product with its own data model, UX, and architecture. Full lifecycle: Quote → Order → Schedule → Track → Certify → Ship → Invoice, plus customers, parts, process masters, quality, finance, and setup.

The whole product is decomposed into per-subsystem spec → plan → build cycles. We are starting with the **foundation + the Quote→Order→Invoice vertical slice**.

---

## Decisions locked (do not re-litigate)

| Topic | Decision |
|---|---|
| Build approach | **Frontend-first, backend-ready** — real UI on a mock data layer behind typed repository interfaces |
| Framework | **Next.js (App Router) + TypeScript**, single on-prem deployable |
| Eventual DB | **PostgreSQL** on-prem (built in a later phase, not now) |
| Deployment target | One on-prem Node server serving UI + API to **multiple concurrent workstation users** |
| Auth | **App-managed accounts** (users/passwords/roles in-app); mocked in this slice |
| UI toolkit | **Tailwind v4 + shadcn/ui**, restyled to the prototype's exact tokens |
| First build | **Foundation + Quote → Order → Invoice** |
| Quote pricing | Price Key default rate → editable override → min-charge floor |
| Quote scope | **Multi-part quotes** (each part its own pricing lines) → multi-part orders |
| Order creation | Mark quote **Won** → auto-create the Work Order |
| Invoice trigger | On **ship** → To-bill queue → bill (assign INV#) → Sent → A/R |
| Canvas color | `#f6f7f9`; nav uses main-prototype naming |

Twelve additional business-rule defaults (approval flow, sent-quote immutability, credit hold, cert gating, numbering, etc.) are recorded in the spec §2 and were approved.

---

## Document map (all committed & pushed)

| File | What it is |
|---|---|
| `README.md` | Original product handoff |
| `docs/superpowers/specs/2026-06-30-heatsynq-foundation-quote-order-invoice-design.md` | **Approved design spec** for the slice |
| `docs/superpowers/plans/2026-06-30-heatsynq-foundation.md` | **Plan 1 — Foundation & Platform** (17 TDD tasks; execute this first) |
| `docs/superpowers/reference/2026-06-30-heatsynq-grounded-reference.md` | Exact design tokens, full data model, slice semantics, glossary, screen inventory — mined from the prototype |
| `docs/superpowers/reference/2026-06-30-heatsynq-extractions.json` | Raw structured extractions (traceability) |
| `Visual Shop.dc.html`, `Visual Shop Redesign.dc.html` | Prototype design references (visual/interaction only) |
| `support.js` | Prototype `dc-runtime` — **ignore** (not used in the build) |
| `screenshots/01..11-screen.png` | Rendered prototype screenshots |
| `VisualShopTraining.pdf` | Legacy Visual Shop training material — domain reference for later phases (not yet analyzed) |

---

## Plan roadmap

- **Plan 1 — Foundation & Platform** (written, ready to execute): scaffold, design tokens + fonts, domain model + Zod, pure business logic with TDD (pricing, quote/order/invoice/AR/numbering), backend-ready mock data layer (repositories + seed + provider + TanStack Query), mocked auth + permission matrix, pattern component library, app shell + sidebar + topbar, command palette (⌘K), and the live `/patterns` page.
- **Plan 2 — Data-driven screens** (to be written after Plan 1 is green): Customers, Parts, Process Master, Specifications, Certifications, the Today dashboard (Manager/Sales/Office), placeholders, and live sidebar badges.
- **Plan 3 — Quote→Order→Invoice workflow** (to be written after Plan 2): quote builder (multi-part) + lifecycle, Won→Order, order detail + ship gate + cert release, invoicing (bill/pay), A/R + close-period, and a Playwright happy-path E2E.

---

## Environment setup (fresh Ubuntu)

```bash
# Git + GitHub CLI
sudo apt update && sudo apt install -y git
# Install gh (GitHub CLI): https://github.com/cli/cli/blob/trunk/docs/install_linux.md
gh auth login            # re-authenticate as CoJoA13 (token did not survive the reformat)

# Node ≥ 20 via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell, then:
nvm install 20 && nvm use 20

# Clone + verify
git clone https://github.com/CoJoA13/HeatSynQ.git
cd HeatSynQ
node -v   # expect v20+
```

Notes:
- `gh` auth and any git credentials are **not** preserved by a reformat — re-run `gh auth login`.
- The working directory will change (no longer `/home/cojoa13/Documents/claude projects/...`) — nothing in the repo hardcodes that path; the spec/plan use repo-relative paths.
- Git user config may need resetting: `git config user.name "CoJoA13"` and `git config user.email "cjones1308@pm.me"`.

---

## Build conventions (from the plan's Global Constraints)

- npm; Node ≥ 20; TypeScript strict; money stored as integer **cents**; dates as ISO strings.
- Every persisted entity extends `BaseEntity` (`id, createdAt, updatedAt, version`) for optimistic concurrency.
- All repository methods are async; UI depends only on repository interfaces (so the real Postgres/API drops in later behind the same seams).
- Exact design tokens: primary `#3d63dd`, canvas `#f6f7f9`, IBM Plex Sans 13px base, **IBM Plex Mono for IDs/numbers/pills** (brand signature).
- TDD: write the failing test first; commit after every task; never leave the tree red.

---

## Current git state at handoff

- Branch `main`, all planning artifacts committed **and pushed** to GitHub.
- No `node_modules`, no app scaffold yet — Task 1 of Plan 1 creates them.

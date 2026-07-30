# HeatSynQ — Project Handoff

**Updated:** 2026-07-30, end of Phase 1. This document is the portable project memory: a fresh machine or a fresh AI session should be able to continue the project from this file plus the documents it links. Session-local memory and the `.superpowers/` execution scratch (task reports, progress ledger) do **not** travel between machines — everything load-bearing from them has been folded in here.

---

## 1. What this project is

HeatSynQ is a self-hosted web ERP for a commercial **heat-treating shop**, built to run **in parallel with Visual Shop** (Cornerstone Systems) and eventually replace it. The owner is the shop's **Production Manager** — the project sponsor, primary scheduler, and a daily user. The system keeps Visual Shop's working concepts and vocabulary (customers, memorized parts, process masters, work orders that split into loads, certs, shippers, invoices, A/R) with a dramatically simpler engine, modern navigation, and *more* customization than Visual Shop in exactly two places: document templates and permissions.

**The prime directive, in the owner's words: DO NOT MAKE ASSUMPTIONS.** When the spec, this handoff, or the reference documents don't answer a question — ask the owner. That rule produced every good decision in this project so far.

**Visual Shop remains the system of record** until one full parallel-run month closes with A/R and the QuickBooks summary agreeing with the books (spec §13). Nothing in this project touches the Visual Shop installation or its database — there is **no migration** ("None, no migration" — owner); HeatSynQ starts empty and masters are keyed in by hand.

## 2. Document map

| Document | Role |
|---|---|
| `docs/superpowers/specs/2026-07-29-heat-treat-erp-design.md` | **The approved spec — the contract.** §3 non-goals and §15 decision log are binding. Owner approved it with four review changes (already applied): qty+weight both required, auto load-split, no order duplication, CAR removed |
| `docs/superpowers/plans/2026-07-29-roadmap.md` | The 8-phase build order (owner-approved) |
| `docs/superpowers/plans/2026-07-29-phase-1-foundation.md` | Phase 1's executed plan (historical record; two mid-execution corrections were committed to it) |
| `docs/superpowers/plans/2026-07-30-phase-2-kickoff.md` | **Start here for Phase 2** — scope, model notes, pre-work, and the context this handoff's author held |
| `docs/2026-07-30-process-steps-model.md` | **The Process Steps model with diagrams** — supersedes spec §5.1's shared process master. Read before touching parts or recipes |
| `docs/2026-07-29-crossref-findings.md` | Cross-reference of the two Visual Shop reference docs — contradictions, gaps, and which source to trust where |
| `Visual-Shop-ERP-Reference-Report.md` | Teardown of Visual Shop from the vendor KB (primary design reference, with known errors — see findings doc) |
| `VisualShopTraining.pdf` | 2018 vendor training manual — **not in git** (44 MB, gitignored). Lives on the original machine; copy manually if needed. Printed page N = PDF page N+2 |
| `erp/README.md` | App dev setup + production deployment + backup/restore |

## 3. Decisions that bind everything (condensed)

Scope IN: order→cert→ship→invoice core; A/R & payments inside the ERP with **summary GL export to QuickBooks Online**; quoting; multi-order shippers + BOL; traveler barcodes (scan-to-open); surcharge add-ons; finance charges.

Scope OUT (deliberate, owner-confirmed — do not re-add): **scheduling** (owner schedules in Excel around molten-salt quench-tank temperatures; "can't be automated without human intervention — always"), **shop-floor tracking** (no ship gate — "we just ship"), **equipment integration**, Sales Order Entry staging, outside processing, inventory, CCM/CRM/mass email, dashboard graphs, contract review, digital order approval, kanban, assembly process masters, automatic customer emails, **CAR** (owner has a separate program; in-ERP rework may come later), **order duplication** (owner: double-billing risk).

Model facts (owner's own words shaped these):
- **Quantity AND weight both required** on orders; a part must carry **each-weight** and **its own Process Steps** (and ideally an active quote) so order entry auto-populates everything.
- **Loads are routine and essential**: 1,000 pcs at 300/load → 300/300/300/100, **auto-split at order save** from the part's load qty/wt. **Loads ≠ containers** (containers are customer packaging). Shipping is decoupled from load boundaries (ship 230 of a 300 load because that's what the customer's container calls for). Three quantity layers: ordered → per-load → shipped.
- **Part numbers are unique per customer, never globally** (owner, 2026-07-30). The same number recurs across customers as work migrates to cheaper sources, and **the chemistry can require a different recipe** — so a part number alone never identifies a part (customer shows at every selection point), and nothing about a part is ever inferred across customers from a matching number. Binds search (P3), certs (P4), and every part picker.
- **GL accounts are their own maintained reference table, and are optional when keying a Process Step Code** (owner, 2026-07-30: "configurable and not set in stone"). Step codes/payment types/surcharges reference an account rather than storing free text.
- **Shared process masters are REMOVED — the recipe belongs to the part** (owner, 2026-07-30; supersedes spec §5.1, recorded in spec §15 amendments). Nearly every step varies part to part (racking *always*, test type/location *always*, temper and austenitize parameters routinely), so a shared master would be an empty shell overridden everywhere — and propagating one edit across parts is precisely what chemistry-dependent outcomes make unsafe. What *is* shared: **Process Step Codes** (billable reference vocabulary carrying GL) and **Templates** (blank skeletons; "Load Template" fills structure with **empty** fields). **No copy-from-another-part mechanic, by decision.** Each step code defines which typed fields it exposes. Per-part step overrides and the step library are deleted, not deferred. Full model + diagrams: `docs/2026-07-30-process-steps-model.md`.
- **Specifications live on the part, many per part** — never on the process. The same recipe yields ASTM grade 1, 2, or 3 depending on the customer's base iron.
- Naming: UI says **Process Steps** (a part's recipe) and **Process Step Code** (the billable reference table, replacing the earlier "Operation").
- Certs: **commercial + ISO 9001 rigor only** (no Nadcap/CQI-9).
- Users: **1–5**, office-based. Platform: **self-hosted web app**. Database: **bundled PostgreSQL**.
- The shipper's *line complete* checkbox — a human, not arithmetic — decides an order is finished (kept from Visual Shop).
- Due dates inform, never block ("a metric, not a hard line").

## 4. State of the build

**Phase 1 (Foundation) is complete, merged to `main`, and pushed.** Built task-by-task with independent review of every task plus a final whole-branch review (verdict: merge, after a 9-item fix wave — all applied and re-reviewed). Quality gates that must stay green forever: `npm test` (75 integration tests against a real Postgres test DB), `npx tsc --noEmit`, `npx eslint src tests`.

What Phase 1 delivers (all in `erp/`):
- **Auth**: username/password (argon2id), hashed session tokens, sliding expiry driven by a setting, timing-attack-resistant login (DUMMY_HASH equalizer in `src/server/auth.ts`), middleware cookie gate.
- **Permissions**: `src/server/permissions.ts` + `src/lib/permission-constants.ts` — 12 areas × view/create/edit/delete + 10 named special actions; resolution DENY override > GRANT override > role > deny. Roles and per-user overrides are owner-editable in Admin.
- **Audit**: `src/server/audit.ts` — `auditedCreate/auditedUpdate/auditedSoftDelete` with before/after snapshots (including relations via `SNAPSHOT_INCLUDE`), recursive redaction (password/token/secret/signatureImage), per-record `HistoryPanel`, searchable admin log. **Every mutation goes through these helpers** (settings.ts's direct audit write is the one sanctioned exception).
- **Settings**: typed zod registry (`src/server/settings.ts`), 12 keys (company, numbering seeds, date defaults, session timeout), validated on read and write, audited, `Object.hasOwn`-guarded.
- **Admin pages**: Users (no hard delete ever; self-lockout guards: can't deactivate yourself or the last user-manager), Roles (permission grid; revival of a soft-deleted name clears stale permissions), Settings, Audit log.
- **Shell**: permission-aware left nav (routes for future phases 404 until built), global search placeholder (wired in Phase 3), auth-refetch on navigation.
- **Packaging**: multi-stage Dockerfile (standalone Next build, auto-`migrate deploy` on start), compose profiles (dev `db` only / prod db+app+backup), `restart: unless-stopped`, Postgres bound to 127.0.0.1, nightly **fail-loud** backups (verifies pg_dump's exit status; never writes an empty archive) with 30-day retention.

Seeded credentials: `admin` / `admin` — **change immediately** on any real install.

## 5. Conventions Phase 2+ must follow (learned and enforced in Phase 1)

1. **TDD per task**: failing test → implement → pass → commit. Vitest, real DB (`erp_test`), `truncateAll()` in beforeEach, `fileParallelism: false`.
2. **Services own business rules** (`src/server/*.ts`), route handlers stay thin: `requireUser` + `mustCan`/`mustDo` first line, zod parse, delegate. React components contain no business logic.
3. **Every mutation through the audit helpers**; extend `AuditableModel` and `SNAPSHOT_INCLUDE` (relations!) for each new entity. Never let a secret-bearing payload reach `write()` — redact() is defense-in-depth, not permission.
4. **Soft delete only** (`deletedAt`); active flags for hiding; hard delete never (tests excepted).
5. **Errors**: `HttpError(400/403/404, message)` for expected failures; `handle()` converts HttpError and ZodError to clean JSON; anything else is a bug. Field-anchored validation messages.
6. **Route handler tests pass ctx**: `handler(request, { params: Promise.resolve({...}) })` — the `Handler` type requires ctx (Next 15 ParamCheck rejects optional).
7. **Client components must not import from `src/server/**`** (drags node:async_hooks/Prisma into the bundle) — shared constants live in `src/lib/` (see `permission-constants.ts` precedent).
8. **Server-rendered pages that fetch data must call `requireUser` themselves** — the middleware is a cookie-presence redirect only. (Phase 1 pages are client components hitting guarded APIs, which is also fine.)
9. Conventional commits, ending with the Co-Authored-By line already used throughout `git log`.
10. Prisma migrations are applied to BOTH databases: `npx prisma migrate dev` (dev) then `DATABASE_URL=<erp_test url> npx prisma migrate deploy`.

## 6. Known backlog (all triaged, none blocking)

**Do at Phase 2 start (from the final review — "Task 0" items):**
- Auth-context refactor: `handle()` resolves the session user once (AsyncLocalStorage), `requireUser` reads it — currently every authed request does the session lookup + sliding-expiry write twice; me-route should reuse `resolve()` from permissions.
- Extract `HttpError` into `src/server/errors.ts` to break the `settings → http → sessions → settings` import cycle before more modules join it.
- Prisma error-hygiene helper: map P2002→400 / P2025→404 in services (covers: createUser duplicate race, renameRole soft-deleted-name edge, setRolePermissions dedupe, bogus-id 404s).
- Route `settings.ts` audit values through `redact()` (before Phase 5 puts QBO secrets in settings).
- dotenv v17 prints a promo line in test output — silence it (`quiet: true`) to keep output pristine.

**Deferred (fine to ride along):** health-route DB-down path; roles page deselect papercut; users page error banner doesn't clear on success; updateUser password truthy-check inconsistency; Shell loading indicator; settings page empty-blur cosmetic; searchAudit filter route tests; HistoryPanel changedFields unit test; session-row cleanup job; login rate limiting; backup alerting + backup-now button; SESSION_SECRET consumed by nothing yet; `renameRole` to a soft-deleted role's name → 500 edge.

**Phase 2+ deliverables promised by spec but not yet scheduled:** HTTPS on LAN + `Secure` cookie flag (reverse proxy); practice database mode (Phase 8); backup-now button + configurable folder (Phase 8).

## 7. The owner still owes (spec §14 — chase these, none block Phase 2)

1. **Samples of the current printed traveler, shipper, cert, and invoice** — these drive the Phase 3+ document templates and the cert field set. Drop scans/PDFs into the repo or the project folder.
2. QuickBooks Online finance-charge treatment — settle with the bookkeeper (Visual Shop excludes FC from GL export entirely).
3. The office's go-to report list.
4. GL account list for operations, surcharges, payment types. **No longer gates Phase 2** (2026-07-30) — the account is optional at operation entry, so masters can be keyed now; the list is needed before Phase 5's QBO export.

## 8. Fresh machine setup (Fedora)

```bash
# 1. Tooling
sudo dnf install -y git nodejs22 npm            # or use nvm; Node 22+ required
# Docker Engine (compose v2 profiles are used; Docker CE recommended over podman):
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # then log out/in

# 2. Project
git clone https://github.com/CoJoA13/HeatSynQ.git && cd HeatSynQ/erp
cp .env.example .env
docker compose up -d db
npm install
npx prisma migrate dev
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm run db:seed
npm test        # expect 75 passing
npm run dev     # http://localhost:3000 — admin/admin, change it
```

Fedora-specific notes:
- **SELinux**: the compose file bind-mounts `./db-init`, `./scripts/backup.sh`, and `./backups`. If Postgres init or the backup container hits `permission denied`, append `:z` to those three bind mounts in `erp/docker-compose.yml` (named volume `dbdata` needs nothing). Prefer `:z` labels over disabling SELinux.
- **Podman**: if you use podman instead of Docker CE, you need `podman-docker` + a compose provider that supports `profiles` and `depends_on: condition: service_healthy`; Docker CE avoids the friction.
- **firewalld**: only relevant when exposing the prod app to the shop LAN (`sudo firewall-cmd --add-port=80/tcp --permanent && sudo firewall-cmd --reload`).
- Dev DB data from the old machine does not travel (it was throwaway seed/test data). If you ever need it: `erp/backups/` gzip dumps restore per `erp/README.md`.

## 9. Kicking off Phase 2 (paste this into a fresh session on the new machine)

> Read `docs/HANDOFF.md`, then `docs/superpowers/plans/2026-07-30-phase-2-kickoff.md`, `docs/superpowers/specs/2026-07-29-heat-treat-erp-design.md`, and `docs/superpowers/plans/2026-07-29-roadmap.md`. Then write the detailed Phase 2 implementation plan (superpowers:writing-plans) following the kickoff brief's task outline and Phase 1's conventions (handoff §5), and execute it with superpowers:subagent-driven-development on a `phase-2-master-data` branch. Push to origin when the phase passes its final review. Remember the prime directive: do not assume — ask the owner.

Process that worked in Phase 1 and should be kept: brainstorm/clarify → spec → detailed plan → fresh subagent per task → independent spec+quality review per task → fix rounds until approved → final whole-branch review on the strongest model → one fix wave → merge. The per-task reviews caught real bugs the plan itself contained (plaintext password in audit payload, `__proto__` registry crash, blank-page login, resurrection with stale permissions, silent empty backups) — **the review loop is not optional ceremony**.

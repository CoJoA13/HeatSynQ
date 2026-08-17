# HeatSynQ — Project Handoff

**Updated:** 2026-08-17 — **Phase 8C (Backup polish) MERGED to `main` as `941ceab` (PR #117, squash, 2026-08-16), completing roadmap Phase 8 AND EVERY BUILD PHASE in the 8-phase roadmap. No phase is in flight, and there is no ninth — §9 is the open acceptance/backlog decision (owner's choice).** 8C gave the already-running nightly backup a face and a pulse: the `/admin/backups` page (archive list + integrity + resolved folder + "Back up now"), a red staleness indicator where **absence is failure**, a `manage_backups`-only shell warning bar, the app↔container bridge through a shared `BACKUP_DIR`, two permission-backfill migrations so an upgraded install gets the action automatically, and a live-verified restore runbook. Full narrative moved to `docs/history/2026-08-16-phase-8c-backup-polish.md`; §4 keeps the one-paragraph entry. Final gates on `main`: **2988 tests / 179 files**, `tsc`/`eslint`/`build` clean, E2E **23/23**, **39 migrations**, CI green. Nine per-task reviews (seven clean on round 1), a 5-lens whole-branch review with **zero Critical**, one fix wave, then Codex's **3 P1 + 7 P2** — all three P1s in the *restore runbook*, which two prior reviews had passed because they checked that the commands RUN, not what the shell SEMANTICS meant. Deferred → **#118–#122**. Earlier: Phase 8B merged `6f173e5` (PR #109); Phase 8A `7d3ebb1` (PR #106); Phase 7 `56c9722` (PR #104); Phase 6 `e2c91e8` (PR #94); Phase 5C `c069b09` (PR #92); 5B `b55da3b` (PR #74); 5A `359c707` (PR #58); Phase 4 `f129aae` (PR #47) with burn-down `8647a7d` (PR #57); Phase 3 `12a17f9` (PR #39). **Backlog burn-down COMPLETE (2026-08-16) — 14 issues closed across five groups.** Task 0 **#122** (PR #127, `20174b6`); Group A **#115 + #68** (PR #128, `ac5f8ff`); Group B **#91 + #81 + #84** (PR #129, `b56aa0f`); Group C **#126 + #125** (PR #130, `1d8eac8`); Group D **#118–#121 + #123 + #124** (PR #131). Final gates: 3080 tests / 182 files, `tsc`/`eslint`/`build` clean, E2E 23/23. **Round 2 opened 2026-08-17** (`docs/2026-08-17-backlog-round-2.md`, all 66 grouped): Task 0 closed **#6/#10/#7** as describing mechanisms that no longer exist, and **Group A — the invoice engine — closed all eight of #59–#64, #89 and #96**, squash-merged as `1c1fc77` (PR #133); gates **3104 tests / 182 files**, E2E 23/23, CI green, after **three review rounds** — two of which found defects in the previous round's code, both on the same #61 pairing fallback (a live double bill, then a live under-bill). Round 3 approved and surfaced one RULED limit as #134. **Open backlog is now: #51–#52, #65, #69–#80, #82–#83, #85–#88, #90, #92–#93, #95, #97–#100, #102–#103, #132, and #134** (the owner question review round 3 surfaced: should a typed price with no step code keep absorbing operations priced later — recommendation (a), leave it, the warning removes the silence) — §6. **Do not re-pick #115, #118–#126, #68, #81, #84, #91, #6, #7, #10, #59–#64, #89 or #96: they are done.**

**This file was split on 2026-08-06** — it had grown past what one read can hold, so the merged phases' full narratives moved verbatim to `docs/history/` and §4 keeps one paragraph each. Nothing was summarised or dropped; see §2 and §4 for the rule that keeps it that way.

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
| `docs/history/` | **The merged phases' full narratives**, one dated file per phase, moved verbatim out of this file's §4 as each phase closed. They record rulings, defect post-mortems and the lessons behind them — nothing there steers today's work, so read one only when you need a merged phase's detail. **The rule: when a phase merges, its narrative moves here and §4 keeps one paragraph** |
| `docs/execution/<date>-phase-*/` | **The execution ledger** — per-task briefs, implementer reports, reviewer verdicts, and the `progress.md` that records what every review found, refuted or deferred. This is the account of *why* each task landed as it did, and none of it is reproducible from source. Written here from Phase 5A on, and **committed on the first task** — see `.superpowers/sdd/README.md` for why it is no longer under `.superpowers/` |
| `docs/superpowers/specs/<date>-phase-N-*-design.md` + the matching `plans/` file | One design spec and one implementation plan per phase, each dated. The **current** phase's pair is binding for the work in flight; §4 names them |
| `docs/superpowers/plans/2026-07-29-phase-1-foundation.md` | Phase 1's executed plan (historical record; two mid-execution corrections were committed to it) |
| `docs/superpowers/plans/2026-07-30-phase-2-kickoff.md` | **Start here for Phase 2** — scope, model notes, pre-work, and the context this handoff's author held |
| `docs/2026-07-30-process-steps-model.md` | **The Process Steps model with diagrams** — supersedes spec §5.1's shared process master. Read before touching parts or recipes |
| `docs/2026-07-29-crossref-findings.md` | Cross-reference of the two Visual Shop reference docs — contradictions, gaps, and which source to trust where |
| `Visual-Shop-ERP-Reference-Report.md` | Teardown of Visual Shop from the vendor KB (primary design reference, with known errors — see findings doc) |
| `VisualShopTraining.pdf` | 2018 vendor training manual — **not in git** (44 MB, gitignored). Lives on the original machine; copy manually if needed. Printed page N = PDF page N+2 |
| `docs/samples/00-…06-*` + `README.md` + `screen-index.csv` | **Visual Shop live screen library** — 125+ captured screens (dashboard, menus, orders/shipping, process/parts, billing/invoicing, A/R, notes/reports), VS 4342.0, captured read-only 2026-08-04. **Not in git** (gitignored, owner ruling 2026-08-07 — holds live company data; local reference only, do not commit/push/redistribute; same precedent as VisualShopTraining.pdf). Incomplete by design. The tracked layout-sample PDFs in `docs/samples/` are separate and stay in git |
| `docs/visual-shop-capture-wishlist.md` | **Tracked** wishlist of VS screens NOT yet captured that would help the coming phases (5B A/R action flows, 5C close/QBO, then quoting/reports), keyed to VS's real menu labels. Living doc — extend as functions come up |
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

**The rule that keeps this section readable: when a phase merges, its narrative moves to
`docs/history/` and §4 keeps one paragraph** — what it delivered, its merge commit/PR, and the file
its full record now lives in. The *current* phase's state is kept here in full; everything already
merged is a pointer. Do not append a new phase narrative here — this file is the entry point for
every fresh session and has to stay readable in one pass.

**Fix MERGED to `main` as `a5aac43` (PR #114, squash, 2026-08-16) — `allocateNumber`'s counter-row
seed is now atomic.** Standing up the
build on the new Fedora desktop turned `tests/allocate-number.test.ts`'s concurrent case red 5/5,
where it had passed for five phases on the laptop and in CI. Not a regression: `allocateNumber`
seeded its `Setting` row with `upsert(… update: {})`, and Prisma degrades an EMPTY `update` to
SELECT-then-INSERT (a non-empty one emits `INSERT … ON CONFLICT DO UPDATE`) — so two allocations
racing before the row exists both INSERT and the loser dies on the primary key. The window is only
open while the counter row is absent: the first allocation of a fresh install, after `truncateAll()`,
and **after a practice reset**, where the loser would have got an opaque 500 instead of an
order/shipper/BOL/credit/receipt-batch number. Now a raw `INSERT … ON CONFLICT ("key") DO NOTHING`;
the `SELECT … FOR UPDATE` claim that serializes the readers is unchanged. `settings.ts` held the only
`update: {}` upsert in the tree — the other seven call sites all pass a non-empty `update`. A 5-way
burst test pins it on slow hardware too, and the trap is now in CLAUDE.md's constraints list.
**Scope, precisely: this fixed the P2002 insert race and NOTHING else.** Codex's review of the PR
pushed on the isolation level, and probing it found a larger PRE-EXISTING hole → **issue #115 (P1)**,
now **FIXED on branch `fix-allocation-retry` (`fc7eb54`)** — see the burn-down entry below.

**#115 FIXED (2026-08-16, branch `fix-allocation-retry`).** Every caller of `allocateNumber`
allocates inside a **Serializable** transaction, and a transaction whose snapshot is fixed before the
`FOR UPDATE` claim aborts with **40001** as soon as another allocation commits — on **every**
allocation, not just the first, and with **no retry** anywhere but `close-periods.ts`. Measuring it
against `erp_test` corrected the issue's own analysis in two ways worth keeping:

- **It was not "one of two fails" — of N concurrent allocations exactly ONE succeeded** (n=8 → 1 ok,
  7 failed). Every loser died.
- **The hazard is NOT "the caller reads before allocating"** (the issue's evidence table row 2 said a
  no-prior-read allocation was safe; it is not). `allocateNumber`'s own first statement is the
  `INSERT … ON CONFLICT DO NOTHING` seed — a **write**, which fixes the snapshot itself. So
  allocating as a transaction's very first operation aborts too, which kills the "just allocate
  first" alternative. A Postgres sequence would dodge it entirely but leaks gaps on rollback, and
  "consumes no number when the save fails" is a pinned contract. Retry is what is left.

Also **eight** allocating sites, not six: `shippers.ts` has three (`saveNewShipper`,
`reverseShipperInTx`, `printBol`). All eight now wrap in `retryAllocation` (`db-errors.ts`) at
`ALLOCATION_TRIES = 10` — N concurrent allocations serialize into N rounds, one commit per round, so
the last caller needs up to N attempts and the default 5 would cover the documented 1–5 users with
**zero margin**. `reverseShipper`'s injected-`tx` path deliberately takes no retry. On
orders/shippers the retry wraps the `clientRequestId` try/catch, so a nonce collision is answered by
the replay on the first attempt and never retried. **The vitest suite structurally could not see any
of this — vitest runs Read Committed — so a green allocate-number run was never evidence.**
`tests/allocation-retry.test.ts` names Serializable explicitly and proves the abort deterministically
with a Read Committed gate (the `close-periods.ts` technique). **Four existing tests tolerated a 409
loser and would have passed VACUOUSLY once there are no losers** — all four now assert no rejections;
RED-verified by pinning `ALLOCATION_TRIES` to 1 (7 tests across 4 suites go red).

**One consequence worth knowing: the §5.14 quote-link dangerous-direction test changed shape.** It
asserted the save ABORTS with 409; with the retry the request succeeds on a second attempt whose
snapshot sees the line-drop, so it links nothing. **The invariant is unchanged and still pinned** —
it now asserts the surviving order line's `quoteLineId` is **null** (verified: `orders=1`,
`linkedToDead=0`). That is a sharper tripwire than the status code was: RED-verified by downgrading
`updateQuote` to Read Committed, which makes the save commit WITH a link to the dropped line.

### Phase 8 — COMPLETE; all three sub-phases (8A/8B/8C) merged

**Phase 8B MERGED to `main` as `6f173e5` (PR #109, squash, 2026-08-16)** — second sub-phase of roadmap
Phase 8. Full narrative: `docs/history/2026-08-15-phase-8b-practice-wizard.md`. It shipped the separate
practice training copy (own `erp_practice` DB + an `app-practice` compose service on the `practice`
profile, port 8080, own session cookie; **`practiceMode()` the single db-identity source** driving the
banner, the PRACTICE watermark, and the double-guarded reset), the demo seed built through the services
(`npm run db:seed:demo`), the first-run **setup checklist** (`/setup`, eight steps, the new `SetupState`
by-construction singleton), and the **order-entry gate** (`createOrder` blocked until company identity +
a chart of accounts — a pre-transaction read at the single chokepoint). Reviews: two per-task waves + a
clean 5-lens whole-branch review (**security lens clean**) + **three Codex bot rounds** (r1: 1 P1/7 P2;
r2: 2 P1/5 P2 — all fixed on-branch; **r3: 3 P2 logged as issues #110–#112 and merged**, per owner
instruction). Final gates: 2897 tests / 171 files, tsc/eslint/build clean, E2E 22/22, CI green. **The
two by-construction singletons are now `BillingConfig` + `SetupState`.**

**Phase 8A MERGED to `main` as `7d3ebb1` (PR #106, squash, 2026-08-14)** — first sub-phase. Full
narrative: `docs/history/2026-08-14-phase-8a-reports-scoreboard.md`. It shipped the `/reports` platform
(the `reports` area went live; a reusable five-part report shape cloned from A/R aging), five native
reports (backlog, shipped, turnaround, sales, payments), the homed invoice register + A/R aging, the
comparison scoreboard (invoiced-$ by **`invoiceDate`** — the VS eyeball), two indexes, and a reports
E2E flow. **8A deferred a follow-up (issue filed):** the report wrappers use unbounded `findMany` + JS
aggregation — fine at shop scale; DB-side aggregation is a future optimization.

**Phase 8C (Backup polish) MERGED to `main` as `941ceab` (PR #117, squash, 2026-08-16) — completing
roadmap Phase 8 and, with it, EVERY BUILD PHASE in the 8-phase roadmap**
(`docs/superpowers/plans/2026-07-29-roadmap.md`). Full narrative:
`docs/history/2026-08-16-phase-8c-backup-polish.md`. It gave the already-running nightly backup a face
and a pulse: a pure `backup-paths.ts` leaf (filename-shaped path confinement, no fs/db), the
`manage_backups` action + `backup_stale_hours` setting, the backup service (argv-spawned `pg_dump`,
fail-loud on an empty dump, `gzip -t`-verified before being declared good, a 30-minute stall ceiling
with SIGTERM→SIGKILL escalation), three gated routes, the `/admin/backups` page, a
`manage_backups`-only shell staleness bar, the deploy wiring (`postgresql18-client`, `BACKUP_DIR` +
the `./backups` mount on `app`/`backup` but pointedly **not** `app-practice`), **two**
permission-backfill migrations, and an expanded restore runbook. **`lastSuccessAt` is DERIVED from the
newest integrity-passing archive, never stored** — the archive is the evidence, which is what lets the
status file be a single un-merged overwrite a `sh` script can write. **Upgrading an existing install
now grants `manage_backups` automatically on `migrate deploy`** — no manual `npm run db:seed` step.
Reviews: nine per-task (seven clean on round 1), a 5-lens whole-branch review with **zero Critical**,
one fix wave, then **Codex's 3 P1 + 7 P2** — all three P1s in the *restore runbook*, which two prior
reviews had passed because they verified the commands **run** without checking what the shell
**semantics meant**. Final gates: **2988 tests / 179 files**, `tsc`/`eslint`/`build` clean, E2E
**23/23**, **39 migrations**, CI green. Deferred → issues **#118–#122**. **Env note: Docker is disabled
at boot** — check `systemctl is-active docker` before diagnosing ECONNREFUSED (§8, and the
session-memory index).

**Phase 7 (Template designer) MERGED to `main` as `56c9722` (PR #104, squash, 2026-08-14),
completing roadmap Phase 7.** Its full narrative is in
`docs/history/2026-08-14-phase-7-template-designer.md`; the one-paragraph entry is below under
"Merged, in build order".

**Phase 5 (Invoicing & A/R + QBO)** completed with the Phase 5C merge (`c069b09`, PR #92,
2026-08-10) — full record `docs/history/2026-08-10-phase-5c-close-qbo-export.md`. Its completion
unlocked parallel-run (roadmap: "Parallel-run capability begins after Phase 5"; acceptance criterion
spec §13 — one full closed month agreeing with the books), which the owner-owed GL-account list +
bookkeeper QBO homework still gate for a *real* export.

**Phase 6 (Quoting) MERGED (`e2c91e8`, PR #94, 2026-08-12)** — full narrative
`docs/history/2026-08-12-phase-6-quoting.md`; the demo ran 2026-08-12 with all 8 ratification items
RULED (`docs/2026-08-12-phase-6-demo.md`); deferred findings are issues **#95–#101**.

Carried A/R follow-up: issues **#69–#93** (§6) — **#81** (aggregate discount cap), **#84**
(delete-customer-with-live-payment) and **#91** (GL-export netting) are all DONE (branch
`fix-ar-money`, burn-down Group B), and **#68** (also done, Group A) carried
5C's posted-payment-reversal consequence (a posted payment can't be reversed by a re-export; a
spec-silent accounting decision). The older backlog (#51–#52, #59–#65, the per-worker-test-DB infra
task, §6) remains open too.

### Merged, in build order

The stack is **Node 26 · npm 12 · Next 16 · React 19 · Prisma 7 · PostgreSQL 18 · TypeScript 5.9 ·
Vitest 3** (brought current 2026-08-02 across five PRs; the two majors still blocked by what
`eslint-config-next` vendors are in §6).

- **Phase 1 — Foundation.** Merged and pushed. Auth (argon2id, hashed session tokens, sliding
  expiry, timing-attack-resistant login), the 12-area permission model with role grants and
  per-user overrides, the audit layer with before/after relation-aware snapshots, Settings as a
  typed zod registry, the admin pages (users/roles/settings/audit log), the permission-aware shell,
  and the Docker packaging with fail-loud nightly backups. **Seeded credentials `admin` / `admin` —
  change immediately on any real install.** Full record:
  `docs/history/2026-08-01-phases-1-2a-2b-foundation.md`.
- **Phase 2A — foundation refactors + reference data.** The five Task-0 refactors (`HttpError`
  extracted, one session resolution per request, the Prisma error-hygiene helper, redacted settings
  values, quiet dotenv), GL accounts, nine flat pick-lists and Process Step Codes with configurable
  field definitions, each with Excel export and spreadsheet paste. Full record: same file as Phase 1.
- **Phase 2B — customers.** Squash-merged `32f7f9d` (PR #2, 2026-08-01). Owner-assigned customer
  `code`, parent/division billing, the Phase 5 commercial fields, note blocks, typed addresses and
  per-document contact flags. Full record: same file as Phase 1; the eight review rounds and the
  issues they left are in `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md`.
- **The Prisma 7 upgrade** (`22e0dd3`, PR #11, 2026-08-01) — Prisma 6.19.3 → 7.9.1, the ESM flip,
  and **revival-on-create deleted everywhere it existed** in favour of unique-among-live-rows
  partial indexes (§5.11, §5.18). Full record: `docs/history/2026-08-01-prisma-7-upgrade.md`.
- **Phase 2C — parts and the recipe that belongs to the part**, split into three branches by owner
  ruling: 2C-1 shared foundations (`47d6d0a`, PR #12), 2C-2 parts core (`aeed372`, PR #13), 2C-3
  process steps + templates (PR #22, 2026-08-02, which also brought `npm run test:e2e`). Full
  record: `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md`.
- **Phase 3 — Orders & Loads.** Squash-merged `12a17f9` (PR #39, 2026-08-03). The eleven order
  tables and the whole order lifecycle: the one-transaction save with number allocation and recipe
  row-lock, auto-split loads, drafts and saved board views, permission-filtered global search, the
  order board and the ten-section order hub, and real PDF travelers stored byte-for-byte. Full
  record: `docs/history/2026-08-03-phase-3-orders-and-phase-2c.md`.
- **Phase 4 — Certifications & Shipping.** Squash-merged `f129aae` (PR #47, 2026-08-06), with the
  **backlog burn-down `8647a7d` (PR #57)** on top. Certs with the required/scope resolution chain
  and frozen requirements, shipments as documents (packing-list number, per-order sequence,
  multi-order shipments, the ship ledger, the credit-hold gate with reason-in-audit, void-with-
  reason), `StoredDocument` widened to the one document table behind a hand-written kind→owner
  `CHECK`, and the shipping-ticket/BOL/certification layouts built to the owner's samples. It also
  produced the **snapshot + release** rule and the **guarded-state-must-be-locked** house rule that
  CLAUDE.md now carries. Full record — including the six review rounds, the eleven lessons, and the
  owner rulings taken during execution: `docs/history/2026-08-06-phase-4-certs-shipping.md`.
- **Phase 5A — Pricing & Invoicing.** Squash-merged `359c707` (PR #58, 2026-08-08). Part pricing
  restructured off four flat `Part` columns onto **price rows keyed by Process Step Code** (setup/
  unit/minimum charges + price breaks, a pure `pricing.ts` engine), **surcharges** with per-customer
  opt-out/override, a one-row **`BillingConfig`**, and the full **invoice/credit lifecycle** —
  candidacy at SHIPPED, draft → finalize (writes `Order.status = INVOICED`) → unlock, or raise a
  credit (`kind = CREDIT`, own number series); the **reversing shipment** (reuses `void_shipper`'s
  claim machinery, and reopens the order it reverses — `REOPENED` if invoiced, else re-derives
  *Partial shipped*); and the invoice/credit PDF — six new tables behind two hand-written CHECKs.
  Final gates: **1692 tests**, `tsc`/`eslint`/`build` clean, E2E **16/16**. Codex's PR review found
  **7 real findings**, all deferred to issues **#59–#65** (§6). Full record — the twenty tasks, the
  owner rulings, the demo, and the review triage:
  `docs/history/2026-08-08-phase-5a-pricing-invoicing.md`.
- **Phase 5B — Accounts Receivable.** Squash-merged `b55da3b` (PR #74, 2026-08-09). The receipts
  ledger (`ReceiptBatch → Payment → Application`, one unified typed `Application` table behind
  `Application_source_check`), cash application across one or more invoices and a parent's divisions
  (partials, terms discounts, write-offs gated on a new `write_off` action, on-account, credit
  memos), **all balances derived live from `Application` rows — never cached on `Invoice`** (pure
  `ar-balances.ts`); point-in-time aging (`aging.ts`), informational opt-in finance charges
  (`finance-charges.ts`), and archived open-item statements (`statements.ts`); the `/receivables`
  UI + a `receivables` permission area; and the cross-phase `hasReceivableActivity` guard that
  refuses unlock/discard/void-order on paper with live A/R activity. Two 5A changes: a credit takes
  its own date; a finalized invoice gets a `dueDate`. Final gates: **1879 tests**, `tsc`/`eslint`/
  `build` clean, E2E **17/17**. The subagent-driven review process caught 5 real
  correctness/concurrency bugs on-branch; two Codex PR reviews were addressed (11 fixed on-branch,
  the rest **deferred to issues #68–#87** — #81 aggregate-discount-cap and #84 delete-customer-with-
  live-payment are the P1s). Full record — the 17 tasks, the whole-branch review, the Codex rounds,
  the owner rulings, and the lessons (incl. the review blind spot on spec-deliverable reachability):
  `docs/history/2026-08-08-phase-5b-accounts-receivable.md`.
- **Phase 5C — Month-End Close & QuickBooks Online Summary Export.** Squash-merged `c069b09` (PR #92,
  2026-08-10). Completes roadmap Phase 5. The guided, soft-reopenable month-end close (a frozen
  continuity schedule reconciled against 5B's aging) and the QBO **summary** journal export (a
  downloadable CSV + stored posting-register PDF, no live Intuit API): an append-only `GlPosting`
  ledger driving a strictly-per-period per-event **delta**, readiness that refuses any account-less
  non-TAX line, and a `period-locks.ts` leaf (per-`(year,month)` advisory lock, **all-Serializable**
  so SSI backstops the posting-vs-close phantom) wired into every 5A/5B posting mutation. Owner
  ruling 8 — **an invoice is recognized in its `finalizedAt` month** across the roll-forward, export
  scoping, and period lock; ruling 9 — **the export file is a summary by `(account, side)`**, detail
  kept in the ledger. Reviews caught four data-integrity/concurrency defects on-branch plus the
  cross-task reconciliation date-basis defect (the headline blocker) at whole-branch; two Codex PR
  rounds followed (3 fixed — the re-export-delta reversal of a changed reopened event, a `year>=2000`
  bound, a `closedAt` refresh; the rest routed to issues **#88–#93** / owner question **#68**). Final
  gates: **1947 tests**, `tsc`/`eslint`/`build` clean, E2E **18/18**. Full record:
  `docs/history/2026-08-10-phase-5c-close-qbo-export.md`.
- **Phase 6 — Quoting.** Squash-merged `e2c91e8` (PR #94, 2026-08-12). Standing-agreement quotes
  (per-order-line auto-link judged at link time, latest-effective-wins, wholesale tier-1
  substitution with `sourceQuoteNumber` frozen per invoice line, live-until-finalize), the
  follow-up/expired worklist, the `endingStatement` reference kind + `User.title` (closing Phase 4
  ping #4), the quote PDF (eighth document type, to the owner's sample, engine-computed indicative
  amounts), cross-entity §5.14 blocks, ruling 7's overlap-save warning (the whole-branch review's
  F1, built in-phase by owner direction as Task 12), and a new CLAUDE.md STANDING INVARIANT (the
  §5.14 quote-link SSI pairing, dangerous-direction-tested). Twelve tasks, all task-approved; the
  whole-branch review returned an **EMPTY mandatory fix wave** (zero
  correctness/concurrency/data-integrity findings); deferred findings → issues **#95–#100**; the
  8-item owner-ratification queue is owed at the demo (§6). Final gates: **2133 tests**,
  `tsc`/`eslint`/`build` clean, E2E **19/19**. Full record — the design session, the reviews, the
  Task 10 process incident and its no-pre-written-gate-rows rule, and the lessons:
  `docs/history/2026-08-12-phase-6-quoting.md`.
- **Phase 7 — Template designer.** Squash-merged `56c9722` (PR #104, 2026-08-14). All eight document
  types became data-driven templates (multiple per type, one default, per-customer assignment
  resolved division→ancestor→default, draft→publish versioning with immutable published versions, the
  structured contract-driven editor + logo + live preview) — spec §8 delivered in full, the roadmap's
  restyle-the-traveler outcome proven against archived PDF bytes. The eight builders became
  config-consumers under a golden gate; the four standing-text Settings retired into template content;
  `pdf-lib` (confined to `render.ts`) + a vendored 4-family font set power per-sheet-group page
  numbering. **All 21 tasks approved on review round 1**; the 5-dimension whole-branch review was
  CLEAN on concurrency/data-integrity; Codex's PR review then caught a **P1** the whole-branch pass
  missed (an `assignTemplate`-vs-`deleteCustomer` SSI race stranding a live assignment on a
  soft-deleted customer) plus two §5.12/§5.13 UI stale-state bugs — all fixed on-branch. Final gates:
  **2744 tests / 149 files**, `tsc`/`eslint`/`build` clean, E2E **20/20**, **35 migrations**. Fold-ins
  **#36/#43/#87/#97/#98** closed by the PR; deferred → **#102** (render two-pass blank-page artifact),
  **#103** (contract-tightening print-500 forward hazard). Full record — the seven-ruling design
  session, the 21 tasks and reviews, the decoder-oracle and StrictMode bugs found en route, the
  whole-branch + Codex rounds, and the lessons: `docs/history/2026-08-14-phase-7-template-designer.md`.

## 5. Conventions Phase 2+ must follow (learned and enforced in Phase 1)

1. **TDD per task**: failing test → implement → pass → commit. Vitest, real DB (`erp_test`), `truncateAll()` in beforeEach, `fileParallelism: false`.
2. **Services own business rules** (`src/server/*.ts`), route handlers stay thin: `requireUser` + `mustCan`/`mustDo` first line, zod parse, delegate. React components contain no business logic.
3. **Every mutation through the audit helpers**; extend `AuditableModel` and `SNAPSHOT_INCLUDE` (relations!) for each new entity. Never let a secret-bearing payload reach `write()` — redact() is defense-in-depth, not permission.
4. **Soft delete only** (`deletedAt`); active flags for hiding; hard delete never (tests excepted).
5. **Errors**: `HttpError(400/403/404, message)` for expected failures; `handle()` converts HttpError and ZodError to clean JSON; anything else is a bug. Field-anchored validation messages.
6. **Route handler tests pass ctx**: `handler(request, { params: Promise.resolve({...}) })` — the `Handler` type requires ctx (Next's ParamCheck rejects optional; still true on 16).
7. **Client components must not import from `src/server/**`** (drags node:async_hooks/Prisma into the bundle) — shared constants live in `src/lib/` (see `permission-constants.ts` precedent).
8. **Server-rendered pages that fetch data must call `requireUser` themselves** — the proxy (`src/proxy.ts`) is a cookie-presence redirect only. (Phase 1 pages are client components hitting guarded APIs, which is also fine.)
9. Conventional commits, ending with the Co-Authored-By line already used throughout `git log`.
10. Prisma migrations are applied to BOTH databases: `npx prisma migrate dev` (dev), then `npx prisma generate` (v7's `migrate dev` no longer does this for you — the client is gitignored, so skipping it leaves you typechecking against a stale one), then `DATABASE_URL=<erp_test url> npx prisma migrate deploy`. `migrate dev` needs a TTY and refuses in a non-interactive shell (e.g. a Claude Code session) — see `CLAUDE.md`'s "Constraints that will bite you" for the `migrate diff` + hand-written-migration workaround.
11. **There is no revival-on-create — deleting it was the point of the Prisma 7 work (§5.18, DONE).** This item used to read "any model with a `@unique` column plus soft delete needs revival-on-create, and a revived row must be indistinguishable from a fresh create" — that rule was got wrong four times across two phases, always where it was reimplemented rather than shared, and the fix was to make the situation stop arising rather than to keep sharing a rule with that track record. Unique columns on soft-deletable models (`Role.name`, the ten reference kinds' `name`, `ProcessStepCode.code`, `Customer.code`) are now unique **only among live rows** (`@@unique([col], where: raw("…"))` — a partial index filtered on `deletedAt IS NULL`). A re-used code or name is a genuinely new row with its own id and a real `"create"` audit entry; the archived row keeps its own id, its real value, and its own history. `User.username` deliberately keeps a plain `@unique` — `createUser` has no revival branch and users are never re-created by name. **Do not add a revival-on-create site back** — if a new soft-deletable model needs a unique column, give it the partial-unique treatment instead. `findUnique`/`upsert` on a live-rows-only column is banned and swept (`tests/partial-unique-sweep.test.ts`) — the generated client still types the column unique, so both compile, and `findUnique` silently returns the *deleted* row. The sweep also covers `findUniqueOrThrow`, `update` and `delete`, which take the same `WhereUniqueInput` and are worse: keyed on such a column they write to, or hard-delete, the *archived* row while the live one goes untouched. **One known limit, and 2C is the first phase that can trip it:** the sweep reads `schema.prisma` with regexes that assume `@@unique(` is followed by `[` on the *same line*. Every one of the 13 current blocks is single-line, but a `@@unique(...)` wrapped across lines would match neither the "already correct" check nor the "flag as bare" check — silently voiding the guard in both directions. Keep these attributes on one line, or teach the sweep to parse multi-line blocks before wrapping one.
12. **Detail pages must remount per record** (`<Detail key={id} …>`), and any field bound with `defaultValue` will otherwise keep the previous record's text and write it onto the one now on screen. Cost a Critical in 2B.
13. **A reload that clears the error banner must never run after the error is set.** Roll back to server truth *first*, then report why. This exact shape recurred three times on one page; the durable fix was making the save report success so callers stop reloading defensively.
14. **A blocked delete must name its blockers** (owner's ruling, 2026-07-31, issue #6). Deleting a reference row that other records point at is **refused**, not allowed-and-cleared and not allowed-and-dangled — consistent with `deleteCustomer`'s "still has child customers" and `deleteRole`'s "still assigned" guards. But refusing is only one third of it: the screen must also **list the actual referencing records** (linked to their detail pages) and **export that list to Excel**, reusing the export the reference tables and customer list already have. The reasoning is a live Visual Shop dead end the owner is escaping — Visual Shop blocks these deletes too, and the guard is not the problem; naming no blockers is. There, a furnace group cannot be deleted because a process master points at it, and that process master cannot be deleted because parts point at it, with no way to find those parts: "it would take me a year to find them all and point it elsewhere." **A block without discoverability looks like data integrity while actually being a permanent dead end.** Note this never obstructs what delete is genuinely for — a row typed by mistake has nothing pointing at it — and ordinary retirement stays on `active: false`, which already keeps existing assignments displaying correctly (2C must not conflate the two: *inactive* hides a row from pick lists while keeping assignments valid; *deleted* hides it from everything). Building it needs a registry of which columns point at each reference kind — today `Customer.termsId`, `ProcessStepCode.glAccountId`, `PaymentType.glAccountId`, `InspectionCode.defaultScaleId`, plus parts' four in 2C — guarded by a sweep test that walks the Prisma schema and fails on an unregistered FK, the `tests/permissions-sweep.test.ts` technique. **Bulk re-point** ("move everything pointing at X to Y, then delete X") is committed but deferred to Phase 8: the system starts empty so blocker sets stay small for years, but build the registry to support it now so it is an addition rather than a retrofit.
15. **Reading a pick-list needs only a session; managing one still needs `admin`** (owner's ruling, 2026-07-31). Reference data currently lives entirely under `/api/admin/reference/*` behind `admin.view`, so a user holding `customers.edit` but not `admin.view` gets an empty Terms dropdown — and because the fetch ends in `.catch(() => {})`, it looks exactly like a shop with no terms configured. 2C adds four such dropdowns to one screen and later phases add carriers, container types, comment snippets and payment types, so the fix is one route, not a widening of `admin` per screen: **a read-only `/api/picklists/[kind]` gated on `requireUser()` alone**, returning a narrow `id`/`name`/`active` projection. Create/edit/delete stay under `admin` on the existing route. **`glAccount` is excluded** and stays `admin.view`-only — it is the one kind no data-entry screen ever reads (step codes and payment types reference it, both admin screens), so excluding it costs nothing and keeps chart-of-accounts numbers out of a route every signed-in user can reach. The reasoning for the rest being open: these names are vocabulary, not secrets — materials and specifications are the language of the paperwork customers already receive, so hiding them from someone who can view the certs they print on protects nothing. The point of a route rather than a 13th permission area is that **there is nothing to grant and therefore nothing to forget**: an area would relocate the silent-empty-dropdown failure to a role misconfiguration instead of removing it. While building this, **drop the soft `.catch(() => {})`** on every pick-list fetch — a failed request must say so rather than impersonate an empty list.
16. **A control the user cannot use is disabled and says why — never silently hidden** (owner's ruling, 2026-07-31, issue #7). Action buttons (add, delete, make default, Delete customer, the list pages' Add row and Paste from spreadsheet) stay visible but disabled, with a tooltip naming the missing permission — "Requires customers.delete". Fields are not a choice and never were: a `customers.view`-only user still has to read the name, terms and notes, so inputs render **read-only** rather than hidden. This is §5.14's rule applied to permissions — a block must name what is blocking it and give a route to resolving it — and a hidden button is a block with no explanation, leaving the user unable to tell whether the action is missing, broken, or forbidden, and with nothing to ask for. `Shell.tsx` keeps *hiding* nav entries and does not need to match: deciding which features exist at all is a different problem from being stopped mid-task. `/api/auth/me` already returns a flat array of granted keys, so a gate is `me.permissions.includes("customers.delete")` — build **one shared helper** rather than per-page conditionals, since 2C needs it on every parts screen and the customer pages should adopt the same helper. Not reachable while the owner is the only user and an admin; it matters the moment a second user exists.
17. **A delete needs a reason when it takes other records with it or frees a unique identifier for reuse** (owner's ruling, 2026-07-31, issue #8 — this is what spec §9's undefined "destructive-ish" means for this project). Today that is **customer** (built: cascades to addresses and contacts, frees `code` for an unrelated future customer) and **role** (still to build: carries its permission grants away, frees the role name). It is *not* addresses, contacts, process step codes, or reference rows — §5.14 already blocks deleting a reference row anything points at, so a delete that gets through is low-stakes. Requiring a reason on *every* delete was considered and rejected: demanding a justification for a carrier typed wrong four seconds earlier trains people to type "x", and a log full of junk reasons is worse than one where the field means something. Enforce it **in the service, not only the route**, so no future caller can bypass it, and trim before storing so whitespace cannot masquerade as a justification. Classify each new entity against this rule as it is built.
18. **DONE (2026-08-01, branch `prisma-7-upgrade`). Revival-on-create was removed, not consolidated — Prisma 7 was the prerequisite** (owner's ruling, 2026-07-31, issue #10). A unique `code`/`name` plus soft delete meant a deleted value physically occupied the constraint, so a re-create had to *reuse the dead row*. That reuse also reused its **audit identity**: `HistoryPanel` queries by `entityId`, so one company's entire history rendered under an unrelated company's record, the creation was logged as `"update"`, and `createdAt` belonged to the previous occupant. §5.11's rule ("indistinguishable from a fresh create") was never extended to identity, which is where it breaks — and the rule had been got wrong four times across two phases precisely because it was reimplemented rather than shared. **The right outcome for a rule with that history is that the situation it governs stops arising.** The fix: make the column unique **only among live rows**, declared in `schema.prisma` as `@@unique([code], where: raw("\"deletedAt\" IS NULL"))`. An archived row then keeps its own id, its real value and its history; a reused code is simply a new row with a new id and a real `"create"` entry. **Prisma 6.19.3 rejects that syntax outright ("No such argument") — verified, so the upgrade was a genuine prerequisite, not a preference.**

    **Three things this plan got wrong when it was first written, corrected here in place rather than silently fixed elsewhere, so a future reader doesn't re-derive them:** (1) it said `@@unique` takes no `where` and wrote the syntax as `@@index([code], where: "…", unique: true)` — wrong on both counts; the working form is `@@unique([col], where: raw("…"))`, and a bare string is rejected, only `raw(...)` works. (2) it didn't know `partialIndexes` is a **preview feature** in 7.9.1, not stable — the owner approved using a preview feature for this specific purpose on 2026-08-01, which is also why the Prisma packages are pinned exactly (no `^`) rather than caret-ranged. (3) it predicted the client's generated types would force the `findUnique` → `findFirst` conversion, reasoning "the column is no longer a declared unique field on the client." **That's false, and it's the dangerous kind of false — silent, not a build error.** A partial unique index does not remove the column from Prisma's generated `WhereUniqueInput`: `findUnique({ where: { code } })` still compiles and silently returns the *soft-deleted* row. `upsert` on the same column is state-dependent — with only a dead row it succeeds and silently reuses it; with both a dead and a live row it throws P2039. None of that is caught by `tsc`, `eslint`, or a test that happens not to have a deleted row lying around, which is exactly why `tests/partial-unique-sweep.test.ts` exists: it sweeps every `.ts` file under `src/` and `prisma/seed.ts` for `findUnique`/`upsert` keyed on a live-rows-only column, and separately asserts no soft-deletable model still carries a plain field-level `@unique`. The actual `findUnique` → `findFirst` conversions below were a manual audit against that sweep's findings, not a compiler-forced one.

    The upgrade path was documented before work started — the owner found it: the official guide is <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>, and Prisma publishes an **AI-agent migration prompt** at <https://www.prisma.io/docs/ai/prompts/prisma-7> laying out an 11-step process. This repo was measured against the guide on 2026-08-01 — §4b was the survey, and now also records the outcome (§4b is now `docs/history/2026-08-01-prisma-7-upgrade.md`). All four quality gates were kept green throughout, applied to both databases. The index change was applied to **every** revival site — `customer`, `role`, all ten reference kinds, `processStepCode` — `REVIVAL_DEFAULTS`/`REVIVAL_EXTRA_DEFAULTS` and every revival branch deleted, each `findUnique({ where: { code|name } })` converted to `findFirst({ where: { code|name, deletedAt: null } })`, and the revival tests rewritten to assert a **new id and a fresh history** instead of a reused row. Final suite: 258 tests, 31 files, zero skipped.

### 5a. Working conventions for code-review rounds (added end of Phase 2B)

**Triage rule (owner's, 2026-07-31):** a finding that *fundamentally breaks something* gets fixed on the branch; anything minor gets filed as a GitHub issue instead. "Breaking" has meant: silent data loss or corruption, a 500 where the spec promises a field-anchored 400, an audit trail that misstates what happened, a silent failure the user cannot diagnose, or a stated deliverable being unusable (e.g. a field the model supports but no screen can enter). "Minor" has meant: narrow compound races where the database stays correct, and product-rule decisions that belong to the owner rather than to a fixer.

Reply on every thread with the disposition and the commit or issue number, then resolve it — reviewers and the owner both read the thread, not the summary.

**Verifying UI findings needs the bundled Chromium, driven directly.** The Playwright and chrome-devtools MCP servers both look for a Google Chrome binary at a root-owned path that is not installed, and there is no sudo. Four separate agents hit this and silently fell back to curl, which cannot see a rendering or state bug. What works:

```bash
npx playwright install chromium     # once; no sudo needed
# then import from the npx cache whose version matches the installed build:
#   node -p "require('<cache>/playwright-core/package.json').version"
#   ls ~/.cache/ms-playwright        # chromium-<rev> must match browsers.json
```
Then write a small `.mjs` that imports `chromium` from that cached `playwright` and drives `npm run dev`. Three traps worth knowing: React controlled inputs do **not** expose `value` as an HTML attribute, so `input[value="X"]` selectors fail — locate by index or label instead; the app shell has its own global search box, so `input[placeholder*="Search"]` matches two elements. Dump the page's inputs first rather than guessing selectors. And **`getByLabel(..., { exact: true })` on a `<select>` nested inside its own `<label>` (rather than an `aria-label`/`for`) can match ZERO elements even though the label text looks right** — Playwright's label-text computation for that case is the label's FULL `textContent`, which for a `<select>` child recursively includes every `<option>`'s own rendered text (`getByRole("combobox")`'s accessible-name computation does NOT have this problem — confirmed live, Task 17/Phase 5B). A plain `<input>` has no text content of its own to pollute the label with, so this is `<select>`-specific; fix with a scoped `page.locator("label", { hasText: "…" }).locator("select")` instead of chasing `exact`.

Always clear the fixtures you create out of the **dev** database afterwards — `erp`, not `erp_test`.

## 6. Known backlog (all triaged, none blocking)

**#115 (P1) — FIXED 2026-08-16, branch `fix-allocation-retry` (`fc7eb54`), the burn-down's Group A.**
Concurrent `allocateNumber` aborted with 40001 under Serializable with no retry on any caller, so
concurrent creation of every numbered entity (order, shipper, BOL, credit, receipt batch, quote, GL
export) was broken. Full account, including the two corrections measurement made to the issue's own
analysis, in §4. **#68 rode the same branch** (owner ruling: add a `reopen`).

**Phase 8C (Backup polish) follow-ups — GitHub issues #118–#122 (2026-08-16), all deferred by the
whole-branch triage rule, none correctness/concurrency/data-integrity.** #118 unbounded concurrent
`gzip -t` per Backups-page load (and an uncached decompression per `/health` poll, which the shell bar
makes from every page); #119 preflight failures of a manual backup (missing/unwritable `BACKUP_DIR`,
unset `DATABASE_URL`) produce no audit row despite the stated rule that failed attempts are access
events; #120 a failing retention `find` leaves the status green while retention is silently broken;
#121 the error bar reaches non-`manage_backups` users during a total DB outage, because the silencing
403 itself needs a DB read — **RULED by the owner 2026-08-16 (reword the unknown-cause bar) and
BUILT** in Group D; the issue's own suggested direction proved unbuildable, since telling "cannot
determine your permissions" apart from "status unavailable" needs the same database that is down.
**#118's bound is PER-TRAVERSAL, by owner ruling 2026-08-17 — there is no module-wide semaphore, and
that is deliberate.** A shared slot bounded the process more tightly, but every mechanism it needed to
be *correct* generated the next review finding — freeing a slot held by a wedged child, then accounting
for a timed-out-but-still-alive child, then keeping the write path inside the same ceiling — six rounds,
each fix creating the next. #118 asked for "a small concurrency limit, or cache results keyed on file
metadata"; `mapLimited` per traversal + in-flight coalescing + the intact-only cache deliver exactly
that and delete the whole class of failure, because there is no shared slot to exhaust, leak or bypass.
The trade is stated in the code and pinned by a test rather than left implicit: concurrent readers each
get their own budget, so a busy moment reaches ~8–12 checks rather than 4 — bounded, and acceptable for
1–5 users. Two related rules fell out of the same rounds: **only an `"intact"` verdict is cached** (a
rejection may be a timeout, and caching that would hide a recovered archive), and **the WRITE path
verifies with the dump's own generous deadline, never the banner's 60s read poll** — a timeout there
DELETES the fresh archive and records a failure, so a short deadline would make "Back up now"
progressively unusable as the database grows while the nightly path, which has no verification deadline
at all, kept working.
**#118, #119, #120, #123 and #124 are all DONE in the same group** (branch `fix-backups-followups`):
bounded + metadata-and-TTL-cached integrity checks, audited preflight failures, a failing retention
prune now going red instead of leaving the previous green, the practice copy's own controls disabled
with the server's sentence as the tooltip (nav entry kept, `nav.ts` untouched per §8), and the shell
bar refreshing after a successful "Back up now".
**#122 — FIXED on branch `fix-vitest-collection` (`c69d82a`), the burn-down's Task 0.** `vitest.config.ts` set no `include`/`exclude`, so after a build vitest also
collected `.next/standalone/**/tests` and ran every file twice — gate ORDER silently mattered and any
post-build count was inflated. Measured on `main` with a build present: `vitest list --filesOnly`
emitted **358 files for 179 real ones**. Now `include: ["tests/**/*.test.{ts,tsx}"]` plus
`exclude: [...configDefaults.exclude, "**/.next/**"]`, with `tests/vitest-collection.test.ts`
guarding both. **Gate order no longer matters** — verified by running the full suite with the 179
stale copies still on disk: 180 files, zero `.next` paths. The trap for anyone extending that guard is
recorded in its header: **`.next` is a dot-directory and vitest matches with `dot: true`, while Node's
`path.matchesGlob` does not** — so a behavioural model of the build-output half written with
`matchesGlob` is green no matter how broken the config is (it scored the pre-fix config as safe on the
first draft). That half is therefore guarded by construction, not by simulation.

**Five issues are absorbed into Phase 7's scope by owner ruling 6 (2026-08-12, P7 spec §5.8):
#36 (traveler continuation-page header), #43 (bounded all-loads traveler render), #97
(`indicativeAmounts` length assert), #98 (`sourceQuoteNumber` `.refine`), #87 (safe
Content-Disposition filenames).** They stay open on GitHub until their fixes land on the Phase 7
branch; the entries below are unchanged as the record of what they are.

**Phase 6 (Quoting) follow-ups — GitHub issues #95–#100 (2026-08-12), all deferred by the
whole-branch triage rule, none correctness/concurrency/data-integrity.** #95 dangerous-direction
tests for the deletePart/deleteCustomer↔quote-writer SSI pairings (holes verified NOT live;
`Quote.customerId` immutability is the load-bearing untested dependency); **#96 — FIXED 2026-08-17
(round 2's Group A)**: the zero-net corrupt-quote-link asymmetry (a 500 on a zero-net LEAD line, a
silent skip on a zero-net rider) is closed by validating the link before the seam-#3 skip, so both
throw — the safe direction on corrupt state, and no longer dependent on which position the line
happens to occupy; #97 `indicativeAmounts`
`ops[i]` length assert; #98 `sourceQuoteNumber` `.refine` on the manual-lines save; #99 promoting
a soft-deleted reference row's `isDefault` 200s silently (inherited generic-service hole, also
terms); #100 the minors bundle. Full triage: the whole-branch section of
`docs/execution/2026-08-10-phase-6-quoting/progress.md`.

**RULED at the Phase 6 demo, 2026-08-12 — all eight items** (full record `docs/2026-08-12-phase-6-demo.md`;
items 1–4 and 6–8 ratified/accepted as built, item 5 → issue #101, item 8's demo observation →
#100). The queue as it was assembled (item 9, the ruling-7 overlap warn, was resolved on-branch
by Task 12): (1) `createQuote` refuses an inactive
customer but accepts an inactive part on a linked line; (2) a CLOSED quote still blocks
`deletePart`/`deleteCustomer` — only deletion clears the block (the reviewer ruled it right under
the standing-agreement model — ratify); (3) the one-time dormant-column audit churn on the first
line-tree save after attach-part; (4) the invoice grid names EVERY operation line's source while
the PDF annotates QUOTE lines only; (5) the part page's Active-quotes section reads
`/api/quotes/eligible` with `orders.view` — arguably `parts.view`/`quotes.view` by that route's
own §5.15 reasoning; (6) the "Quoted by" picker's options require `manage_users` (the only users
list); (7) `QuoteLine.eachWeight` mirrored at the Part's real `Decimal(10,4)` — spec corrected in
place; (8) the quote PDF's 9 documented layout deviations (the 5A-demo channel; list in
`docs/execution/2026-08-10-phase-6-quoting/task-10-report.md`).

**Phase 5B (A/R) follow-ups — GitHub issues #68–#87 (2026-08-09), all deferred by owner ruling,
none blocking the 5B merge.** #68–#73 are the design-session owner rulings surfaced at the demo
(POSTED-batch lifecycle, discount basis, credit-balance statements, customer-section family roll-up,
the vestigial `"ar"` area, post-dated payments). #75–#80 and #81–#87 came from the two Codex PR
reviews (11 findings were fixed on-branch; the rest filed): missing UI paths (credit-apply,
finance-charge-exempt setter, standalone bad-debt write-off), the point-in-time reproducibility gap
(#78 — 5C's close depends on it), the issued-terms discount snapshot, the postBatch balance check,
and **the two P1s — both FIXED 2026-08-16 on branch `fix-ar-money` (burn-down Group B): #81** (the
discount cap was per-line, not aggregate — fifty $20 lines waived a $1,000 invoice; now capped in
aggregate per invoice within the request, `1bb42b3`) **and #84** (`deleteCustomer` didn't block a
customer with live payments and stranded the cash; now a fourth §5.14 blocker category with its own
route/export entry, `8229413`). **#81 leaves a measured SCOPE BOUNDARY that is the owner's call:** the
cap is per-REQUEST, and `elig` is recomputed each call as a percentage of the CURRENT open balance, so
a second call after a $20 discount is still offered $19.60 and takes it — the series converges on the
whole receivable. Closing it means ruling whether the entitlement is 2% of the invoice total ONCE or
2% of whatever is open (what is built, and what `discountAvailable` shows). Pinned as a test so any
change is deliberate. Full triage: `docs/execution/2026-08-08-phase-5b-accounts-receivable/progress.md`.

**Phase 5C (close + QBO export) follow-ups — GitHub issues #88–#93 (2026-08-10), all deferred, none
blocking the 5C merge.** #88 the continuity chain goes stale when a NON-latest month is reopened
(self-protecting — the forward close refuses on a nonzero variance and the export is event-based).
**RULED by the owner 2026-08-17: option (c), SURFACE A BROKEN-CHAIN FLAG** — `listClosePeriods` flags
any closed month whose `beginningAr` no longer equals the prior month's `endingAr`, and the operator
re-closes the affected months. Nothing is refused and nothing cascades automatically: this is the
§5.14 "name the blocker" shape rather than a wall (option a would dead-end someone correcting an old
month) and it keeps re-closing an explicit, audited act rather than a side effect (option b). Not yet
built. **#89 — FIXED 2026-08-17 (round 2's Group A).** A freight/charge line finalized before its GL
default read clean in readiness and then 500'd the export (self-protecting via the Σdebit=Σcredit
backstop). Readiness now emits an invoice-attributed gap ALONGSIDE the plant-default one, since the
two are independent fixes. **The issue's stated blocker — "there is no invoice detail page to anchor
its fix-link" — was simply wrong**: `/invoicing/[id]` has existed since 5A, and the gap links
straight to it. Worth remembering as a small instance of the standing rule: check the claim against
the code before pricing the work. #90 the cosmetic follow-ups bundle. **#91 — RULED and DONE 2026-08-16 (`0b5ea81`, Group
B): the summary export is NETTED** to a single signed column per `(account, side)`, larger side wins
— so an invoice + same-month credit emits one `A/R 60.00` debit instead of `100.00` debit AND `40.00`
credit. Decided deliberately WITHOUT waiting on the bookkeeper, because a gross dual-column line
risks importing 150 where 120 was meant. **A group netting to EXACTLY zero is dropped**, not emitted:
`renderCsv` renders a zero as `""`, so keeping it would emit a row carrying no amount at all. The
per-event `GlPosting` ledger stays gross and un-aggregated. #93 the GL-export
create-audit records batch metadata only, not the emitted journal (the postings ARE persisted
immutably on the batch, so it is completeness, not data loss). Plus the Codex re-raise of **#68**
(carried from 5B, with the GL-export consequence) — **RULED option (b) and BUILT 2026-08-16, branch
`fix-allocation-retry` (`20ed463`)**: once a receipt batch was POSTED there was no path to correct or
reverse its cash, so a posted payment could never reach a reversing QBO delta (the delta's
payment-reversal branch was dead code for PAYMENT keys). **`reopenBatch` (POSTED → OPEN) closes it**
— a posting mutation carrying the full discipline (Serializable, the batch claim, and the period
guard, since un-posting drops that cash out of recognition and must never touch a frozen month), so
the correction path is now reopen-period → reopen-batch → correct → re-close → the re-export
reverses. `voidBatch` gained the POSTED guard it lacked (an EMPTY posted batch was voidable while a
non-empty one was frozen solid), checked BEFORE the live-payment guard so the message names `reopen`
rather than sending the operator at a control `refusePosted` refuses. The month-locking loop is now
`assertBatchMonthsOpen`, shared with `postBatch`, so the ascending-order rule for advisory mutexes is
stated once. Gated `receivables.edit` (symmetric with the post it undoes), reason required and
audited. **One consequence the ruling did not cover, found in self-review and now measured:** a
POSTED batch's payments can carry live applications (§5.2), and reopening strands none of them —
`ar-balances` never looks at batch status, so the invoice balance is unmoved and `voidPayment`'s
applications-first guard is deliberately NOT copied onto reopen (voiding *strands*; reopening does
not). GL recognition does move, and the close is the net: `preliminaryReport` shows variance 0 → 300
and `paymentTotal` 300 → 0 the moment the batch reopens, so **the month refuses to reconcile until it
is re-posted**. Operationally that means a reopened batch left un-re-posted blocks month-end — loud,
not silent, which is the design. Full triage:
`docs/execution/2026-08-09-phase-5c-close-qbo-export/progress.md`.

**Owner-approved, scheduled for immediately after Phase 5A merges (owner, 2026-08-06):
per-worker test databases, to lift the suite's serial-execution ceiling.** The suite is at 1425
tests running strictly one file at a time — `vitest.config.ts` sets `fileParallelism: false`
because every test file shares the single `erp_test` database and calls `truncateAll()` in
`beforeEach`, so two files running at once would truncate each other's fixtures. That is correct
today and must not simply be switched off. The fix is to give each vitest worker its own database
(`erp_test_1..N`, selected from `VITEST_WORKER_ID`), migrated the same way `erp_test` is, after
which `fileParallelism` can be re-enabled. Deliberately **not** done inside Phase 5A — it is an
infrastructure change with no business riding in a pricing PR, and it touches the harness every
other task depends on. Wall-clock now: ~127s for vitest alone.

**RULED 2026-08-16 — YES, order-line edits freeze too — and BUILT** (issue #126, `de9ed88`, burn-down Group C: one guard mirroring `replaceCharges`, read under the order claim; the unlock → edit → re-finalize correction route is tested end to end, since after this guard it is the ONLY one. **`removeLine` keeps only its shipped-line guard per the ruling's scope, so an UNSHIPPED line on an invoiced order can still be removed** — recorded in a test rather than assumed.) (Original framing kept
below for the reasoning.) **OWNER DECISION, now closed (filed 2026-08-07 by the Phase 5A whole-branch
review) — should editing an already-invoiced order's LINES freeze, the way its charges do?** Spec §5.7's freeze covers extra
charges, voiding, and shipment edits on an order that has a finalized invoice — but `addLine`/
`updateLine` (`orders.ts`) are NOT blocked. It is not a bug today: the finalized invoice is frozen
paper (a snapshot), so a later line edit changes nothing on it, and the correction path
(unlock → recalculate) re-prices the edited line correctly; `removeLine` is separately blocked for
shipped lines. The whole-branch reviewer confirmed no money error and no status corruption (the
INVOICE_OWNED skip holds). So this is a consistency question, not a defect: §5.7 enumerates what
freezes and does not list order-line edits. If the answer is "lines should freeze too," it is a
one-guard addition mirroring `replaceCharges` (call `finalizedInvoiceFor` and refuse); if "no," it
stays as built. Owner's call.

**DEFERRED, owner ruling 2026-08-07 — multi-order freight over-bills, and it is knowingly left.**
Phase 5A invoices one order at a time (spec ruling 5, no grouping), but freight is a shipment-level
amount, so N orders on one billable-freight truck each bill the full truck freight — an N× over-bill.
Task 11's code follows the spec's freight rule faithfully; the contradiction is in the spec. The
owner's shop **does not bill freight**, so nothing is wrong in this deployment, and the correct split
(freight-on-one-order / proportional / single-order-only) is a billing-policy question the owner
wants to research against other shops before it is built. Full context: the dated amendment beside
the freight rule in the P5A spec (§5). When picked up, the chosen rule must sum back to the truck's
exact freight exactly once. **Do not invent a split.**

**Phase 5A demo (2026-08-07) — the six flagged deviations, all ruled** (full context
`docs/2026-08-07-phase-5a-demo.md`): (1) a reversing shipment now **reopens the order it reverses**
— RULED and BUILT (`aea35a3`, spec §5.2/§5.6 amended: non-invoiced → *Partial shipped*, invoiced
→ *Reopened*); (2) the credit PDF's **"Credit" title** approved as-is; (3) the negative-amount
**`"$-937.44"` format** approved as-is; (4) the three print-layout deviations accepted; (5)
multi-order freight confirmed a deliberate deferral (its own entry above); (6) whether a credit
carries its own raise-date vs the source invoice's `invoiceDate` — **deferred to 5B** (spec §16,
carried in §9's kickoff). Only (6) is still open.

**Deferred from the PR #58 Codex triage (2026-08-08), issues #59–#65 — all verified real against
the branch, none already fixed; none data-loss, but three are money/status defects. SIX OF THE SEVEN
ARE NOW FIXED — round 2's Group A, branch `group-a-invoice-engine` (#59, #60, #61, #62, #63, #64,
plus #89 and #96 from later phases). ONLY #65 REMAINS**, and it is round 2's Group C. The original
analysis is kept below because it is what made the fixes checkable.** The owner
elected to defer all seven to the post-5A burn-down rather than fix in-branch (the #48–#56
pattern); every PR thread was replied to and resolved. **#59** unlocking a *credit* recomputes the
order's invoice-owned status back to ship-derived (no `kind` branch, unlike finalize) — a
still-finalized source invoice's INVOICED order silently drops to SHIPPED. **#60** `listPartPrices`
reads the top-level client inside the Serializable invoice transaction (`part-prices.ts:51`),
outside its snapshot/read-set, so SSI can't see a concurrent price edit (the pool-starvation half
does not apply — the pg pool defaults to 10). **#61** Recalculate double-bills a manually-overridden
operation — the derived line regenerates AND the `MANUAL` override is preserved. **#62** a
manually-added charge line gets no GL account and no way to set one (grid GL is read-only; seam
#1's backfill is engine-only), so it posts nowhere and 5C's export drops it. **#63** an emptied
invoice finalizes into a $0 INVOICED order that is no longer a candidate (finalize's only block is
`needsPrice`, vacuous on zero lines). **#64** Recalculate computes no tax on preserved manual
charges (tax is priced before manual lines load; `totalsFromLines` re-sums the stale TAX line).
**#65** voiding either side of a reversal pair corrupts the order (`voidShipper` is
reversal-unaware — stuck *Partial shipped*, or negative `shippedTotals`); non-invoiced pairs are
exposed, invoiced ones only incidentally protected by `refuseIfInvoiced`.

**What Group A actually changed (2026-08-17), beyond the six one-line descriptions above.** Four of
the six were more than their issue said, and the differences are the part worth carrying forward:

- **#61 generalized past operations.** The fix is not an operation-specific dedup but one identity
  rule — `overrideKey` in `invoices.ts` — because the same double-bill existed for every kind the
  grid lets an operator retype: a manually edited TAX line regenerated its derived twin too. A manual
  line now pairs with the derived line sharing its order-side identity (order line + step code;
  surcharge; order charge; FREIGHT/CERT/TAX as singletons) and is **substituted into that line's
  slot**, keeping its place under its PART line. A manual line matching nothing is an addition and
  still rides at the end (§5.5). **Review round 1 found the step-exact identity insufficient**, and
  the miss double-billed exactly as the original defect did: a derived operation can come back under
  a step code the override does not name — the operator typed into the tier-3 "needs price" line
  (which carries NO step code) and the part has since been priced, or an operation's part price was
  retired and re-added under a different code. (The step-code ROW cannot be soft-deleted underneath a
  live override — `assertLineRefs` 400s on the preserved manual line first — so the reachable
  mutation is always the price row, which is what the tests do.) An unmatched OPERATION override
  therefore falls back to its ORDER LINE. **Review round 2 then found the fallback was the mirror of
  the bug it fixed**: on a line pricing steps A and B, with A overridden and A's price then retired,
  the override took B's slot and B's revenue vanished from customer paper — a double bill traded for
  an under-bill. So it re-homes **only onto an operation that has APPEARED SINCE** (compared against
  the invoice's previous derived identities, read before the delete); an operation already carrying
  its own derived line is a sibling, and when nothing qualifies the override rides as an addition
  where the operator can see it. How much it takes is the remaining care: no step code ⇒ every
  qualifying operation on the line, a step code ⇒ exactly one. Both the round-1 and round-2 cases are
  now tested. **The lesson is the project's own** (round 1's lesson 4): two successive rounds found
  defects in the same fallback, each in the code written for the previous round. Round 3 approved it.
  **One limit is RULED, not fixed, and is surfaced instead:** a tier-3 override (no step code) covers
  every priced operation on its order line INCLUDING work priced afterwards, and the stored state
  cannot tell that work apart from what the price was typed for — so `invoiceWarnings` says the line
  is "standing in for every priced operation on this part" rather than a heuristic guessing at money.
  Whether that absorb-all rule should narrow is an owner question, filed as its own issue.
- **#64's fix is what makes #61's honest.** Tax is recomputed over the FINAL line set through
  `pricing.ts`'s new `taxOnLines`, which shares its taxable-kind list with `priceOrder` so the two
  cannot drift. Without it an overridden operation stayed taxed at the figure the operator overrode
  away. A manually overridden TAX line is left exactly as typed — the override wins, uniformly.
  **It has TWO seams, not one** (review round 1): "Save lines" and "Recalculate" are independent
  buttons, nothing makes an operator press the second, and finalize freezes whatever is on the
  invoice — so `replaceInvoiceLines` re-derives tax as well, off the invoice's own snapshot rate.
  Re-deriving only in `recalculateInvoice` still let a typed taxable charge print under-taxed.
- **#62 has a second half the issue did not name:** `invoiceWarnings` only flagged lines carrying a
  step code, so even after the server default a genuinely account-less line stayed silent. It now
  flags EVERY account-bearing kind (all but PART, which posts nothing, and TAX, whose account comes
  from the config at export time).
- **#89 needed BOTH gaps, not a replacement.** Configuring the plant default and re-raising the
  frozen paper are two independent fixes and either can be outstanding alone, so readiness emits the
  plant-default gap AND a new `invoice`-kind gap naming the invoice, linked to it, saying to unlock
  and re-finalize. **Review round 1 widened the invoice gap to EVERY frozen null-GL line**, not only
  FREIGHT/CHARGE: an OPERATION/SURCHARGE/CERT line frozen null whose step code or surcharge already
  HAS an account raised only "step code X has no GL account", sending the operator to a screen with
  nothing to fix — the §5.14 dead end one notch milder than the 500 — and a CERT line whose
  configured cert step code row is gone recorded no gap at all, leaving one last readiness-clean →
  export-500 path. One unconditional attribution closes both. It also collapsed the *third* copy of `documentNumber` before it was written —
  `invoiceDocumentNumber` now lives in the client-safe `invoice-constants.ts`, and `statements.ts`'s
  copy (which carried a comment admitting it was a duplicate) is gone.

**Three of those seven were RULED by the owner 2026-08-17, before round 2's Group A branch opened.**
**#61 — the manual override WINS, silently.** Recalculate suppresses the overridden operation's
regenerated twin (matched on `orderLineId` + `processStepCodeId`) and keeps the typed amount; the
tax base follows the override, not the computed figure. **No new revert control** — the undo path
already exists and is now a tested contract: remove the row, save, Recalculate, and the computed
line returns. This ratifies what the grid already intended (`InvoiceDetail.tsx` stamps an
amount-edit `MANUAL` *specifically* so Recalculate will not discard it); the alternative — recalc
reverts every override — was rejected because an operator recalculating for an unrelated reason
would silently lose an edit they made deliberately. **#62 — the GL account is defaulted
SERVER-SIDE**, to the configured `otherChargeGlAccountId`, the same account `mapComputedLines`
already assigns to engine-generated charges; the grid keeps rendering it read-only, now showing a
real account. **No operator-facing GL picker**: the existing list route (`/api/admin/reference/
glAccount`) is gated on `admin.view`, which an invoicing clerk must not hold, so a selector would
have meant a new gated route to buy a split nobody has asked for — and ruling 15 (§5.15) already
excludes `glAccount` from the open pick-list route on purpose. Revisit only if the accountant's
Q-list comes back wanting charges split across accounts. **#63 — a $0 invoice is LEGITIMATE paper**
(warranty, rework, no-charge), so the guard blocks the **empty line set**, not a zero total, and it
blocks at **finalize** — a draft may be transiently emptied while the operator rebuilds it. That
is exactly the integrity hole as filed: zero lines make finalize's `needsPrice` check vacuous, and
the order lands INVOICED at $0 where it can never be re-billed.

**Owner decision 2026-08-17 on the GL account numbers in git history: LEAVE THEM.** They were
committed to this **public** repo in `b56aa0f` (my error, PR #129) directly beneath the rule in §7
forbidding it, and stripped from the working file in `87e057b`. Account numbers carrying no
balances and no customer names are low-value to an outsider, and a history rewrite would invalidate
every SHA from `b56aa0f` forward. **The §7 rule stands unchanged** — never quote an account number
into a commit, PR body or issue; this ruling forgives one past leak, it does not relax the rule.

**Done at Phase 2A start (from the final review — "Task 0" items; see §4):** auth-context refactor (one session resolution per request), `HttpError` extracted to `src/server/errors.ts`, Prisma error-hygiene helper (P2002/P2025/P2003), settings audit values redacted, dotenv promo line silenced.

**Deferred (fine to ride along):** health-route DB-down path; roles page deselect papercut; users page error banner doesn't clear on success; updateUser password truthy-check inconsistency; Shell loading indicator; settings page empty-blur cosmetic; searchAudit filter route tests; HistoryPanel changedFields unit test; session-row cleanup job (**sharpened 2026-08-02 by the PR #22 Codex review**: `getSessionUser` (`sessions.ts:28`) rejects an expired session but never deletes it, and nothing anywhere else reaps one, so `Session` grows a row per login for the life of the deployment — the dev DB held 144 rows for `admin` alone, 77 already expired. The E2E harness's own four-rows-per-run leak is closed on the 2C-3 branch, which is what made this visible; the general case is untouched. Open decision when it is picked up: a nightly `DELETE FROM "Session" WHERE "expiresAt" < now()` in the backup container that already runs in the prod profile, vs. an opportunistic delete inside `getSessionUser` — the latter adds a write to the hot path, so it is a real trade-off, not an obvious win); login rate limiting; backup alerting + backup-now button; SESSION_SECRET consumed by nothing yet; ~~`renameRole` to a soft-deleted role's name → 500 edge~~ (**closed by the Prisma 7 work** — `Role.name` is now unique only among live rows, so a soft-deleted role's name no longer occupies the constraint and renaming onto it just creates/renames cleanly; see §5.18).

**Carried out of Phase 2A** (triaged by its final whole-branch review; the execution ledger they came from is gone, so this is the surviving record):

- **Owner-ruled, build in 2C:** reference columns holding a foreign key (`inspectionCode.defaultScaleId`, `paymentType.glAccountId`) render, export, and accept a **raw cuid**, so paste is unusable for those two kinds. 2C owes name resolution on read and name-accepting create/paste — built as the general mechanism customers and parts reuse. Detail in the Phase 2 kickoff brief, open item 4.
- ~~**Any model with `@unique` + soft delete needs revival-on-create.** `roles`, the ten reference kinds, and process step codes all have it now; it was missed twice and ruled Critical both times. Customers and parts have far more unique columns; the rule is written into the Phase 2 kickoff brief §2.6 and applied to `Customer.code`.~~ **Superseded by the Prisma 7 work (§5.18) — the opposite is now true.** A model with a unique column plus soft delete gets a partial unique index (`where: raw("\"deletedAt\" IS NULL")`), not revival-on-create; revival-on-create was deleted everywhere it existed, including `Customer.code`. **Parts (2C) must not add a revival site** — give any new unique column the partial-unique treatment instead. See §5.11.
- **The sweeps do not assert that *services* route mutations through the audit helpers.** `tests/permissions-sweep.test.ts` covers routes calling `requireUser`, admin routes gating on a permission, the client/server boundary, and `audit.ts` as sole audit writer — but a 2B service calling `prisma.customer.update` directly would pass. Most likely invariant for a new author to break.
- **Smaller, none blocking:** ~~revival keeps stale extra columns from the deleted row~~ (**moot — closed by the Prisma 7 work.** There is no revival left to leave anything stale; a re-used name is a new row. See §5.11, §5.18.); soft-deleting a GL account leaves step codes pointing at it with no `needsGlAccount` warning (matters for Phase 5's QBO export — **now ruled: §5.14 blocks the delete instead, and 2C builds that guard for every reference kind at once**); `parseTsv` is now only used by its own tests and its documented truncate semantics are the bug `pasteReference` was fixed to reject; `FIELD` in `process-step-codes.ts` is the one schema without `.strict()` and the step-codes page depends on that; `withDbErrors`/`auditedUpdate` nesting is inverted between create and update; ~~a second DELETE re-stamps `deletedAt` and writes another audit row~~ (**fixed for every entity in round 7** — `auditedSoftDelete` now claims the row with a conditional `updateMany` guarded on `deletedAt: null` and writes the audit entry only if it won, so a repeat or a concurrent double-click gets a 404 instead of a second deletion of the same row); creating a name that matches a hidden inactive row says "already exists" with no hint it is inactive; the step-codes page has no delete, active toggle, or `HistoryPanel` though the API supports all three; five test files still carry duplicated login boilerplate instead of `signInWith`.

**Carried out of Phase 2B** (triaged by its final whole-branch review; the execution ledger is gone, so this is the surviving record):

- ~~**Make revival-on-create ONE shared helper before 2C adds a fifth site.** This rule — a revived row must be indistinguishable from a fresh create — has now been got wrong in four places across two phases, and always where it was *reimplemented* rather than shared: `roles.ts` had it right, `customers.ts` missed its scalars then its children, `reference.ts` missed its extra columns, `process-step-codes.ts` missed both scalars and its `fields` children. All are fixed; the pattern is the risk. Parts and their inspection/pricing children are the next site.~~ (**moot — closed by the Prisma 7 work.** There is no revival left to share: unique columns on soft-deletable models are now unique only among live rows, so a re-used code/name is simply a new row with its own id and audit history. See §5.11, §5.18.)
- ~~**The audit layer's transaction gap is only half closed.**~~ **CLOSED by 2C-2 (PR #13):** the `tx` parameter on all three `audited*` helpers is now **required**, and every call site was converted to the canonical nesting (`withDbErrors` → `$transaction` → `audited*` → writes on `tx`) — the compiler, not a sweep, is the enforcement. One known pre-existing inversion survives untouched in `updateAddress` (tx→withDbErrors→auditedUpdate order) — cosmetic-structural, codebase-sweep candidate.
- ~~**The reference-delete guard's TOCTOU is open…**~~ **CLOSED by 2C-2 (PR #13):** `assertRefExists(kind, id, tx)` (`src/server/reference-guards.ts`) runs inside each FK writer's own **Serializable** transaction — all four pre-existing writers plus parts' four — forming the read-write cycle SSI needs against `deleteReference`'s Serializable scan. Serializable is scoped to writes that actually assign a non-null registered FK. The same treatment covers `deleteCustomer` vs `createPart` and `deletePart`'s cascade vs the child-add paths (Codex round-1 findings). Assigning a soft-deleted target **by raw id** — previously silently accepted — now 400s.
- **Export/paste round-trip is broken by design and must be fixed as a contract, not a patch.** Export emits more columns than paste accepts, so export → edit in Excel → paste back fails "Too many columns". The mismatch now spans **three** entities (2A reference tables, customers, and parts — where the asymmetry is TWO columns: `Customer name` and `Active`). **Fixing it naively makes a currently-masked bug reachable:** paste has no header-row detection, so a pasted header row would silently create a customer coded `Code` named `Name`. Fix everywhere together or nowhere; parts needs column-shape handling, not just header detection.
- ~~**Three sibling services spell "name" three ways**~~ **Rule settled in the 2C-2 spec (§4) and applied to all part entities:** required identifiers use `.trim().min(1)`; optional display text uses `.max(n)` with no minimum, defaulting `""`. The pre-existing blank-address-name-wins-the-default quirk remains (addresses untouched); revisit only if it bites.
- **Tests assert audit *actions*, not audit *content*.** That shape is exactly why a stale-diff bug (every address update writing identical before/after) survived every per-task review until the final one. New entities should assert a real diff.
- **Reference pick-lists are gated on `admin.view`, but data-entry screens need to read them.** Surfaced by the Phase 2B code review: the customer detail page's Terms select fetches `/api/admin/reference/terms`, so a user holding only `customers.*` sees an empty dropdown (it fails soft — the page works). Not reachable today because the owner is an admin, but **2C makes it four times worse**: parts need material, specification, inspection-code and inspection-scale pick-lists on the same screen. **Ruled 2026-07-31 — see §5.15; 2C builds the route.**
- **Smaller, none blocking:** ~~child routes parse `[id]` and discard it~~ (**CLOSED by 2C-2** — address/contact services take the customer id and scope both reads and the atomic claim-live writes; parts children were born scoped); ~~renaming onto a *soft-deleted* unique value 400s "already exists" for an invisible row, in both `customers.ts` and `reference.ts` — the create path solves this, the update path never got it~~ (**closed by the Prisma 7 work** — the same partial-unique fix that removed revival-on-create means a soft-deleted row no longer occupies the constraint, for create or update; see §5.18); `assertNoCycle` does not filter `deletedAt`, so a parent can be set to a soft-deleted customer; no `@@index([parentId])`; the address default-normalizer is invoked manually per call site rather than enforced; `HistoryPanel` on the customer page covers only the customer, so address/contact audit rows are reachable only via the admin log; no pagination on the customer list; no search debounce; `onDelete: Cascade` on the child tables is a latent trap in a soft-delete-only system.

**Carried out of Phase 4 (2026-08-05) — triaged, not fixed.** The complete per-task deferred-minors
lists live in `.superpowers/sdd/progress.md` (each task's entry names its own); they are the
whole-branch review's triage input. The ones worth naming here because they span tasks or surfaced
after the per-task reviews closed:

- **The notes-pair optimistic-PATCH clobber is a THREE-page sibling group** — a save of one field
  in flight can reset text typed into its sibling field, byte-for-byte the same code on
  `CertDetail`, `ShipmentDetail`, and the customers page (reproduced live during Task 16's
  verification). Fix-wave candidate: fix all three together, never one.
- ~~**The shipment page's cert-print info line points at the wrong list**~~ (**FIXED in the PR #47
  round-2 triage, 2026-08-06** — the print bar now renders direct `/api/documents/<id>` links from
  `x-cert-document-ids`; Codex independently re-found this Task 20 observation as a P2.)
- **The order hub's Documents list renders non-traveler kinds by raw enum name** ("SHIPPER",
  "BOL", "CERT") — its `KIND_LABELS` map only ever learned `TRAVELER`; the shipping and cert
  pages' own lists have friendly labels (cosmetic, observed in Task 20's flows).
- **Serials prefill over-includes on repeat shipments** (no per-serial shipped fact exists —
  owner ping #2 in §7 item 5), and `OrderDetail.orderLineShippedToDate` rides unused in the edit page's
  catalog payload (dead weight; trim or keep at the whole-branch review).
- Assorted per-task §5.16 title gaps on state-disabled buttons and a missing 404/401 case on two
  document/print routes — all enumerated in the ledger under their tasks.

**Backlog burn-down (2026-08-06, branch `backlog-burndown`, post-merge):** closed #48 (shipping
worklist links — the shipping.view-only dead end), #49 (signature magic-byte sniff; test fixtures
upgraded to real image bytes), #50+#54 (one `shipmentWarnings` recompute feeds the idempotent
replay AND every edit response via `shipperResponse` — the full §5.7 surface, not over-ship
alone), #53 (scope-matched missing-cert warnings), #55 (ruling 27: multi-part certs head each
line group with frozen part identity; single-part stays §3.21-sample-identical), and #56 (ruling
28: `addLine` seeds the rider's requirements into every live cert, audited per cert, typed
readings untouched). Its Codex round (three findings, all in the PR's own new code, all fixed):
grouping keys use the FULL frozen identity — `removeLine` frees positions a later rider re-uses,
so `linePosition` alone could misattribute readings on permanent paper (PDF, data build, and the
cert page swept together); ruling 27's multi-part detection reads the PARTS TABLE, not the
requirement rows (a cert listing two parts with one inspected still heads its grid); and a
RELEASED serial selection keeps satisfying its line's serialization warning via a new
`ShipperSerial.orderLineIdAtSave` plain-snapshot column (migration `20260806164109`, backfilled —
pre-existing released rows keep "" and simply don't credit a line). A follow-up finding closed
the identity question for good: requirement grouping keys on `CertRequirement.orderLineIdAtSeed`
— a plain copy of the seeding line's cuid, which unlike positions and display fields is NEVER
reused (migration `20260806173702`; pre-backfill released rows fall back to the
composite). Gates: **1406 tests**, `tsc`/`eslint`/`build` clean, E2E 15/15. 25 migrations
total.

**Deferred from the PR #47 Codex triage (2026-08-06), issues #48–#51** — all verified real, none
data-integrity: #48 shipping worklist rows don't link to `/shipping/<id>`; #49 signature upload
trusts the declared MIME, so corrupt bytes break that user's cert prints until the signature is
cleared (the cert=1 route now survives it with a warning, which is also the regression test's
failure injection); #50 the idempotent shipment-create replay returns `warnings: []`, dropping
creation-only warnings exactly in the lost-response case the nonce exists for; #51 the new-shipment
page's add-order response can land after a customer switch and append the old customer's order
(server rejects the cross-customer save — UI dead-end only).

**Toolchain upgrades blocked on what `eslint-config-next` vendors (2026-08-02).** Next 16 landed, and neither of the two remaining Dependabot majors can follow it yet. Both are blocked by packages bundled *inside* `eslint-config-next@16.2.12`, not by anything in this codebase:

- **ESLint 10 (#19).** Not the peer range — `eslint-config-next@16` peers `eslint: ">=9.0.0"`, which would allow it. The blocker is `eslint-plugin-react@7.37.5` vendored inside it, which peers up to `^9.7` and calls a rule-context API ESLint 10 removed: `TypeError: contextOrFilename.getFilename is not a function`.
- **TypeScript 7 (#21).** `typescript-eslint@8.65.0` — also vendored inside `eslint-config-next` — throws `Error: typescript-eslint does not support TS 7.0` outright. No override fixes it: every released `typescript-eslint` (latest 8.65.0) still peers `typescript: ">=4.8.4 <6.1.0"`.

**TypeScript 7 is otherwise ready, and this was measured, not guessed.** On a branch off Next 16: `tsc --noEmit` is **clean with zero errors**, the 585 tests pass, and `next build` compiles. The `TS2882` failure on `./globals.css` that killed the original Dependabot attempt was a Next 15 type-resolution problem and is gone under Next 16. `tsc --noEmit` also drops to **~0.3s** — TS 7 is the native port. Only the lint gate blocks it, and dropping `next/typescript` to dodge that would trade away TS-aware linting on a TypeScript codebase, which is the wrong side of the trade.

**When to retry:** watch `eslint-config-next` for a release that bumps its bundled `eslint-plugin-react` (unblocks #19) and `typescript-eslint` (unblocks #21). Both retries are cheap — install, run the four gates.

**Phase 2+ deliverables promised by spec but not yet scheduled:** HTTPS on LAN + `Secure` cookie flag (reverse proxy); practice database mode (Phase 8); backup-now button + configurable folder (Phase 8).

### 6a. Postgres 18 — what the upgrade actually required (2026-08-02)

`postgres:16` → `postgres:18`, done as dump-and-restore because Postgres refuses to start on a data directory from an older major.

**The image also moved its data directory, and this is the part that bites.** Postgres 18+ official images store data in a major-version-specific subdirectory (`18/docker/`) so `pg_upgrade --link` can run without crossing a mount boundary — and they **refuse to start if they find a mount at the old `/var/lib/postgresql/data`, even an empty one**. `docker-compose.yml`'s db volume is therefore mounted at `/var/lib/postgresql`, one level up, with a comment saying why. Changing only the image tag produces a container that restarts forever with a wall of text about `pg_ctlcluster`. See docker-library/postgres#1259.

**Upgrading a real deployment** takes the same shape as the dev upgrade did, and cannot be done by editing the tag:

```bash
# 1. dump with the NEWER pg_dump (18 against a 16 server is the supported direction)
docker run --rm --network host -e PGPASSWORD=… postgres:18 \
  pg_dump -h 127.0.0.1 -U erp -d erp --format=custom --no-owner --no-privileges > erp.dump
# 2. docker compose down -v          (destroys the 16 volume — dump first, verify, THEN this)
# 3. bump both `image: postgres:` lines and move the db volume mount to /var/lib/postgresql
# 4. docker compose up -d --wait db  (db-init recreates erp_test on the fresh cluster)
# 5. pg_restore --exit-on-error, then diff exact row counts against the pre-upgrade capture
```

The dev upgrade was verified by exact per-table row counts before and after (identical across both databases), `prisma migrate status` clean on both, 585 tests and 6/6 E2E flows green. The pre-upgrade dumps and count captures are in `~/heatsynq-pg16-preupgrade-2026-08-02/`.

`scripts/backup.sh` needed no change — it calls `pg_dump "$DATABASE_URL"` with no version-specific flags — but the backup service's own `image:` must stay in step with the db service's, since its `pg_dump` has to be at least the server's version.

## 7. The owner still owes (spec §14 — chase these, none block Phase 2)

1. ~~**Samples of the current printed shipper, cert, and invoice**~~ — **CLOSED 2026-08-04.** The
   owner delivered all four during the Phase 4 design session: `docs/samples/Shipping Ticket
   Sample.pdf`, `Bill of Lading Sample.pdf`, `Certification Sample.pdf` and `Invoice Sample.pdf`
   (the last is Phase 5's). They are real filled-in documents for orders `72036-3` and `72026`, not
   mockups, and they **overturned four of the Phase 4 design's own decisions before a line of code
   was written** — see that spec's §3.19–§3.22. The traveler sample was closed earlier, 2026-08-03,
   by the ruling that the 2025 mockup is its build target (spec §3.9).
2. QuickBooks finance-charge treatment — settle with the bookkeeper (Visual Shop excludes FC from GL export entirely). **This and item 4 are now the CRITICAL PATH to the acceptance month (spec §13); nothing in code gates it any more.** **#91 is ruled AND built** (netted to a single signed column, `0b5ea81`) — but confirm the import method against it at the same conversation, since netting was decided without waiting on the bookkeeper.

   **⚠️ 2026-08-17 — the import route is NOT what this project has assumed, and the product may not be either.** The owner supplied Intuit's *Import from Excel and CSV* toolkit (`docs/company-confidential/quickbooks-csv-toolkit/`, gitignored — Intuit's own docs, but kept beside the other owner material). Two facts out of it:
   - **Excel/CSV import cannot carry TRANSACTIONS.** The manual, page 1: it *"can only import lists. Transactions cannot be imported using this method."* The three routes are **IIF** (transactions + lists, tab-delimited), the **SDK** (transactions + lists, XML), and **Excel/CSV** (lists only). Our GL export is a journal entry — a transaction — so "hand them a CSV and they import it" is not an available answer. What remains: IIF, a connector/add-on, or **keying one journal entry a month by hand from the posting register** (entirely viable at one entry a month, and it needs nothing built).
   - **The toolkit is QuickBooks DESKTOP documentation** (`File → Utilities → Import → Excel Files`, Pro/Premier 2008 / Enterprise 8.0, dated 2008-09-30), while every note in this project — the spec included — says **Online**. IIF is Desktop-only, so the two products give completely different answers. **Settle Desktop vs Online before anything else in this item**; if it is Desktop, the "QBO" wording throughout the docs needs correcting, not just the plan.

   Nothing is built against either assumption yet, so this cost nothing — but it is exactly the kind of thing the prime directive exists for. The full question list for that conversation is `docs/company-confidential/2026-08-17-accounting-questions.md` (22 questions, each paired with what the software does today).
3. ~~The office's go-to report list.~~ **Effectively CLOSED by Phase 8A** — the five native reports + the two homed ones were built to the owner's list; extras are cheap additions now the platform exists.
4. GL account list for operations, surcharges, payment types. **PARTIALLY DELIVERED 2026-08-16** —
   the owner supplied Visual Shop's own *General Ledger Report* (process code → GL#, 3 pages).
   **NOT IN GIT — the repository is PUBLIC and this is the company's chart of accounts.** It lives at
   `docs/company-confidential/2026-08-16-visual-shop-gl-numbers.pdf`, a directory gitignored under
   the same 2026-08-07 ruling as the VS screen capture. Never quote an account number into a commit,
   a PR body, or an issue. Owner's note: "not all of them are used anymore", and no rush — nothing
   was built against it.

   **Fifteen distinct accounts appear** — twelve revenue, plus one each for the energy surcharge,
   freight and trucking. **The numbers themselves are deliberately NOT repeated here** (see the
   2026-08-17 correction below); they are in the confidential PDF and in
   `docs/company-confidential/2026-08-17-accounting-questions.md`. Some rows carry no GL# at all and
   three carry a literal `%` — consistent with the retired-codes caveat, and harmless here since a
   step code's account is optional (2026-07-30).

   > **⚠️ Correction, 2026-08-17.** An earlier revision of this item — landed in `b56aa0f` (PR #129)
   > — quoted the actual account numbers and their furnace-group mapping in full, directly beneath
   > the rule forbidding exactly that, in a file committed to a **public** repository. The numbers are
   > removed from the working file as of `1b6c26d`+. **Git history still contains them** (they are in
   > the PR #129 diff and in every clone taken since), so this is containment, not a scrub — a true
   > removal needs a history rewrite and force-push, which is the owner's call and was not taken
   > unilaterally. Exposure is bare internal account numbers and furnace names: no customer data, no
   > dollar figures, no credentials. **The rule stands and now has a worked example of how it gets
   > broken — by an analysis paragraph that felt like reasoning rather than like data.**

   **⚠️ TWO FINDINGS THAT NEED THE OWNER BEFORE THIS CAN BE KEYED IN:**

   1. ~~**VS keys the revenue account by EQUIPMENT GROUP**~~ — **ANSWERED 2026-08-16** by two more
      owner-supplied exports (same confidential directory): `…-visual-shop-process-codes.pdf` and
      `…-visual-shop-equipment.pdf`. The account is on **neither** table. The Process Code table has
      **no GL column at all**; the Equipment table HAS a `G/L #` column (plus `Addon1 GL`/`Addon4
      GL`) and **every row is blank**. The owner's Order Entry chart shows `Standard Steps → Table
      Keys → Process Code · Equipment · Group · Cost Center`, and the GL report's columns are
      exactly `GL# · Process Code · Eq Id · Gr Id · Cc Id` with `Eq Id` = 0 on all but two rows. So
      VS hangs the account on the **Standard Step**, keyed effectively on **(Process Code × Group)**
      — Group being the furnace type, which is why one atmosphere-anneal process code appears under
      three different revenue accounts (the IQ, Bell and Rotary ones).

      **What that means here, and it is a business choice, not a technical block** (owner: "they may
      have multiple ways of doing depending on how the shop chooses"). HeatSynQ hangs one
      `glAccountId` off each `ProcessStepCode` and has no Group concept — deliberately, since shared
      process masters were removed and the recipe belongs to the part. So the split is reproduced
      purely by how the CODES are named: either one step code per (process × furnace group)
      — "Anneal in Atmosphere (Bell)" — which reproduces today's eight-account revenue split exactly
      and keeps the bookkeeper's reports unchanged (~80–120 active pairs, a spreadsheet-paste job),
      or one code per process with a single account, which is fewer codes and loses revenue-by-
      furnace. **The step code is what prints on the invoice line**, so either naming is honest
      paper. Owner's call; nothing is blocked on it.
      (Superseded framing kept below for the reasoning.)

      **VS keys the revenue account by EQUIPMENT GROUP, not by process code — HeatSynQ keys it by
      Process Step Code.** The report's `Gr Id` column is what separates the eight furnace-group
      revenue accounts (IQ, Vacuum, Tip Up, Bell, Temper, Car Bot, Rotary, Pusher — numbers in the
      confidential PDF, not here), and the SAME process code lands in several: the atmosphere-anneal
      code spans three of them, the atmosphere-normalize code four, and the air stress-relieve code
      three. Our model
      hangs ONE `glAccountId` off each `ProcessStepCode` (CLAUDE.md), so a single step code cannot
      reproduce that split. Either the step codes are defined per (process × equipment group) — which
      is how the shop already names them in practice, worth confirming — or the account has to be
      chosen somewhere else. **Do not key the chart in until this is settled**; guessing would
      mis-post revenue by furnace.
   2. **The balance-sheet side is not in this list, and CANNOT come from Visual Shop** (owner,
      2026-08-16: "not sure how to provide that, especially from the settings of Visual Shop" —
      correct, and expected). The QBO export's readiness gate needs `BillingConfig`'s A/R control,
      sales-tax, discount and write-off accounts plus a cash account per payment type; VS only ever
      knew the REVENUE side, which is exactly what its GL report shows. Those five-plus-N numbers
      live in **QuickBooks' own chart of accounts**, so they are a bookkeeper question, not a VS
      screen anyone is failing to find. Folds into §7 item 2's conversation.
5. **Four Phase 4 pings the owner has not ruled on yet** — kept here verbatim from the Phase 4
   record (`docs/history/2026-08-06-phase-4-certs-shipping.md`) so they stay in front of the next
   session; §9 carries them into the next PR:
   1. ~~The shipping ticket prints no **"Page N of M"**~~ — **IN PHASE 7 SCOPE (spec approved
      2026-08-12)**: the render runtime gains a renderer-side page-number primitive with
      per-sheet-group rendering (P7 spec §6.1), closing this for every document type.
   2. ~~**Serial re-shipment has no warning**~~ — **RULED 2026-08-16 (warn, do not block) and BUILT**
      (issue #125, `d4335c1`, burn-down Group C). A hard refusal would have needed a return/RMA
      concept that does not exist and could wedge a real shipment. The shipped fact is DERIVED from
      live `ShipperSerial` rows joined to non-voided shippers — no column added — keyed on
      **(order line, serial text)**, which survives `replaceSerials` deleting and recreating the
      `OrderSerial` rows (an `orderSerialId` key lost the prior shipment entirely and let the
      recreated serial ship again unwarned). Scoping to the LINE is what makes the serial text safe:
      a line belongs to one order, one customer, one part. The sentence says "**also appears on**",
      not "already shipped" — it compares against every other live shipment rather than only earlier
      ones, because packing-list order records document creation, not when a serial was selected
      during an edit, and the neutral wording is honest on BOTH documents (owner ruling
      2026-08-16, after three findings on PR #130). Ping closed.
   3. ~~The ticket's tear-off strip **overlaps the part table past ~8 extra multi-line part rows**~~ —
      **IN PHASE 7 SCOPE (spec approved 2026-08-12)**: the tear-off goes flow-based as ruling 3's
      column-widths guardrail (P7 spec §5.6).
   4. ~~**No `User.title` column exists**, so the cert signature block prints name + company with no
      title line (the sample shows one) — a small follow-up migration if the owner wants it.~~
      **CLOSED — built in Phase 6** (`e2c91e8`, ruling 14): `User.title` on the admin user form,
      printing on both the quote and cert signature blocks (blank title prints nothing).
6. **The shop logo file** (added 2026-08-12, Phase 7 spec §12 item 1) — **DEFERRED by the owner
   2026-08-16 to after the acceptance month.** **The artwork is now ON THIS MACHINE** (2026-08-17):
   five variants in `docs/company-confidential/logos/` (gitignored — the repo is public; the folder is
   `.gitignore:40` and each file was `check-ignore`-verified when saved). They were sent from a phone
   as chat images rather than as files, so they were recovered by decoding the base64 image blocks out
   of the session transcript; that is the only copy on disk, and it is **outside the repo's history by
   design** — a fresh clone will not have them.

   | file | shape | px | notes |
   |---|---|---|---|
   | `aht-logo-horizontal.png` | flame + wordmark | 1716×560 | **RGBA, transparent** — the document-header choice |
   | `aht-mark-flame.png` | flame alone | 591×802 | RGBA, transparent — tight slots, favicon |
   | `aht-wordmark.png` | wordmark alone | 581×273 | RGBA, transparent — likely unused |
   | `aht-logo-horizontal-white-bg.jpg` | flame + wordmark | 944×310 | opaque white box |
   | `aht-mark-flame-white-bg.jpg` | flame alone | 448×604 | opaque white box |

   **All five clear `LOGO_MAX_BYTES` with room** (512 KB, `templates.ts`; largest is the horizontal
   PNG at 218 KB), and all five are `image/png`/`image/jpeg`, so the existing upload path accepts them
   unchanged. Use the **PNGs** — the JPEGs are the same art flattened onto a white rectangle, which
   will show as a box over any coloured band. **There is no vector original among them**; the
   horizontal PNG is ample for a document header (~1700 px across a ~2 in header is >800 dpi), but if
   an SVG/EPS/AI exists wherever the logo was made, it is worth asking for it **before** the logo work
   starts rather than after. Cosmetic; the parallel run does not depend on it. The template logo slot
   stays unused until then, and Phase 7's "restyle the traveler with the real logo" outcome stays
   unexercised — the E2E flow uses a fixture image until it lands.

## 8. Fresh machine setup (Fedora)

```bash
# 1. Tooling
sudo dnf install -y git nodejs26 npm postgresql # or use nvm for node; Node 26 required (Dockerfile + CI pin it)
# `postgresql` is the CLIENT (pg_dump/psql), needed by the E2E `backups` flow (Phase 8C — it is the
# one place the real binary is exercised; vitest injects a fake) and by the restore runbook
# (`erp/README.md`). Its major must match the `postgres:` image tag (currently 18) — pg_dump refuses
# to dump a server newer than itself. Fedora 44's `postgresql` package is 18.4, matching today.
# Node 26 ships npm 12, which does NOT run dependency install scripts unless you approve them.
# `npm ci` prints a warning naming five: @prisma/engines, argon2, esbuild, prisma, unrs-resolver.
# That warning is EXPECTED and must not be "fixed" with `npm approve-scripts --all`. None of the
# five are needed: argon2 and esbuild ship prebuilt binaries (argon2's are N-API, so they are
# ABI-stable across Node majors), and Prisma 7 bundles its engines. Verified on Node 26.5.1 /
# npm 12.0.2 — all four gates plus `prisma migrate status` pass with every script skipped.
# Approving them would add supply-chain surface to buy nothing; skipping is npm's secure default.
# Docker Engine (compose v2 profiles are used; Docker CE recommended over podman):
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # then log out/in

# 2. Project
git clone https://github.com/CoJoA13/HeatSynQ.git && cd HeatSynQ/erp
cp .env.example .env
git config --global user.name "cojoa13"          # git REFUSES to commit without an identity, and it
git config --global user.email "cjones1308@pm.me" # fails when you have work to save, not at setup
docker compose up -d db   # a FRESH dbdata volume runs db-init/, creating erp_test AND erp_practice
npm install
npx prisma migrate deploy  # APPLY existing migrations to the dev DB (erp) — not `migrate dev`
npx prisma generate        # v7 no longer does this for you; client is gitignored
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm run db:seed
npm run dev     # http://localhost:3000 — admin/admin, change it

# 3. Prove it — the four gates (expect the §4 tally of the phase you are on)
npm test
npx tsc --noEmit
npx eslint src tests
npx playwright install chromium   # one-time; the E2E harness spawns its own dev server on :3100
npm run test:e2e                  # runs against the DEV db (erp), not erp_test
```

Use `migrate deploy` to **apply** migrations. `migrate dev` is only for **authoring** a new one, and since Prisma 7 it needs a TTY — it refuses in a non-interactive shell, so an agent session must use the `migrate diff` workflow in `CLAUDE.md` (the `create-migration` skill) instead. `db-init/` runs **only on a fresh `dbdata` volume**; a box that already ran the stack before `erp_practice` existed creates it once by hand with `docker compose exec db createdb -U erp erp_practice`.

Fedora-specific notes:
- **SELinux**: the compose file bind-mounts `./db-init`, `./scripts/backup.sh`, and `./backups` (on both `app` and `backup` — Phase 8C mounts it on `app` too, for its archive list and on-demand dump). If Postgres init or the backup container hits `permission denied`, append `:z` to those four bind mounts in `erp/docker-compose.yml` (named volume `dbdata` needs nothing). Prefer `:z` labels over disabling SELinux.
- **Podman**: if you use podman instead of Docker CE, you need `podman-docker` + a compose provider that supports `profiles` and `depends_on: condition: service_healthy`; Docker CE avoids the friction.
- **firewalld**: only relevant when exposing the prod app to the shop LAN (`sudo firewall-cmd --add-port=80/tcp --permanent && sudo firewall-cmd --reload`).
- Dev DB data from the old machine does not travel (it was throwaway seed/test data). If you ever need it: `erp/backups/` gzip dumps restore per `erp/README.md`.
- **Run `npm run test:e2e` in the BACKGROUND.** It now runs close to ten minutes, which is the agent tooling's per-command ceiling; a run killed at the cap leaves a `ClosePeriod` row that the harness deliberately does NOT self-heal (its reaper is id+`closedById`-scoped so it can never hard-delete a real close). The next run then fails three flows — `invoice-shipped-order`, `receivables-apply-age-statement`, `close-month-end` — because the month is closed, and clearing it needs a hand-written `DELETE` of the `ClosePeriod` + its `GlExportBatch`/`GlPosting` rows against the DEV db. Verified end to end on 2026-08-16.

## 9. Kicking off the next piece of work (paste this into a fresh session)

> **START HERE (owner, 2026-08-17): `docs/2026-08-17-backlog-round-2.md`** — round 1 is complete (14
> closed); this groups **all 66 remaining issues** and is the current track. **Task 0 and Group A are
> DONE (2026-08-17)** — Group A merged as `1c1fc77` (PR #133). **NEXT: Group B.** Task 0's detail: **#6**, **#10** and **#7** were re-verified against the code and closed with their
> evidence — all three described mechanisms that no longer exist — and the four missing triage labels
> (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`) now exist, so
> `--add-label ready-for-agent` works. **Group A (the invoice engine) is DONE the same day** — all
> eight of #61–#64, #59, #60, #89, #96 on branch `group-a-invoice-engine`, gates **3104 tests / 182
> files**, `tsc`/`eslint`/`build` clean, E2E 23/23 re-run every round; what the fixes actually did,
> where they exceeded the issues, and what THREE review rounds found, is in §6. **55 open. NEXT: B** —
> A/R that needs no accountant (#83, #85, #86, #82, #79, #75) · **C** shipping/status integrity (#65 is
> the real one) · **E** close + GL + tripwires (#88 is RULED — build the broken-chain flag) · **D**
> stale-load class (decide **#31** first) · **F**/**G**/**H** infra, documents, polish. **Ten issues are
> PARKED on the accounting meeting** (#69, #70, #73, #78, #80, #76, #77, #71, #4, #8) — do not start
> them; the question list is `docs/company-confidential/2026-08-17-accounting-questions.md`.
>
> Round 1's own record stays at `docs/2026-08-16-issue-burndown-handoff.md` — read its closing
> "outlives it" section before starting, especially lesson 4 (when each review round finds defects in
> the code written for the previous round, the design is the finding).

**Phase 8 (Reports & parallel-run tools) is DONE — all three sub-phases MERGED** (8A PR #106, 8B
PR #109, 8C PR #117 / `941ceab`, §4). **That completes every build phase in the 8-phase roadmap**
(`docs/superpowers/plans/2026-07-29-roadmap.md`) — there is no ninth phase, and nothing is in flight.
**The open work is now acceptance and backlog, not new build.** A fresh session should read CLAUDE.md
and §4, then pick among:

1. **The parallel-run acceptance month** (spec §13) — the headline remaining goal. Phase 5 unlocked it,
   Phase 8's comparison scoreboard delivered the weekly tooling, and 8C made the box trustworthy to
   leave running. Still gated on the owner-owed GL-account list and the bookkeeper's QBO import method
   (§7) before a *real* export month can start.
2. ~~**Issue #115 (P1)**~~ — **DONE 2026-08-16**, branch `fix-allocation-retry` (`fc7eb54`), with
   **#68** (`20ed463`) on the same branch as burn-down Group A. All **eight** allocating entry points
   (not six — `shippers.ts` had three) now wrap in `retryAllocation`. Detail, and the two corrections
   measurement made to the issue's own analysis, in §4.
3. **The six items ruled at the Phase 8 close-out (2026-08-16)** — all filed with build notes;
   **#68 is DONE** (Group A, `20ed463`): the `reopen` (POSTED→OPEN, refusing on a closed month,
   Serializable under the period lock; `voidBatch` gained the matching POSTED guard). The
   **#91, #125 and #126 are all DONE** — #91 in Group B (`0b5ea81`: the GL export nets to one signed
   column per `(account, side)`, decided WITHOUT waiting on the bookkeeper because a gross
   dual-column line risks importing 150 where 120 was meant), #125 and #126 in Group C
   (`d4335c1` / `de9ed88` / `c7fc4d3`: the re-shipped-serial warning, DERIVED from live
   `ShipperSerial` rows joined to non-voided shippers — no column added, keyed on **(order line,
   serial text)** so it survives `replaceSerials`, worded "also appears on" and symmetric across
   every other live shipment — and the order-line freeze, one guard mirroring `replaceCharges` read under the order
   claim, with the unlock → edit → re-finalize correction route tested end to end). The remaining
   two: **#123** disable the Backups page's own controls
   in practice mode while keeping the nav entry (`nav.ts` must NOT learn about practice mode — §8);
   **#124** refresh the shell staleness bar after a successful "Back up now". **All six are now BUILT**
   — #125/#126 in Group C (`fix-order-guards`), #123/#124 in Group D (`fix-backups-followups`).
4. **Backlog burn-down — COMPLETE (2026-08-16), 14 issues closed** (#68, #81, #84, #91,
   #115, #118–#126). Still open: Phase 6 follow-ups #95–#96/#99–#101; the Phase 7 deferrals
   #102/#103; **#132** (a retention failure is cleared by the next manual backup, which does no
   retention — filed from the Group D review, self-correcting within one night); the
   per-worker-test-DB infra task (§6). ~~owner question #68~~ is answered and built. Also worth an early look: the
   sibling-page stale-load sweep (the §5.13 class the Phase 7 quotes + templates-list fixes addressed
   on two pages — customers/parts/orders/certs detail pages likely share the hole).
5. ~~**A Phase 8 demo**~~ — **DONE 2026-08-16** (record in `docs/execution/2026-08-16-phase-8c-backup-polish/progress.md`).
   Walked 8A/8B/8C live: the day-one red staleness bar, a real `pg_dump` through "Back up now"
   (archive + status file + audit row all verified on disk), the practice banner on the login screen,
   and the PRACTICE/SAMPLE watermark on a printed traveler. Produced **#123** and **#124**, and the
   six rulings above. A demo of the *order-to-invoice* flow on the practice copy is still worth doing
   before the acceptance month — this one covered Phase 8's surface, not the daily workflow.

Whichever track is chosen: brainstorm → spec → plan → subagent-driven execution on a fresh branch,
per-task reviews, whole-branch review on the strongest model, one fix wave, PR with attribution in
the body. Standing rules that bind every phase: run `npm run test:e2e` on any UI/flow-touching
change and update the docs as part of the work; **a gate row is written after watching the run end,
or it says PENDING** (the Phase 6 Task 10 lesson); check `systemctl is-active docker` before
diagnosing ECONNREFUSED (this machine's Docker is disabled at boot); the operational traps this
project has hit are in the session-memory index (subagent E2E discipline, the `pgrep` self-match,
the killed-run close-period debris). The prime directive: do not assume — ask the owner.

Process that worked in Phase 1 and should be kept: brainstorm/clarify → spec → detailed plan → fresh subagent per task → independent spec+quality review per task → fix rounds until approved → final whole-branch review on the strongest model → one fix wave → merge. The per-task reviews caught real bugs the plan itself contained (plaintext password in audit payload, `__proto__` registry crash, blank-page login, resurrection with stale permissions, silent empty backups) — **the review loop is not optional ceremony**.

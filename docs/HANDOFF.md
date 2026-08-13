# HeatSynQ — Project Handoff

**Updated:** 2026-08-12 (later the same day) — **Phase 7 (Template designer) is IN FLIGHT: the owner chose it as the next track and approved its design spec** (`docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` — seven rulings in its §3, approved including the `pdf-lib` dependency; §15 amendments recorded). §4 carries the current-phase state; §9 is now the Phase 7 kickoff. Earlier the same day: **Phase 6 (Quoting) MERGED to `main` as `e2c91e8` (PR #94, squash, 2026-08-12).** Its full narrative moved to `docs/history/2026-08-12-phase-6-quoting.md`; §4 keeps the one-paragraph entry. Final Phase 6 gates: **2133 tests / 130 files**, `tsc`/`eslint`/`build` clean, E2E **19/19**; **32 migrations on `main`**. Deferred findings → issues **#95–#100**. **The Phase 6 demo ran 2026-08-12 and all 8 ratification items are RULED** (`docs/2026-08-12-phase-6-demo.md` — six as-built, two small follow-ups → #101 and a #100 addition). Earlier: **Phase 5C (Month-End Close & QuickBooks Online Summary Export) MERGED to `main` as `c069b09` (PR #92, 2026-08-10), completing roadmap Phase 5.** Its full narrative is in `docs/history/2026-08-10-phase-5c-close-qbo-export.md`; the deferred owner-homework and A/R backlog stay non-blocking. Earlier: Phase 5B merged `b55da3b` (PR #74, findings → #68–#87); Phase 5A `359c707` (PR #58, → #59–#65); Phase 4 `f129aae` (PR #47) with burn-down `8647a7d` (PR #57); Phase 3 `12a17f9` (PR #39). Open backlog: #51–#52, #59–#65, #68–#93, and now #95–#100, plus the older triaged issues (§6).

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

### The current phase

**Phase 5 (Invoicing & A/R + QBO) is COMPLETE** with the Phase 5C merge (`c069b09`, PR #92,
2026-08-10) — see the one-paragraph entry below and
`docs/history/2026-08-10-phase-5c-close-qbo-export.md` for the full record (the nine tasks, the
per-task and whole-branch reviews, owner rulings 8 & 9, the two Codex PR-review rounds, and the
lessons). Phase 5's completion unlocks parallel-run (roadmap: "Parallel-run capability begins after
Phase 5"; acceptance criterion spec §13 — one full closed month agreeing with the books).

**Phase 7 (Template designer) is IN FLIGHT — design spec approved by the owner 2026-08-12**
(`docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md`), chosen over Phase 8,
parallel-run prep, and the backlog burn-down (§9's four candidates). The design session took
**seven rulings** (the spec's §3): all eight document types at full §8 depth in one phase;
draft → publish versioning; all four format knobs (labels, number formats, date formats, column
widths); `Part.processName` fills the traveler's Process: slot and the invoice's create-time
snapshot; a curated bundled font set (no upload); fold-ins **#36, #43, #97, #98, #87** (#85 and
#52 stay in the backlog); division → parent → type-default assignment resolution. The spec was
adversarially reviewed on four lenses before approval (all APPROVE-WITH-FIXES, findings
incorporated — among them the never-published-template resolution hole, the honest
immutability-not-locking publish-vs-print argument, discard-as-status-flip instead of a
hard delete, config diffs kept in audit, and the `pdf-lib` dependency surfaced for explicit
sign-off — **approved**). Branch: `phase-7-template-designer` (created at plan approval). Next
step: the implementation plan, then subagent-driven execution with the record in
`docs/execution/2026-08-12-phase-7-template-designer/`, committed on the first task.

**Phase 6 (Quoting) is MERGED (`e2c91e8`, PR #94, 2026-08-12).** The full Phase 6 narrative — the
fourteen-ruling design session, the twelve tasks and their reviews, the whole-branch review's F1
story, the process incident and its rule, and the lessons — is
`docs/history/2026-08-12-phase-6-quoting.md`; the one-paragraph entry is below under "Merged, in
build order". **The Phase 6 demo ran 2026-08-12 — all 8 ratification items RULED**
(`docs/2026-08-12-phase-6-demo.md`: rulings 1–4/6–8 as-built; ruling 5 re-gates the part-page
quotes read to `quotes.view` → issue #101; ruling 8 adds the empty-Material suppression to #100);
deferred findings are issues **#95–#101**. The milestone alternatives Phase 5's completion opened —
parallel-run/acceptance-month prep, and the A/R backlog (#68–#93) — remain available after Phase 7;
the owner-owed GL-account list + bookkeeper QBO homework gate a *real* export.

Carried A/R follow-up (unchanged): issues **#68–#93** (§6) — **#81** (aggregate discount cap) and
**#84** (delete-customer-with-live-payment) are the P1s worth doing early, and **#68** now also carries
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

**Five issues are absorbed into Phase 7's scope by owner ruling 6 (2026-08-12, P7 spec §5.8):
#36 (traveler continuation-page header), #43 (bounded all-loads traveler render), #97
(`indicativeAmounts` length assert), #98 (`sourceQuoteNumber` `.refine`), #87 (safe
Content-Disposition filenames).** They stay open on GitHub until their fixes land on the Phase 7
branch; the entries below are unchanged as the record of what they are.

**Phase 6 (Quoting) follow-ups — GitHub issues #95–#100 (2026-08-12), all deferred by the
whole-branch triage rule, none correctness/concurrency/data-integrity.** #95 dangerous-direction
tests for the deletePart/deleteCustomer↔quote-writer SSI pairings (holes verified NOT live;
`Quote.customerId` immutability is the load-bearing untested dependency); #96 zero-net lead-line
corrupt-quote-link asymmetry (500 vs skip — throw is the safe direction); #97 `indicativeAmounts`
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
and **the two P1s: #81 (the discount cap is per-line, not aggregate — repeated lines can waive a
whole invoice) and #84 (`deleteCustomer` doesn't block a customer with live payments — strands the
cash)**. Full triage: `docs/execution/2026-08-08-phase-5b-accounts-receivable/progress.md`.

**Phase 5C (close + QBO export) follow-ups — GitHub issues #88–#93 (2026-08-10), all deferred, none
blocking the 5C merge.** #88 the continuity chain goes stale when a NON-latest month is reopened
(self-protecting — the forward close refuses on a nonzero variance and the export is event-based; the
re-chaining policy is spec-silent, owner's call). #89 a freight/charge line finalized before its GL
default reads clean in readiness but 500s the export (self-protecting via the Σdebit=Σcredit backstop;
the fix is an invoice-attributed readiness gap, but there is no invoice detail page to anchor its
fix-link). #90 the cosmetic follow-ups bundle. #91 whether the summary export should be netted (tied
to the bookkeeper's QBO import method, with ruling 7's correction-JE dating). #93 the GL-export
create-audit records batch metadata only, not the emitted journal (the postings ARE persisted
immutably on the batch, so it is completeness, not data loss). Plus the Codex re-raise of **#68**
(carried from 5B, now with the GL-export consequence): once a receipt batch is POSTED there is no path
to correct or reverse its cash — `refusePosted` fires before the period check, there is no un-post, and
no negative/compensating payment — so a posted payment can never reach a reversing QBO delta.
Pre-existing and self-protecting; the fix relaxes the documented "POSTED locks the payment list"
invariant, so it stays the owner's (a)/(b)/(c)/(d) decision. Full triage:
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

**OWNER DECISION OWED (filed 2026-08-07 by the Phase 5A whole-branch review) — should editing an
already-invoiced order's LINES freeze, the way its charges do?** Spec §5.7's freeze covers extra
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
the branch, none already fixed; none data-loss, but three are money/status defects.** The owner
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
2. QuickBooks Online finance-charge treatment — settle with the bookkeeper (Visual Shop excludes FC from GL export entirely).
3. The office's go-to report list.
4. GL account list for operations, surcharges, payment types. **No longer gates Phase 2** (2026-07-30) — the account is optional at operation entry, so masters can be keyed now; the list is needed before Phase 5's QBO export.
5. **Four Phase 4 pings the owner has not ruled on yet** — kept here verbatim from the Phase 4
   record (`docs/history/2026-08-06-phase-4-certs-shipping.md`) so they stay in front of the next
   session; §9 carries them into the next PR:
   1. ~~The shipping ticket prints no **"Page N of M"**~~ — **IN PHASE 7 SCOPE (spec approved
      2026-08-12)**: the render runtime gains a renderer-side page-number primitive with
      per-sheet-group rendering (P7 spec §6.1), closing this for every document type.
   2. **Serial re-shipment has no warning**: no per-serial shipped fact exists, so re-selecting an
      already-shipped serial on a later shipment gets no §5.7-class notice — worth an owner decision.
      **Deliberately NOT Phase 7 scope** (workflow/data-model, not template work — P7 spec §2) —
      still open.
   3. ~~The ticket's tear-off strip **overlaps the part table past ~8 extra multi-line part rows**~~ —
      **IN PHASE 7 SCOPE (spec approved 2026-08-12)**: the tear-off goes flow-based as ruling 3's
      column-widths guardrail (P7 spec §5.6).
   4. ~~**No `User.title` column exists**, so the cert signature block prints name + company with no
      title line (the sample shows one) — a small follow-up migration if the owner wants it.~~
      **CLOSED — built in Phase 6** (`e2c91e8`, ruling 14): `User.title` on the admin user form,
      printing on both the quote and cert signature blocks (blank title prints nothing).
6. **The shop logo file** (added 2026-08-12, Phase 7 spec §12 item 1) — Phase 7's testable outcome
   is "owner restyles the traveler/logo", so the real logo (PNG or JPEG) belongs in `docs/samples/`.
   Nothing blocks the build; the E2E flow uses a fixture logo until it lands.

## 8. Fresh machine setup (Fedora)

```bash
# 1. Tooling
sudo dnf install -y git nodejs26 npm            # or use nvm; Node 26 required (Dockerfile + CI pin it)
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
docker compose up -d db
npm install
npx prisma migrate dev
npx prisma generate    # v7's migrate dev no longer does this for you; client is gitignored
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm run db:seed
npm test        # expect 258 passing (Phase 1: 75; Phase 2A, 2B, and the Prisma 7 work added the rest)
npm run dev     # http://localhost:3000 — admin/admin, change it
```

`npx prisma migrate dev` needs a TTY and refuses in a non-interactive shell — see `CLAUDE.md`'s "Constraints that will bite you" if you're driving this from a script or an agent session rather than a human terminal.

Fedora-specific notes:
- **SELinux**: the compose file bind-mounts `./db-init`, `./scripts/backup.sh`, and `./backups`. If Postgres init or the backup container hits `permission denied`, append `:z` to those three bind mounts in `erp/docker-compose.yml` (named volume `dbdata` needs nothing). Prefer `:z` labels over disabling SELinux.
- **Podman**: if you use podman instead of Docker CE, you need `podman-docker` + a compose provider that supports `profiles` and `depends_on: condition: service_healthy`; Docker CE avoids the friction.
- **firewalld**: only relevant when exposing the prod app to the shop LAN (`sudo firewall-cmd --add-port=80/tcp --permanent && sudo firewall-cmd --reload`).
- Dev DB data from the old machine does not travel (it was throwaway seed/test data). If you ever need it: `erp/backups/` gzip dumps restore per `erp/README.md`.

## 9. Kicking off the next piece of work (paste this into a fresh session)

**Phase 7 (Template designer) is IN FLIGHT — the owner chose it 2026-08-12 and approved its design
spec the same day** (`docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md`,
approved including `pdf-lib`; seven rulings in its §3; §15 amendments recorded). A fresh session
should read CLAUDE.md, this file's §4, the Phase 7 spec, and the Phase 7 implementation plan
(`docs/superpowers/plans/`, dated 2026-08-12 — if it does not exist yet, writing it is the next
step; propose the four plan-time confirmations from the spec's §12 item 3 to the owner with it),
then continue subagent-driven execution on branch `phase-7-template-designer`: fresh subagent per
task → the repo's task-reviewer agent → fix rounds until approved → whole-branch review on the
strongest model → one fix wave → PR with attribution in the PR body. The execution record lives in
`docs/execution/2026-08-12-phase-7-template-designer/` and is **committed on the first task**.

Phase 7 absorbs issues **#36, #43, #97, #98, #87** (ruling 6 — close them from the branch as their
fixes land); #85 and #52 stay in the backlog. The owner owes the shop logo file (§7 item 6) —
nothing blocks on it.

Standing rules that bind every phase: run `npm run test:e2e` on any UI/flow-touching change and
update the docs as part of the work; **a gate row is written after watching the run end, or it
says PENDING** (the Phase 6 Task 10 lesson); check `systemctl is-active docker` before diagnosing
ECONNREFUSED (this machine's Docker is disabled at boot). The prime directive: do not assume — ask
the owner.

**After Phase 7**, the remaining tracks (none blocking): roadmap Phase 8 (reports & parallel-run
tools — spec §13's acceptance month needs the comparison page); parallel-run/acceptance-month prep
(needs the owner-owed GL-account list and the bookkeeper's QBO import method, §7); the backlog
burn-down (P1s #81 and #84, Phase 6 follow-ups #95–#96/#99–#101, the per-worker-test-DB infra
task in §6, owner question #68).

Process that worked in Phase 1 and should be kept: brainstorm/clarify → spec → detailed plan → fresh subagent per task → independent spec+quality review per task → fix rounds until approved → final whole-branch review on the strongest model → one fix wave → merge. The per-task reviews caught real bugs the plan itself contained (plaintext password in audit payload, `__proto__` registry crash, blank-page login, resurrection with stale permissions, silent empty backups) — **the review loop is not optional ceremony**.

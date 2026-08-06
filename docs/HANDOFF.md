# HeatSynQ — Project Handoff

**Updated:** 2026-08-05 — **Phase 4 (Certifications & Shipping) is COMPLETE on branch `phase-4-certs-shipping`** (all 21 tasks, both lanes folded in, gates green). What remains before merge is the finish sequence in §4a: the whole-branch review, one fix wave, and the PR. Phase 3 merged as `12a17f9` (PR #39).

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

**Phase 1 (Foundation) is complete, merged to `main`, and pushed.** Built task-by-task with independent review of every task plus a final whole-branch review (verdict: merge, after a 9-item fix wave — all applied and re-reviewed). Quality gates that must stay green forever: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`.

**Phase 2A (foundation refactors + reference data) is complete.** The five Task-0 refactors from §6's backlog all landed: `HttpError` extracted to `src/server/errors.ts` (import-free, breaking the `settings → http → sessions → settings` cycle, enforced by a test asserting zero imports), one session resolution per request (`handle()` publishes it via `AsyncLocalStorage`, `requireUser` just reads it), a Prisma error-hygiene helper (`src/server/db-errors.ts` — maps P2002→400, P2025→404, and P2003→400 with the FK's field name recovered from the constraint name, e.g. "That gl account does not exist" instead of a raw Prisma message), settings values now redacted through the same `redact()` audit uses, and dotenv's promo line silenced in test output.

Reference data ships with GL accounts, nine flat pick-lists (materials, inspection codes/scales, container types, carriers, terms, payment types, comment snippets, specifications), and Process Step Codes with configurable field definitions — each with Excel export and spreadsheet paste entry. (The tenth pick-list, `Salesperson`, was removed in Phase 2B — owner confirmed the shop assigns nobody.) The reference service (`src/server/reference.ts`) enforces `.strict()` zod schemas per kind (an unrecognized field 400s instead of being silently dropped). ~~Re-typing a soft-deleted name revives that row (active again) rather than 400ing on a duplicate the caller can no longer see.~~ **Superseded by the Prisma 7 work (§5.18):** each kind's `name` is now unique only among live rows, so re-typing a soft-deleted name creates a genuinely new row with its own id and history, not a revival.

**Phase 2B (customers) is complete.** Customers carry an owner-assigned unique `code` alongside the
name (Visual Shop's customer-id habit), an optional parent for divisions that bill together, the
Phase 5 commercial fields (credit limit/hold, COD, taxable, terms, surcharge opt-out, finance-charge
override), three standing note blocks, typed addresses with one default per kind, and contacts with
per-document flags. The unused `Salesperson` reference table was removed. The Excel-quote-aware TSV
parser moved to `src/server/tsv.ts` so customer paste reuses it rather than reimplementing it.

Also fixed in Phase 2A's close-out: zod's specific validation messages (e.g. "Too small: expected string to have >=1 characters") were silently flattening to the generic "Invalid input" under Next's bundler, even though the identical code produced the specific text under vitest — zod's locale registration is a side-effecting `config(en())` call in its own entry point, and zod's `package.json` declares `"sideEffects": false`, so webpack tree-shook that call (and the locale module it pulls in) out of the server bundle. Fixed by re-registering the locale in `src/server/error-message.ts`, the one shared translation both `handle()` and `paste.ts` call — see that file's comment for the full mechanism. Caught only by checking a real built/dev server's HTTP responses, not by vitest, which never reproduced the bug.

What Phase 1 delivers (all in `erp/`):
- **Auth**: username/password (argon2id), hashed session tokens, sliding expiry driven by a setting, timing-attack-resistant login (DUMMY_HASH equalizer in `src/server/auth.ts`), proxy cookie gate (`src/proxy.ts`; Next 16 renamed the middleware convention).
- **Permissions**: `src/server/permissions.ts` + `src/lib/permission-constants.ts` — 12 areas × view/create/edit/delete + 10 named special actions; resolution DENY override > GRANT override > role > deny. Roles and per-user overrides are owner-editable in Admin.
- **Audit**: `src/server/audit.ts` — `auditedCreate/auditedUpdate/auditedSoftDelete` with before/after snapshots (including relations via `SNAPSHOT_INCLUDE`), recursive redaction (password/token/secret/signatureImage), per-record `HistoryPanel`, searchable admin log. **Every mutation goes through these helpers**; `settings.ts`'s direct `prisma.auditLog.create` was a documented exception in Phase 1 but was retired in Phase 2A (Task 4) — `audit.ts` is now the sole writer, enforced by a sweep test (`tests/permissions-sweep.test.ts`) that fails if any other file calls `prisma.auditLog.create` again. Phase 3 added two more sanctioned exceptions: `order-drafts.ts` (pre-entity scratch, spec-authorized and sweep-allowlisted rather than routed through `audited*`) and `allocateNumber`'s counter bump in `settings.ts` (the consuming entity's own create entry is the audit trail).
- **Settings**: typed zod registry (`src/server/settings.ts`), 12 keys (company, numbering seeds, date defaults, session timeout), validated on read and write, audited, `Object.hasOwn`-guarded.
- **Admin pages**: Users (no hard delete ever; self-lockout guards: can't deactivate yourself or the last user-manager), Roles (permission grid; ~~revival of a soft-deleted name clears stale permissions~~ — **superseded by the Prisma 7 work (§5.18):** re-using a soft-deleted role's name now creates a genuinely new role, so there is no revived row and no stale permissions to clear), Settings, Audit log.
- **Shell**: permission-aware left nav (routes for future phases 404 until built), global search placeholder (wired in Phase 3), auth-refetch on navigation.
- **Packaging**: multi-stage Dockerfile (standalone Next build, auto-`migrate deploy` on start), compose profiles (dev `db` only / prod db+app+backup), `restart: unless-stopped`, Postgres bound to 127.0.0.1, nightly **fail-loud** backups (verifies pg_dump's exit status; never writes an empty archive) with 30-day retention.

Seeded credentials: `admin` / `admin` — **change immediately** on any real install.

### 4a. Phase 4 (Certifications & Shipping) — COMPLETE on `phase-4-certs-shipping`, PR open

**Finish sequence DONE (2026-08-06):** the whole-branch review ran on the strongest model (verdict:
merge with fixes — full text `.superpowers/sdd/whole-branch-review.md`), its one fix wave was
applied (five items) and the scoped re-review approved it **PR-ready** with zero new breakage.
Final gates: **1360 tests**, `tsc`/`eslint`/`build` clean, E2E 15/15. The review's headline catch:
the T6-era carry was a **latent defect, not a test gap** — the voided-state guards on Cert/Shipper
rested on SSI accidents, and print-vs-void had no protection at all; both discriminating race tests
were verified RED pre-fix. The fix locks the cert/shipper row itself after the order claims, and
`order-locks.ts`'s header now carries the resulting house rule: **the guarded state must live on,
or be locked with, the claimed row** (Phase 5's reversing-shipment work will need it again).

**Status (2026-08-05):** all 21 tasks — the 20 planned plus **14b**, a plan hole found
mid-execution — are implemented and individually reviewed on the combined branch. Gates at that
point: **1357 tests** (from 1010 at branch start), `tsc`, `eslint`, `npm run build` all clean, and the Playwright
harness is now **15 flows** (the ten inherited plus this phase's five, spec §13), run three times
consecutively to confirm stability. Both databases migrated (19 migrations; the three Phase 4 ones
hand-written via the TTY-less `migrate diff` recipe). Owner demo walkthrough:
`docs/2026-08-05-phase-4-demo.md`.

**What remains is the finish sequence the owner ruled on 2026-08-05** (revising the 2026-08-04
ruling's letter, keeping its intent — nothing reaches the PR unreviewed): the lanes are already
folded in, so next is **ONE whole-branch review of everything on the strongest model** (merge
resolutions and the E2E flows included), then one fix wave with scoped re-review, then the PR —
attribution in the **PR body**, never a commit trailer. The **deferred-minors list lives in
`.superpowers/sdd/progress.md`, per task**, and is the whole-branch reviewer's triage input; that
ledger is the authoritative record of what every review found, refuted, or deferred.

**Documents (binding, committed):** spec
`docs/superpowers/specs/2026-08-04-phase-4-certs-shipping-design.md` — §3's 18 owner rulings, the
four samples-driven amendments §3.19–§3.22, and the dated amendments added during execution (see
the rulings list below); plan `docs/superpowers/plans/2026-08-04-phase-4-certs-shipping.md`,
amended in place as reviews found things the plan itself had caused. **The owner's four production
samples are in `docs/samples/`** — the layout contract (§7 item 1 closed); they overturned four of
the design's own decisions before code was written.

**What Phase 4 delivered:**

- **Certs**: the required/scope resolution chain (part → customer → plant setting, frozen at order
  save, overridable at entry), all three scopes (order / load / shipment), one cert per order per
  scope-instance with a part block per line, requirements seeded and FROZEN from the part's
  inspections, many readings each with computed pass/fail plus a flagged, audited override — all
  screen-only: **the printed cert carries bare reading values, no min/max/scale/verdict (§3.21)**.
  Certs have **no number of their own** (§3.19; identified by order + scope instance), and
  `cert_number_next` sits in Settings deliberately unused.
- **Shipping**: shipments as documents — one global packing-list number, a per-order never-reused
  shipment sequence (the `-3` in `72036-3`), emergent multi-order shipments with one ship-to, the
  per-order-line ship ledger (`ship-ledger.ts`: shipped-to-date, remainder prefill, over-ship
  warns-and-never-blocks), status derivation from the human line-complete flags alone
  (`PARTIAL_SHIPPED`/`SHIPPED` now reachable), §5.5 invariant-based order-edit tightening, the
  **credit-hold gate with `override_credit_hold` + required reason-in-audit** (this phase's
  headline; human-reachable since 14b), idempotent creation (`clientRequestId`), and
  void-with-reason that locks every control, restores order statuses, keeps stored PDFs
  reprintable forever, and never frees a number or a sequence.
- **Documents**: `StoredDocument` widened to the one document table for traveler/ticket/BOL/cert
  with a hand-written kind→owner DB `CHECK`; shipping ticket (one per order, never an MOS sheet —
  §3.20), BOL (the multi-order document, its number allocated lazily at first print), and
  certification layouts built to the samples, every print stored byte-for-byte; the printing
  user's own signature (upload in Admin → Users) prints on the cert.
- **Screens**: shipping list, `/shipping/new` (14b — one atomic nested POST), the shipment page
  (per-order panels over the three shared grids), certifications worklist, cert detail
  (three-state pass/fail — passed/failed/pending, never inferred by subtraction), order-hub
  Certifications + Shipments sections, and the §3.22 fields built without a present-day user on
  the owner's explicit instruction (`Cust Cont Id`, `Customer Job No`).

**How it was built.** Tasks 1–12 sequential (the service chain), then the UI block ran as **two
parallel lanes** (owner-approved): lane A (the phase branch) took T13/T14/14b, lane B (branch
`phase-4-lane-b`, its own git worktree and its own `erp_test2` test database — isolation verified,
not assumed) took T15/T16/T17; T18/T19 (the PDF layouts) ran on the main lane. The lanes were
**folded in by true merge `89bd01c`** (zero textual conflicts; the three predicted semantic zones
hand-verified on both sides) plus wiring commit `7b171d5` (cert printing live on the cert page),
and T20 ran on the combined tree. A mid-phase **machine move** (2026-08-04) is why
`.superpowers/sdd/` is now tracked in git — the execution record travels; only the `review-*.diff`
packages stay ignored. The lane-b worktree and `erp_test2` are disposable local infrastructure;
the rebuild recipe is in `progress.md` under "SECOND LANE BUILT".

**Review record.** Every task went implementer → independent review → fix rounds → re-review.
**Five first-pass approvals by the ledger's own count** (T13, T16, T14b, T18, T17,
chronologically — all in the phase's second half, the loop visibly converging); most earlier
tasks took at least one fix round (T4 took two, T5 three — the ledger has each round's findings). **Task 14
is the exception worth knowing about**: it landed unreviewed when the machine move was called, its
implementer report was lost (a labeled controller-written stand-in exists in the ledger), and it
was reviewed retroactively on the new machine — its out-of-spec route was adjudicated a faithful
gap-fill (now a dated spec §9 amendment), its one Important (the add-grid prefill offered the full
ordered quantity instead of `ordered − shipped`) was fixed and re-reviewed, and its lost browser
verification was recaptured durably by T20's E2E flows. **Task 14b** exists because Task 14's
implementer found the plan had NO shipment-creation flow anywhere — `createShipper` and
`POST /api/shippers` existed with no screen calling either, leaving the credit-hold gate
unreachable by a human — and correctly refused to invent the screen unilaterally (prime directive).

**Owner rulings taken during execution** (each recorded as a dated spec amendment):

- 2026-08-04 — document lists are permission-filtered per kind (the `globalSearch` shape); a BOL
  belongs to exactly ONE shipment and does not exist until printed; §5.5: removing an order from a
  shipment is refused once its ticket has printed; §5.6: removing an order from a shipment voids
  that order's shipment-scoped cert at removal time; stay sequential through T12 and build the
  second lane for the UI block.
- 2026-08-05 — the four Task 19 rulings: a cert-requiring order with no live cert **prints its
  tickets and warns** (`x-print-warnings`), never refuses; BMP dropped from accepted signature
  image types; `certs.view` required for cert-bearing prints, ratified; LOAD scope prints all live
  load certs including the printedAt freeze. Plus the revised finish-sequence ruling above (fold
  in first, one review of the true final tree).

**Owner pings to carry into the PR / finish report** (accumulated in the ledger):

1. The shipping ticket prints no **"Page N of M"** — spec §10.1 lists it, but a pure-JSON template
   cannot carry page-count functions and a render-level footer would number across the multi-ticket
   PDF; Phase 7's template designer is the natural home.
2. **Serial re-shipment has no warning**: no per-serial shipped fact exists, so re-selecting an
   already-shipped serial on a later shipment gets no §5.7-class notice — worth an owner decision.
3. The ticket's tear-off strip **overlaps the part table past ~8 extra multi-line part rows**
   (absolutePosition; cosmetic-only failure; a flow-based fallback belongs to Phase 7 or a
   follow-up).
4. **No `User.title` column exists**, so the cert signature block prints name + company with no
   title line (the sample shows one) — a small follow-up migration if the owner wants it.

**Eleven lessons from this phase's reviews, all with real defects behind them.** These are the
ones worth carrying — the full per-task detail is in `progress.md`.

1. **A concurrency test that passes is not evidence.** Task 5's race test passed with the row lock
   it guarded **deleted** — both sides ran Serializable, so Postgres's SSI caught the anomaly and
   the lock never acted. The technique that works: run the **competing** caller at Read Committed,
   so only the row lock can serialise the two. Verify every such test by deleting the guard and
   watching it go red.
2. **Some concurrency properties cannot be tested at all at this layer, and that is now settled.**
   ABBA deadlock cannot be discriminated: the sorted claim is one `SELECT … ORDER BY id FOR UPDATE`
   with `LockRows` above `Sort`, so a correct implementation also holds A while blocking on B. Three
   tests carry that disclaimer **in their titles**. Do not spend rounds rediscovering it.
3. **Hoisted functions survive a module cycle; a `const` does not.** `shippers.ts` consumed
   `INT4_MAX` from `orders.ts` at module-evaluation time, and Task 10 was about to add the reverse
   edge — a crash at import, two tasks later, caused three tasks earlier. Two real cycles were found
   and broken this phase (`orders↔certs`, `cert-results↔certs`); the leaves are now `errors.ts`,
   `order-locks.ts` and `src/lib/order-constants.ts`.
4. **`import type` is erased and creates no runtime edge.** A naive cycle-detecting grep reports
   false positives; one implementer was misled by exactly that.
5. **`redact()` round-trips through `JSON.stringify`, which silently drops keys whose value is
   `undefined`.** Changing a zod field from `.default("")` to `.optional()` made an audit snapshot
   lose a key entirely. When you change a field's optionality, check every audit payload it reaches.
6. **The sibling-split rule keeps costing.** It bit three times this phase, worst when a fix for
   "queries dragging signature bytes" landed on one call site and missed `getSessionUser`, which
   runs on **every authenticated request**. When a fix lands on one member of a group, enumerate the
   whole group in the report so the sweep is checkable rather than asserted.
7. **A refusal must name what is actually blocking it.** One shipped naming a problem that did not
   exist ("a shipper with that shipper number already exists" for a duplicate line id).
8. **Half the findings in a fix round are in the code written for the previous round.** Task 4's
   Minor fix introduced an Important bug. Re-review every fix.
9. **Test fixtures quietly demonstrate forbidden states.** Task 9's own test built a one-order
   shipment and removed its only order — exercising a state the spec forbids, green, with no
   assertion against it.
10. **A lane's copies of shared documents are stale by design until fold-in.** Task 17's brief was
    extracted by line numbers from the LANE's plan copy (cut before 14b shifted the plan), yielding
    garbage; the implementer correctly blocked instead of improvising. Anything extracted by
    position from a document that exists on both branches must come from the branch where that
    document is current.
11. **The `/new`-route URL trap held for a second phase.** `page.waitForURL(/\/shipping\/[^/?]+$/)`
    also matches the literal `/shipping/new` still on screen at the instant Save is clicked — the
    Phase 3 `/orders/new` lesson, re-armed. The E2E flows wait for post-navigation-only content
    (the "Packing List N" badge), never a URL pattern.

**What to do next, in order** (the finish sequence, owner ruling 2026-08-05):
1. **Run the whole-branch review on the strongest model** over `586a569..HEAD` of
   `phase-4-certs-shipping` — everything: the merge resolutions from fold-in `89bd01c`, the E2E
   flows, and this task's docs. Feed it the per-task deferred-minors lists in
   `.superpowers/sdd/progress.md` for triage.
2. **One fix wave** from that review, with scoped re-review of the fixes.
3. **Open the PR** — attribution and the Claude-Session link go in the PR body (a hook blocks
   commit trailers). Carry the four owner pings above into the PR description so the owner rules
   on them with the merge in front of them.
4. **Present the demo** (`docs/2026-08-05-phase-4-demo.md`) before merge — the 2C-2/2C-3/Phase 3
   precedent.
5. After the squash-merge: verify the squashed tree is byte-identical to the branch tip, all four
   gates plus `npm run test:e2e` green on `main`, both databases migrated — then kick off Phase 5
   with the §9 prompt.

---

### 4a-prior. Phase 3 (Orders & Loads) MERGED to main — state as of 2026-08-03

**Phase 2C was split into three branches** (owner ruling, 2026-08-01) because as originally framed it was ~11 new models and ~30 tasks, roughly 3× Phase 2B: **2C-1 shared foundations** (done), **2C-2 Parts core** (next), **2C-3 Process Steps + Templates**.

**Phase 2C-1 is complete and MERGED to `main`.** Squash-merged 2026-08-01 as `47d6d0a` (PR #12, 31 commits); the `phase-2c1-foundations` branch is deleted on the remote. Verified after merge: the squashed tree is byte-identical to the branch tip, `main` is green on all four gates — **304 tests**, `tsc`, `eslint`, `npm run build` — and both databases report no pending migrations. **It changed no schema**, deliberately: `git diff` on `prisma/` against the pre-branch `main` was empty throughout.

It delivered the five obligations §4a previously listed as inherited by 2C, each as one shared implementation: the FK registry (`src/lib/reference-links.ts`) and its sweep, FK name resolution on read/export/create/paste, the reference-delete guard with blocker listing and Excel export, the session-only `/api/picklists/[kind]` route, the shared permission-gating helper (`src/lib/permission-ui.ts` + `use-permissions.ts`), and `deleteRole`'s required reason. Spec: `docs/superpowers/specs/2026-08-01-phase-2c1-shared-foundations-design.md`.

Codex posted five findings on PR #12; four were fixed on the branch. The fifth (the delete guard's TOCTOU) is **partially fixed and knowingly open** — see §6, which records exactly what the Serializable wrap does and does not close, and why the writer-side half is 2C-2's.

**Phase 2C-2 (Parts core) is complete and MERGED to `main`.** Squash-merged 2026-08-01 as `aeed372` (PR #13, 39 commits); the branch is deleted. Verified after merge: the squashed tree is byte-identical to the branch tip, `main` green on all four gates — **421 tests** — and both databases report no pending migrations. Spec: `docs/superpowers/specs/2026-08-01-phase-2c2-parts-core-design.md` (its §3 records four owner rulings from the design session; §11's count-only customer-delete bullet carries a dated amendment — the refusal now returns a full blocker list, owner ruling during PR review). Plan: `docs/superpowers/plans/2026-08-01-phase-2c2-parts-core.md`.

It delivered: the six part models (partial-unique `(customerId, partNumber)`, no revival anywhere) with services, routes, list/detail/admin pages, Excel export and paste; **both carried debt items closed** — the audited helpers' `tx` is now **required** (compiler-enforced transactional audit) and every registered-FK writer validates its target in-tx under scoped Serializable (`assertRefExists`), completing the reference-TOCTOU fix on both sides; parts' four registry entries with `CODE · partNumber` display via a generic `include`/`blockerId`/dedupe extension to `findBlockers`; customer child routes scoped to their customer; `deleteCustomer` blocked-with-discoverable-blockers while live parts exist; the shared stale-response gate (`use-latest.ts`) on both list pages; field-def delete **and type-change** blocked while non-empty values exist (blocker panel + export, shared `BlockerPanel` component). Codex posted three review rounds (16 findings): 14 fixed on the branch, 1 refuted with a regression test, 1 filed as issue #15 (per the 2B compound-race precedent). Issues #14 (UI papercuts from the browser walkthrough) and #15 are the new backlog entries.

**Phase 2C-3 (Process Steps + Templates) is complete and MERGED to `main`.** Squash-merged 2026-08-02 (PR #22, 49 commits, 67 files); **Phase 2C is now done end to end.** Verified before merge: all four gates green — **585 tests** (58 files), `tsc`, `eslint`, `npm run build` — plus the six-flow E2E harness 6/6, and both databases migrated. Spec: `docs/superpowers/specs/2026-08-01-phase-2c3-process-steps-design.md`. Owner-facing walkthrough with screenshots: `docs/2026-08-02-2c3-demo.md`.

It delivered the five process models, the revision-cut rule (§5), shop-built templates that load structure and never values, step-code deletion protection through the generalized `BlockerTarget` registry, the Process Steps designer on the part page, the Processes nav section, and the step-codes admin page's closed §6 backlog — plus `npm run test:e2e`, the first owner-reviewable Playwright harness in the project.

**Codex posted six review rounds — 37 findings, 36 fixed on the branch, 1 refuted with a reproduction.** Read this before the next phase, because three of the lessons are general:

- **Serializable on one side of a race buys nothing.** `workingRevision` read `lockedAt` and then wrote children, relying on its own Serializable transaction to order against `lockRevision` — but Postgres only guarantees serializability among transactions that are *all* Serializable, and `lockRevision`'s documented caller (Phase 3's order save) holds it inside the order's own default-isolation transaction. A locked revision could therefore be modified after its lock committed, breaking §5's central guarantee. Fixed with `SELECT … FOR UPDATE`, which both sides take at any isolation. **Phase 3 must not "fix" this by making the order save Serializable — the row lock is the guarantee, and it must stay.** A serialization failure from a raw query arrives as P2010 with the SQLSTATE inside the driver adapter's error, not P2034; `translatePrisma` now normalizes it.
- **A guard is only as good as what it actually discriminates.** The E2E fixture reaper hard-deleted rows in the developer's own database on a `startsWith("E2E")` scan, behind a guard that checked only the database *name* — which `docker-compose.yml`'s prod profile shares. Now exact-key, scoped to the fixture customer (a part's natural key is `(customerId, partNumber)`, not the number alone), and localhost-gated with no override.
- **Preserving unsaved UI work is a model problem, not a patch problem.** Draft preservation produced findings in three consecutive rounds — first not preserved, then not preserved across a revision cut, then preserving *clean* copies that masked another user's edit and let one click of Save revert it. The editors now keep only what the user actually typed, composed with server state at render time, which makes the staleness unrepresentable. **The same shape is worth reaching for first anywhere a page holds an editable copy of server data.**

**Two follow-ups were filed rather than fixed on the branch** (both pre-existing or UI-only, neither blocking): **#23** — the step-codes field-def blocker panel lacks the cross-row stale guard its code-delete sibling has, so a superseded blockers fetch can name a field from the previously selected code (same family as #5/#15; fix with the `use-latest` ticket idiom rather than a second bespoke guard). **#24** — `role.permissions` and `processStepCode.fields` have no `orderBy` in `SNAPSHOT_INCLUDE`, so two snapshots of identical state can render as a spurious diff in History; `partProcessRevision` was fixed in this branch and carries the reasoning. Worth a sweep test, since every future `SNAPSHOT_INCLUDE` collection has the same trap.

Two process observations worth carrying: roughly half the findings in rounds 4–6 were in code written to satisfy the previous round, so review of review-fixes converges slowly — 2C-3 stopped at round 6 by a stated rule (it had reviewed the last large change; anything later is triaged to backlog unless it is a correctness, concurrency, or data-integrity defect). And a parts/template **sibling split** — the same defect existing on two parallel screens or services, fixed on one and missed on the other — accounted for six separate findings. When a fix lands on one of a pair, check the other in the same commit.

**Owner rulings taken 2026-08-01 during 2C-2** (also in the spec §3 and PR #13): price-break basis follows the part's price-per unit; material optional on a part; unit/break prices store 4 decimals; field-def type changes blocked while values exist; customer-delete refusals carry a blocker list (amends spec §11); and **issue #4 is decided** — see the issues list above.

**The Prisma 7 upgrade and the removal of revival-on-create are complete and MERGED to `main`.** Squash-merged 2026-08-01 as `22e0dd3` (PR #11, 26 commits); the `prisma-7-upgrade` branch is deleted on the remote. Verified after merge: the squashed tree is byte-identical to the branch tip, and `main` was green on all four gates — 258 tests at that point, `tsc`, `eslint`, `npm run build`.

One Codex finding was posted against the PR and fixed before merge (`f6fd887`): `prisma/seed.ts` passed a possibly-unset `DATABASE_URL` straight to `PrismaPg`, which falls back to `PGHOST`/`PGUSER` rather than failing — so an unset variable would have seeded an admin account with a known password into whatever database happened to be reachable. `src/server/db.ts` already carried that guard; the seed now does too.

**Phase 2B (customers) is complete and MERGED to `main`.** Squash-merged 2026-08-01 as `32f7f9d`; PR #2 closed, the `phase-2b-customers` branch deleted on the remote. Verified after merge: the squashed tree is byte-identical to the branch tip, and `main` was green on all four gates — 255 tests at that point, `tsc`, `eslint`, `npm run build`.

Eight rounds of automated review ran against it. **All 40 threads were answered and resolved.** Thirty-three were fixed on the branch; seven were filed as issues; one was answered as already-recorded. The issues below are the surviving record — all are deliberate deferrals or owner decisions, none an oversight. **#6, #7, #8 and #10 are already decided; their rulings are §5.14–§5.18:**

- **#3** — a correction typed during a failing save can leave the UI stale. Database stays correct; needs a compound race; resolves on reload.
- **#4** — **DECIDED 2026-08-01 (owner): allow the combination.** Delivery flags mean "this is the invoices/certs person" even when delivery happens by mail or fax; rejecting a blank email would force fake addresses. **Phases 4–5 build obligation:** a flagged contact with no email is skipped **visibly** (named in the send result — "skipped: J. Smith (no email)"), never silently; plus a soft, non-blocking warning on the contact form whenever a delivery flag is on with a blank email. Entry stays unrestricted. Full ruling recorded on the issue, which stays open as the build obligation.
- **#5** — **CLOSED by 2C-2**: the shared stale-response gate (`src/lib/use-latest.ts`) guards both the customers and parts list loads, success and rejection paths alike.
- **#6** — **decided 2026-07-31; 2C builds it.** Reference-row deletion: block it, list the blockers, export the list. See §5.14.
- **#7** — **decided 2026-07-31; 2C builds it.** Controls the user lacks permission for are disabled and say why, never hidden. See §5.16.
- **#8** — **decided 2026-07-31; 2C builds the one remaining site.** A delete needs a reason when it cascades or frees a unique identifier — customer (built) and role (owed). See §5.17.
- **#9** — concurrent edits to *different* fields absorb each other into their audit diffs. Row ends up correct; the entries are too wide, not wrong. Proper fix needs `tx` threaded through all 17 `audited*` call sites — the half-closed transaction gap in §6.
- **#10** — **decided 2026-07-31; DONE 2026-08-01 on `prisma-7-upgrade`.** Reusing a deleted code inherited the predecessor's audit identity. See §5.18.

Round 4's fixes (`047eb51`): `assertTermsExists` closed the last unguarded reference column (a soft-deleted Terms row passed the foreign key and left a customer holding a reference no list resolves); the terms selector now carries inactive rows so an assigned one stops rendering as blank; address `kind` became editable (the service always supported it); and customer delete got a UI at last — the route and its `customers.delete` permission had shipped with nothing able to call them, which also made revival-on-create unreachable from the app.

**The Prisma 7 upgrade is DONE** (owner's ruling, issue #10 — the full record is §5.18). Built on branch `prisma-7-upgrade`: Prisma 6.19.3 → 7.9.1, revival-on-create deleted everywhere it existed (`customer`, `role`, all ten reference kinds, `processStepCode`), all four quality gates green on both databases (258 tests). **Not yet merged to `main`** as of this writing — merge it (or continue on the branch) before starting 2C, since 2C's obligations below assume the removal already happened and no longer carry a "consolidate revival" item.

**The toolchain was brought current on 2026-08-02, after 2C-3 merged.** Five PRs, all verified on all four gates plus the E2E suite before landing: patch bumps with security overrides taking `npm audit` from 5 advisories to 0 (#25), **Node 22 → 26** (#28), **Postgres 16 → 18** (#27), **Next 15 → 16** (#29). The stack is now **Node 26.5.1 · npm 12.0.2 · Next 16.2.12 · React 19.2.8 · Prisma 7.9.1 · PostgreSQL 18.4 · TypeScript 5.9.3 · Vitest 3.2.7**.

Three of those carried a trap that a version bump alone would have walked into, all recorded where they bite: the Postgres 18 image moved its data directory (§6a), npm 12 stopped running install scripts (§8), and Next 16 renamed `middleware` to `proxy` (`src/proxy.ts`, CLAUDE.md). ESLint 10 and TypeScript 7 remain blocked on what `eslint-config-next` vendors — see §6.

Two issues were filed from that run and are open backlog, neither blocking Phase 3 or Phase 4:
**#30** — CI never builds the Docker image, though production *is* that image, so a broken
Dockerfile passes today (this is why #16's green check proved nothing about Node 25). **#31** —
whether this app should keep fetching data in effects; Next 16's `react-hooks/set-state-in-effect`
is overridden in `eslint.config.mjs` for a defensible reason, but the rule points at the pattern
behind issues #5/#15 and several PR #22 findings, and Phase 3 added more pages in that same style
— Phase 4 will add more still, in whichever style is eventually chosen.

**Phase 3 (Orders & Loads) is complete and MERGED to `main`** — squash-merged 2026-08-03 as
`12a17f9` (PR #39, 56 commits: 17 tasks `5a93325`–`125ea43`, then four Codex fix-round waves and
docs). The final whole-branch review ran on the strongest model (verdict: with-fixes; wave applied)
before the PR opened; Codex then posted five rounds — rounds 1–4's 34 findings all fixed on the
branch with regression tests, round 5's 6 findings triaged to issues #41–#46 by owner ruling
(2026-08-03: the round was not converging; no further code on the branch). Verified after merge:
squashed tree byte-identical to the branch tip (`56063b6`); `main` green on **1010 tests**
(85 files), `tsc` clean, `eslint` clean, `npm run build` clean, **`npm run test:e2e` 10/10** — the
original six 2C-3 flows unchanged, plus four new order flows (`order-entry-full`,
`board-search-scan`, `loads-after-print`, `void-order`), run three times consecutively to confirm
stability. Spec:
`docs/superpowers/specs/2026-08-02-phase-3-orders-design.md` (§3 records ten owner decisions from
the design session, with two dated 2026-08-03 amendments closing the traveler samples gate — see
below; §16 is Phase 4's own inheritance list, quoted in §9's kickoff prompt). Plan:
`docs/superpowers/plans/2026-08-02-phase-3-orders.md`. Owner-facing walkthrough with screenshots:
`docs/2026-08-03-phase-3-demo.md`.

It delivered the eleven order tables and the whole order lifecycle on top of them: `createOrder`'s
one-transaction save (validate → allocate the order number via the new generic `allocateNumber` →
lock the lead part's current revision via `lockCurrentRevision`, reusing `workingRevision`'s row-
lock claim → auto-split loads on order totals under the lead's caps → write via the audited
helpers → clear the caller's draft in the same transaction, spec §5), a loads editor with renumber
and the two-phase negative-park re-split pattern (`order-loads.ts`), unaudited autosaved drafts and
saved board views (`order-drafts.ts`/`saved-views.ts`), the full order route surface behind
`orders.*`/`void_order`, the shared attachments story widened to a second owner (orders, alongside
parts), permission-filtered global search with a deliberately-open exact-order-number short-circuit
(`search.ts`), the order board home page (traffic light, saved views, live search-to-scan)
replacing the Phase 1 welcome stub, order entry with crash-safe autosave, the ten-section order
hub, delete-guard extensions blocking part/customer deletion while a live order references them
plus request-day overrides surfaced on both pages, and — closing the traveler samples gate — real
PDF travelers via `pdfmake` + `bwip-js`, one document per print action, every print stored
byte-for-byte for exact reprints.

**Every one of the 16 feature tasks went through this project's independent spec-and-quality
review with fix rounds before being marked done** (each task's own report is in
`.superpowers/sdd/task-N-report.md`; this task — the E2E/demo/docs close-out — is reviewed as part
of the final whole-branch pass). Three lessons from those rounds are general enough to carry into
Phase 4:

- **The 2C-3 "sibling split" pattern recurred.** Four sibling bulk-edit grids
  (Containers/Charges/Serials/Loads on the order hub) share one hook (`src/lib/bulk-grid.ts`); a
  fix for three of them (a concurrent-edit orphan warning) was believed not to apply to the fourth
  (Loads, whose mutator updates rows in place rather than delete-and-recreate) — until review
  caught the one path (a save that *shrinks* the array) where it does too. When a fix lands on one
  member of a sibling group, check every other member in the same commit, even ones that look
  structurally different.
- **The row-lock lesson from 2C-3 held under its first real caller.** `createOrder` calls
  `lockCurrentRevision` inside the order save's own transaction exactly as 2C-3's review demanded
  — the row lock in `workingRevision`/`lockCurrentRevision` is the guarantee regardless of the
  caller's isolation level, and this phase did not "fix" that by making the order save Serializable
  (it IS Serializable, but for an unrelated reason — the registered-FK writer pattern on
  `containers[].typeId`).
- **A too-loose URL-matching pattern in a new E2E flow raced its own navigation** (Task 17):
  `page.waitForURL(/\/orders\/[^/?]+$/)` also matches the literal route `/orders/new` (a real page,
  still on screen right up until the click that navigates away from it), so it resolved instantly
  against the page still showing rather than the navigation the click was about to trigger. Fixed
  by waiting for hub-only content (a badge that can only render post-navigation) before reading the
  URL, not a broader regex. Worth remembering for Phase 4's own `/new`-suffixed entry routes.

**Owner rulings this phase took, all in spec §3 (dated amendments in the same section):**
lead+rider order lines with no recipe-match validation between them (accepted trade-off); auto-
split on order totals honoring both `loadQty` and `loadWeight` together; loads stay editable after
a traveler prints, with a reprint warning, never a freeze; business-day request dates,
most-specific override wins, silent; the traffic light reads the request date, not target; extra
charges captured now, priced later; credit hold warns at entry, never blocks (the squeeze moves to
Phase 4 shipping); an optional `vsOrderNumber` cross-reference field; and `pdfmake` + `bwip-js` for
the PDF stack. **Amended 2026-08-03, closing the Task 16 samples gate:** the 2025 mockup is the
traveler's build target with no further samples gating it; `PartInspection.sampleQty` (new
optional free-text column, prints in the Key Characteristic Quantity column); no
inspection-location images in Phase 3. **Further amended the same day** (Task 16 review): the
traveler's `Process:` cell renders blank in Phase 3 (Phase 7's template designer owns that slot) —
this phase's demo doc records the two cosmetic-but-real deviations alongside it (Process ID prints
the lead part number, not a masked family number; the load's weight prints as a small grey
addition with no column of its own on the mockup). Linking (§5d) also carries an amendment:
linking two orders UNIONS their groups rather than one side silently adopting the other's, so no
order is ever detached from a group by linking.

**What to do next, in order:**
1. **Merge Phase 3.** `phase-3-orders` needs the final whole-branch review this project always
   runs before merging a phase — the per-task reviews already caught and fixed real issues
   throughout (each task's own report has the detail); the whole-branch pass is what 2C-3's own
   history shows catches what review-of-review-fixes misses.
2. **Phase 4 — Certifications & Shipping**, once Phase 3 merges. Follow the roadmap
   (`docs/superpowers/plans/2026-07-29-roadmap.md`) and brainstorm → spec → plan → subagent
   execution as before — §9 below has the kickoff prompt, including what Phase 4 inherits from
   Phase 3 (design spec §16).
3. **No owner decision is pending.** Issue #4 is ruled (binds Phases 4–5); issues
   #14/#15/#30/#31 are triaged backlog, not blockers.

**After a reboot the environment comes back on its own** — `docker.service` is enabled and `erp-db-1` is `restart: unless-stopped`, so both databases return migrated. Git identity is set repo-locally. One nice change: a fresh login shell will carry the `docker` group natively, so the `sg docker -c '…'` wrapper used throughout this session is no longer needed — plain `docker compose …` works.

### 4b. Prisma 7 upgrade — what actually happened

**DONE 2026-08-01, branch `prisma-7-upgrade`.** This section originally recorded a pre-work survey against the official guide, to save the executing session from re-surveying. It now records the outcome instead — most of the survey held up; the parts that didn't are called out below rather than silently dropped.

**Already fine, no work — as predicted:** Node 22.23.1, TypeScript 5.9.3, no `tsc` target bump needed. `prisma.config.ts` needed `migrations.seed` added (`prisma.seed` in `package.json` is no longer read) and its `engine: "classic"` line **removed outright, not adapted** — v7 deleted the `engine` property from the config shape rather than giving it a new home. `url` came out of `schema.prisma`'s `datasource` block; `prisma.config.ts`'s `datasource.url` is the only place the connection string lives now.

**Mechanical, as predicted:**
- Generator is `provider = "prisma-client"` with `output = "./generated/prisma"`. The path is **gitignored** (`/prisma/generated` added to `.gitignore`) — the Docker standalone build regenerates it, and the client is TypeScript source, not JS-plus-`.d.ts`.
- `@prisma/client` imports moved to the generated path, **by relative import in exactly the 6 predicted files** — `src/server/db.ts`, `audit.ts`, `customers.ts`, `customer-addresses.ts`, `db-errors.ts`, `prisma/seed.ts` — deliberately not an `@/` alias and deliberately outside `src/`, so the sweep tests that walk every `.ts` under `src/` (`tests/permissions-sweep.test.ts`, `tests/partial-unique-sweep.test.ts`) aren't polluted by generated code.
- PostgreSQL requires a driver adapter, confirmed: `src/server/db.ts` and `prisma/seed.ts` both construct `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`.
- **Not predicted, found during the work:** `dotenv` and `tsx` had to move from `devDependencies` to `dependencies` — both are runtime dependencies of `prisma.config.ts` in the production image, which runs `npm prune --omit=dev`. The Dockerfile's run stage now copies `prisma.config.ts` too; without it the container crash-looped at start on `migrate deploy` with "The datasource.url property is required in your Prisma config file", because v7 reads the datasource URL from that file rather than the schema.
- Prisma packages are pinned **exactly** (no `^`) — `partialIndexes` (used by §5.18's partial unique indexes) is a preview feature and must not shift underneath an unrelated `npm install`.

**The ESM flip — predicted risky, actual blast radius was zero files.** `"type": "module"` landed as its own commit as planned, full suite green before and after. `vitest.config.ts`'s `__dirname` was the one thing expected to break, on the theory that `__dirname` doesn't exist in an ES module — it did not break, because Vite bundles its own config file and injects `__dirname` for it regardless of the package's module type. It was rewritten anyway (`fileURLToPath(new URL(...))`) as a robustness improvement, not because anything failed. `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, and `tsconfig` needed no changes at all.

**CLI behaviour changed beyond what the original survey anticipated.** Confirmed as predicted: `migrate dev` no longer generates the client or seeds; `--skip-generate`/`--skip-seed` are gone. Not anticipated at all: `migrate diff --to-schema-datamodel` is now `--to-schema`; `db execute` lost `--schema`/`--url`; and, the one that actually cost time, **`migrate dev` refuses to run in a non-interactive shell** — "the environment is non-interactive, which is not supported" — even with `CI=true` or `--create-only`. It works fine for a human at a terminal; automation (including a Claude Code session driving Bash) must use `migrate diff` to produce the SQL, hand-write the migration directory, and apply with `migrate deploy`. That is how this branch's one migration (`20260801031309_partial_unique_live_rows`) was created — see `CLAUDE.md`'s "Constraints that will bite you" and §5.10.

**Confirmed unused, as the survey hoped:** `prisma.$use` middleware (no hits in `src/` or `prisma/`), the metrics feature.

**Docs were the last task, not an afterthought.** `CLAUDE.md` (the two-database recipe, the first-run block, the deletion-is-soft rule) and this handoff (§4a, §5.10, §5.11, §5.18, §6, §8, §9) were rewritten in the same branch as the code, and verified by following `CLAUDE.md` verbatim against a clean clone (Task 10, this task).

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

    The upgrade path was documented before work started — the owner found it: the official guide is <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>, and Prisma publishes an **AI-agent migration prompt** at <https://www.prisma.io/docs/ai/prompts/prisma-7> laying out an 11-step process. This repo was measured against the guide on 2026-08-01 — §4b was the survey, and now also records the outcome. All four quality gates were kept green throughout, applied to both databases. The index change was applied to **every** revival site — `customer`, `role`, all ten reference kinds, `processStepCode` — `REVIVAL_DEFAULTS`/`REVIVAL_EXTRA_DEFAULTS` and every revival branch deleted, each `findUnique({ where: { code|name } })` converted to `findFirst({ where: { code|name, deletedAt: null } })`, and the revival tests rewritten to assert a **new id and a fresh history** instead of a reused row. Final suite: 258 tests, 31 files, zero skipped.

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
Then write a small `.mjs` that imports `chromium` from that cached `playwright` and drives `npm run dev`. Two traps worth knowing: React controlled inputs do **not** expose `value` as an HTML attribute, so `input[value="X"]` selectors fail — locate by index or label instead; and the app shell has its own global search box, so `input[placeholder*="Search"]` matches two elements. Dump the page's inputs first rather than guessing selectors.

Always clear the fixtures you create out of the **dev** database afterwards — `erp`, not `erp_test`.

## 6. Known backlog (all triaged, none blocking)

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
- **The shipment page's cert-print info line points at the wrong list**: after "Print all tickets"
  with certs, it says the archived certifications are "in Documents below", but cert documents are
  owned by `certId` and surface on the cert page and the order hubs — `listDocumentsForShipper`
  filters on `shipperId` and never returns them (observed in Task 20's browser run; copy-only).
- **The order hub's Documents list renders non-traveler kinds by raw enum name** ("SHIPPER",
  "BOL", "CERT") — its `KIND_LABELS` map only ever learned `TRAVELER`; the shipping and cert
  pages' own lists have friendly labels (cosmetic, observed in Task 20's flows).
- **Serials prefill over-includes on repeat shipments** (no per-serial shipped fact exists —
  owner ping #2 in §4a), and `OrderDetail.orderLineShippedToDate` rides unused in the edit page's
  catalog payload (dead weight; trim or keep at the whole-branch review).
- Assorted per-task §5.16 title gaps on state-disabled buttons and a missing 404/401 case on two
  document/print routes — all enumerated in the ledger under their tasks.

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

**Next up — Phase 5 (Invoicing & A/R + the QuickBooks Online summary export), once Phase 4's
finish sequence (§4a: whole-branch review → fix wave → PR → merge) has completed and
`phase-4-certs-shipping` is merged to `main`. Paste the block below into a fresh session.**

> Read `CLAUDE.md`, then `docs/HANDOFF.md` — §4a for where things stand and §6 for the carried
> backlog. **Phase 4 (Certifications & Shipping) is complete** (§4a — 21 tasks, all four gates
> green, the E2E harness 15/15 ×3; confirm it has actually merged to `main` before branching, and
> if it hasn't, finishing §4a's sequence — whole-branch review, fix wave, PR, demo — is the very
> first thing to do). Next is **Phase 5 (Invoicing & A/R + QBO)** per the roadmap
> (`docs/superpowers/plans/2026-07-29-roadmap.md`): invoices from shipments, pricing resolution,
> surcharges and extra-charge pricing, payments and A/R, finance charges, statements, the reversing
> shipment, and the **summary GL export to QuickBooks Online** — testable outcome "invoice shipped
> orders and reconcile a month". Brainstorm it (superpowers:brainstorming) against the roadmap and
> the original spec's §3 non-goals and §15 decision log, then write the spec and plan and execute
> with subagent-driven-development on a `phase-5-invoicing-ar` branch.
>
> **What Phase 5 inherits from Phase 4** (design spec §16,
> `docs/superpowers/specs/2026-08-04-phase-4-certs-shipping-design.md`) — read this before
> designing anything, since every one of these is a real hook Phase 4 built on purpose for this
> phase to use:
>
> - **`Order.status` reaches `PARTIAL_SHIPPED` and `SHIPPED`**, derived from ship-line-complete.
>   `INVOICED` and `REOPENED` are still unreachable and are Phase 5's to make reachable —
>   `REOPENED` specifically by the **reversing shipment** deferred in §3.8, which is the
>   negative-quantity counterpart to `voidShipper` and should reuse its sorted-claim and
>   status-recompute machinery.
> - **`ship-ledger.ts` is the shipped-quantity source of truth** — invoice-from-shipments reads
>   it rather than re-deriving totals. `ShipperOrder` is the natural grouping unit for spec §7.6's
>   per-shipper / per-order / per-PO invoice grouping.
> - **`allocateNumber` is proven on three counters** (order, shipper, BOL) with issue #34's guard;
>   `invoice_number_next` is the fourth and needs no new pattern. Note `cert_number_next` is
>   deliberately unused (§3.19) — do not "fix" it by wiring it up.
> - **`StoredDocument` is the one document table** with a kind-to-owner `CHECK`; invoices, credits
>   and statements widen `DocumentKind` and add their own owner column the same way — the
>   permanence, redaction and byte-exact reprint guarantees already exist once, in `documents.ts`.
>   (The `CHECK` is hand-written SQL — CLAUDE.md "Constraints that will bite you".)
> - **`Shipper.billFreight`/`freightAmount`/`freightTerms`** are captured and unpriced; Phase 5
>   bills them. `OrderCharge.amount = null` still means "needs price" (P3 §3.6).
> - **Credit hold's override action and its reason-in-audit shape** are the template for Phase 5's
>   invoice unlock and A/R period close.
> - **The invoice sample is already in `docs/samples/`** and answers several Phase 5 questions
>   early: the invoice number reads `7 − 72026` against `Our Order #: 72026`; it prints `Material`
>   and `Process: Austemper` (the same process-name slot the traveler renders blank, P3 §3.9d — it
>   recurs here, and Phase 7's designer owns it); it shows a per-line pricing block with `Price per
>   Each` and `Minimum Charge` side by side; and it carries a named surcharge line (`EnergySur`).
> - **Email is owed** (§3.2) with issue #4's visible-skip ruling attached; whichever phase builds
>   it inherits the recipient flags already on `CustomerContact`.
> - Cert charges, "bill for cert" and per-customer cert suppression are Visual Shop behaviours
>   Phase 4 deliberately does not model; Phase 5 decides whether the shop wants any of them.
>
> Owner homework that now gates this phase (HANDOFF §7): the QuickBooks Online finance-charge
> treatment (settle with the bookkeeper) and the GL account list for operations, surcharges and
> payment types — chase both before the QBO export is designed. Also carry §4a's four owner pings
> (Page-N-of-M, serial re-shipment warning, tear-off threshold, `User.title`) if the owner has not
> yet ruled on them at the PR.
>
> Keep the process that has now held for four phases: fresh subagent per task → independent review
> (dispatch the repo's own `task-reviewer` agent) → fix rounds → re-review → whole-branch review on
> the strongest model → one fix wave → PR, with attribution in the **PR body**, never a commit
> trailer (a hook blocks them). §4a lists eleven lessons from Phase 4's reviews; the three that
> will bite a new session fastest: **a concurrency test that passes is not evidence** (verify by
> deleting the guard and watching it go red — and pin the competing caller to Read Committed);
> **multi-order writes claim rows only through `claimOrdersInOrder`** (one sorted statement, never
> a loop); and **when a fix lands on one member of a sibling group, enumerate the whole group in
> the report**. Remember the prime directive: do not assume — ask the owner.

**Historical — the prompt that started Phase 4. Phase 3 was merged as `12a17f9`, PR #39.**

> Read `CLAUDE.md`, then `docs/HANDOFF.md` — §4a for where things stand and §6 for the carried
> backlog. **Phase 3 (Orders & Loads) is complete** (§4a — 17 tasks, all four gates green, the
> E2E harness 10/10; confirm it has actually merged to `main` before branching, and if it hasn't,
> that is the very first thing to finish). Next is **Phase 4 (Certs & Shipping)** per the roadmap
> (`docs/superpowers/plans/2026-07-29-roadmap.md`): cert records/results/scopes, shippers + MOS +
> BOL, ship-line-complete, void/reverse, freight, stored PDFs — testable outcome "cert and ship
> real orders." Brainstorm it (superpowers:brainstorming) against the roadmap and the spec's §3
> non-goals and §15 decision log, then write the plan and execute it with
> subagent-driven-development on a `phase-4-certs-shipping` branch.
>
> **What Phase 4 inherits from Phase 3** (design spec §16,
> `docs/superpowers/specs/2026-08-02-phase-3-orders-design.md`) — read this before designing
> anything, since every one of these is a real hook Phase 3 built on purpose for this phase to use:
>
> - **Reserved statuses** (`PARTIAL_SHIPPED`, `SHIPPED`, `REOPENED` on `Order.status`, unused by
>   Phase 3) and the §5a edit-rule hook: order edits are gated "only while not voided" today, with
>   an explicit note that Phase 4 adds status-based tightening once these statuses become
>   reachable — decide what stays editable once an order has shipped or partially shipped.
> - **`allocateNumber`** (`settings.ts`) is a generic claim-a-sequence-number primitive — reuse it
>   for shipper/cert/invoice numbering rather than reimplementing the pattern.
> - **`StoredDocument`** is the stored-exact-PDF-forever pattern (kind/loadNumber/fileData, no
>   delete path, byte-identical reprints) the traveler already proved out — widen its `kind` enum
>   or add sibling tables for shippers/certs/BOLs; that choice is Phase 4's to make.
> - **Credit hold moves from a warning to a real gate at shipping.** Phase 3 deliberately only
>   warns at order entry (owner ruling, spec §3) — the actual squeeze is Phase 4's to build.
> - **Ship-line-complete is a human decision, not arithmetic** — kept from Visual Shop (HANDOFF
>   §3): a checkbox someone ticks, never derived from shipped-quantity math.
> - **The serialization warning needs a shipping-side sibling** — Phase 3's "serialization
>   required, no serials yet" lives at order entry; shipping likely needs its own version.
> - **The attachment story is one parameterized service already built for this**
>   (`src/server/attachments.ts` + `AttachmentsSection.tsx`) — add `ShipperAttachment`/
>   `CertAttachment` etc. as thin clones over the shared service, the same way Phase 3 built
>   `PartAttachment` and `OrderAttachment` as two thin owners of one implementation.
> - **`linkGroupId` is reference-only in Phase 3** — build "ship together" affordances on it if
>   wanted; nothing today forces that.
> - **The traveler's per-load render is the precedent for the shipper/BOL documents' own
>   per-load/per-shipment render** — same `pdfmake` + stored-bytes shape (spec §16), new layouts;
>   this is a render/layout-approach inheritance, distinct from `StoredDocument` as the storage
>   pattern above.
> - **Cert-required columns are explicitly deferred to Phase 4** (spec §15 non-goals) — Phase 3
>   carries no cert-readiness flag anywhere; that schema is this phase's to add.
> - **The §3.9 sampleQty/inspection-image questions are settled, not open.**
>   `PartInspection.sampleQty` is a real, shipped column (optional free text, prints on the
>   traveler); inspection-location images are explicitly NOT built, by owner ruling — don't reopen
>   either without a new one.
>
> Two habits worth carrying from Phase 3's own review rounds (§4a): when a fix lands on one member
> of a sibling group (parallel screens, parallel bulk-edit grids, parallel services), check every
> other member in the same commit; and if Phase 4 needs a per-record lock analogous to
> `lockCurrentRevision`, the row lock — not the caller's transaction isolation level — is the
> guarantee. **The toolchain moved on 2026-08-02** — Node 26 · npm 12 · Next 16 · PostgreSQL 18 —
> so before running anything, note three things §4a and §8 explain: `npm ci` warns that five
> packages' install scripts were skipped and that is correct, not a problem to fix; the Edge cookie
> gate is `src/proxy.ts`, not `middleware.ts`, because Next 16 renamed the convention; and Node 26
> is required (`nvm use 26`). Remember the prime directive: do not assume — ask the owner.

Process that worked in Phase 1 and should be kept: brainstorm/clarify → spec → detailed plan → fresh subagent per task → independent spec+quality review per task → fix rounds until approved → final whole-branch review on the strongest model → one fix wave → merge. The per-task reviews caught real bugs the plan itself contained (plaintext password in audit payload, `__proto__` registry crash, blank-page login, resurrection with stale permissions, silent empty backups) — **the review loop is not optional ceremony**.

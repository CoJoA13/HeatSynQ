# Phase 4 — Certifications & Shipping (merged 2026-08-06)

*Moved verbatim out of `docs/HANDOFF.md` §4a on 2026-08-06, when the handoff was split into current state plus `docs/history/`. Nothing below is edited or summarised, and the original `### 4a.` heading is kept as written so older references to "HANDOFF §4a" still resolve here. Current one-paragraph state: HANDOFF §4.*

---

### 4a. Phase 4 (Certifications & Shipping) — MERGED to main as `f129aae` (PR #47, 2026-08-06)

**Finish sequence DONE (2026-08-06):** the whole-branch review ran on the strongest model (verdict:
merge with fixes — full text `.superpowers/sdd/whole-branch-review.md`), its one fix wave was
applied (five items) and the scoped re-review approved it **PR-ready** with zero new breakage.
Final gates: **1360 tests**, `tsc`/`eslint`/`build` clean, E2E 15/15. The review's headline catch:
the T6-era carry was a **latent defect, not a test gap** — the voided-state guards on Cert/Shipper
rested on SSI accidents, and print-vs-void had no protection at all; both discriminating race tests
were verified RED pre-fix. The fix locks the cert/shipper row itself after the order claims, and
`order-locks.ts`'s header now carries the resulting house rule: **the guarded state must live on,
or be locked with, the claimed row** (Phase 5's reversing-shipment work will need it again).

**PR #47 Codex review, two triage rounds (2026-08-06), all 14 threads resolved.** Round 1 (nine
findings, all verified real): five fixed on the branch — `travelerPrinted` filtered to TRAVELER
documents (a one-order shipping ticket also carries `orderId` now), BOL "No. Packages" falls back
to the container-count sum, `addOrderToShipper` creates the shipment-scope cert it owed,
removal refuses when the shipment-scope cert has printed (the cert carries `orderNumber-sequence`
permanently), and `cert=1` print failures ride `x-print-warnings` instead of failing a request
whose ticket already archived — and four deferred to issues **#48–#51** (shipping-list row links,
signature byte validation, idempotent-replay warnings, add-order customer-switch race). Round 2
(five findings, all real): removal keeps the positive-qty invariant against lineless-shell
survivors, LOAD-scope cert creation requires a load the order currently has, the print bar links
bundled cert PDFs directly (the shipment Documents list filters on `shipperId` and can never show
a CERT document), and the two FK findings became the owner-ratified **snapshot + release**
amendment — spec ruling 23, migration `20260806091506` (20 migrations total now). Standing owner
rules from these rounds: run the Playwright E2E suite whenever a change touches any UI/flow, and
update the appropriate docs as part of the work itself. Gates after round 2: **1370 tests**,
`tsc`/`eslint`/`build` clean, E2E 15/15.

**Round 3 (2026-08-06, seven findings, all verified real, all fixed on-branch — spec rulings
24–26):** `printCert` refuses when the owning ORDER is voided (voidOrder leaves ORDER/LOAD certs
live, so the cert's own `deletedAt` couldn't carry §5.6 alone); the cert=1 bundle resolves inside
`printShippingTickets`' own claimed transaction (the separate unlocked resolution could bundle a
different shipment state than the tickets printed); **credit hold gates shipment extension** —
owner ruled add-order + line-replacement, same override/reason shape as creation, reason in the
audit entry, UI reason field on the shipment page; an order update landing on certRequired+ORDER
creates the ORDER cert (the hub only exposes LOAD-scope creation); **ruling 23 extended to
`CertRequirement`** (snapshot linePosition/partNumber/partName, FK SET NULL, migration
`20260806104833`) so a frozen requirement never blocks `removeLine`; shipment grids render
released snapshot rows read-only and shipper-side replaces preserve them as frozen history; cert
export gained Passed/Pending columns. Gates after round 3: **1381 tests**, `tsc`/`eslint`/`build`
clean, E2E 15/15. 22 migrations total.

**Round 4 (2026-08-06, four findings — all real follow-ons to the snapshot + release work, all
fixed on-branch):** cert requirement identity now reads the frozen snapshot UNCONDITIONALLY
(round 3 had shipped it live-join-first, the shipment-grid convention — wrong for a document
frozen at seed: a part rename would silently rewrite a seeded cert), and the cert page groups
requirement blocks by frozen `linePosition` (two released riders otherwise merged under one
heading); the order-hub document list's shipper-relation branch is constrained to `orderId: null`
so a sibling order's own ticket stays off other orders' lists; and both the audit
`SNAPSHOT_INCLUDE` and the shipment detail read order serials by `[serial, id]` — released rows
tie at `orderSerialId: null`, and the arbitrary tie-break made order-sensitive audit diffs report
unchanged serials as modified. Gates after round 4: **1384 tests**, `tsc`/`eslint`/`build` clean,
E2E 15/15.

**Round 5 (2026-08-06, two findings, both fixed on-branch):** the cert PDF's parts table now
appends one frozen-identity row (honest-blank quantities) per released requirement line — the
cert stays live when an unshipped rider is removed, and its archived paper must still name the
part its readings belong to; and `replaceReadings` refuses verdict/measurement contradictions
(an override needs a value, an overridden value needs a boolean verdict — `value: null,
passed: true` stored a pass measured on nothing, and `value: X, passed: null` hid an
out-of-bounds reading from the failure count), with the readings editor pre-validating the same
two rules by row. Gates after round 5: **1387 tests**, `tsc`/`eslint`/`build` clean, E2E 15/15.
Also this round: one CI run hit the workflow's 15-minute timeout (5m01 → 8m51 → cancelled across
the triage rounds while the local suite held ~2 min) — diagnosed as GitHub Actions degradation
(stuck runner queue, API 502s), confirmed when the same head passed in a normal 5m44 once a
runner picked it up. Not a branch problem; no timeout bump.

**Round 6 (2026-08-06) — and the STOPPING RULE, owner-ratified.** The owner asked why the review
loop wasn't converging; the answer is the 2C-3 dynamic §4a-prior already records (review of
review-fixes converges slowly — half of rounds 4–6 there were findings in code written for the
previous round; here, rounds 4–5 were almost entirely the snapshot + release blast radius), plus
an LLM reviewer having no natural zero — severity converged (data-integrity P1s → advisory P2s),
count never will. **Ruling: the 2C-3 stopping rule applies from round 6 — findings are triaged to
issues unless they are correctness, concurrency, or data-integrity defects; after round 6's
fixes, further findings become issues only, and the owner squash-merges.** Round 6 itself (seven
findings): FIXED — cert PDFs print frozen identity throughout (parts table + serial blocks now
agree with the requirement headings; released rows merge at frozen positions, matching the
seeded order); every credit-hold check claims the Customer row (the house rule applied — a
concurrently committed hold was invisible to the unlocked read, at creation AND extension; the
discriminating holder-race test is in shipper-children.test.ts); order removal refuses once ANY
shipment-owned paper printed (BOL included — it lists order numbers permanently); `loadNumber`
bounded to INT4_MAX (500 → field 400). DEFERRED — #52 whole-shipment document coverage vs
current membership (design: persist coverage / freeze adds / mark stale — the add-after-print
half of the BOL finding), #53 scope-matched missing-cert warnings, #54 edit-response
warning recompute (shares a fix with #50). Gates after round 6: **1392 tests**,
`tsc`/`eslint`/`build` clean, E2E 15/15.

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

## Appendix — the kickoff prompt that started Phase 4

*Moved verbatim out of `docs/HANDOFF.md` §9 in the same 2026-08-06 split; it had already been marked historical there.*

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

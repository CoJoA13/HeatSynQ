# SDD ledger — plan: docs/superpowers/plans/2026-08-06-phase-5a-pricing-invoicing.md

Branch: phase-5a-pricing-invoicing
Merge base: 712def3 (main)
Plan committed: 659fc07

Pre-flight scan (controller, before Task 1):
- CONFLICT FOUND AND RESOLVED IN THE PLAN, not deferred to review: Task 2 Step 5 originally
  mandated leaving `PricingSection.tsx` as a render-nothing stub, `part-price-breaks.ts`
  commented out, and `PRICING_FIELDS` as an empty tuple — three things the review rubric
  correctly treats as defects (dead code; a guard that checks nothing). Amended: Task 2 now
  DELETES the entire old pricing surface, leaving the tree compiling with no part-pricing
  service or UI until Tasks 4-5 build the replacement. Task 4's file list updated to match.
  Commit: (amended plan, committed with Task 1).
- No other task-vs-task or task-vs-Global-Constraints conflict found.

Task 1: dispatched (implementer, sonnet) — BASE a83860e, brief task-1-brief.md
Task 1: implementer DONE — commit b532505, 1409 passed / 0 failed, tsc+eslint clean.
  Implementer note (non-blocking): brief predicted a tsc error pre-implementation, but
  setSetting's `key` is typed `string`, so the pre-state failure was runtime-only. Correct
  call not to weaken setSetting's signature; brief wording was slightly off, code is right.
Task 1: review dispatched (task-reviewer, sonnet) — package review-a83860e..b532505.diff
Task 1: review clean — Spec ✅, quality Approved, no Critical/Important.
Task 1: minor (deferred): counter ordering in SETTINGS was reordered slightly beyond the
  brief's literal fence (credit_number_next beside the active counters; invoice_number_next
  moved beside cert_number_next under the shared comment). Reasonable; note it in HANDOFF at
  phase wrap so a later reader isn't surprised.
Task 1: complete (commits a83860e..b532505, review clean)
Task 2: dispatched (implementer, opus — highest-blast-radius task: two migrations, two DBs,
  hand-written CHECKs, plus deletion of the old pricing surface) — BASE b532505
Task 2: implementer DONE_WITH_CONCERNS — commit 269f525, 1415 passed / 0 failed, tsc+eslint+
  build clean, migrate status clean on BOTH databases, E2E 15/15. Precondition verified: 0 parts
  on both databases, so no backfill; not blocked.
  Two migrations, split proactively because Postgres cannot use a new enum value in the
  transaction that adds it: 20260806221400_document_kind_invoice_values then
  20260806221500_pricing_and_invoicing.
  PLAN DEFECT FOUND BY IMPLEMENTATION: the brief's REFERENCE_LINKS snippet gave no `liveWhere`
  for `surchargeStepCode` and the four `billingConfig` entries; findBlockers defaults to
  { deletedAt: null }, which neither model has, so Prisma THREW — every GL-account and
  step-code delete would have 500'd. Caught by 21 failures across 6 files on the first full
  run, fixed with two shared constants. The plan's snippet was wrong; the code is right.
  Controller amendments from this task (commit 69931b8): Task 19 Step 1 trimmed to what is
  genuinely still owed on documents.ts (widening DocumentKind made Record<DocumentKind, Area>
  a compile error, so Task 2 necessarily did the schema-shaped half — verified in the tree);
  Task 5's stale "remove the // TASK 5: marker" line corrected.
Task 2: review dispatched (task-reviewer, opus — 33 files, migrations, two CHECKs, a shared
  test-helper change, and a plan-snippet fix all need judgment)
Task 2: review clean — Spec ✅, quality Approved, 0 Critical, 0 Important, 7 Minor.
  Controller resolved the reviewer's ⚠️ items: precondition RE-VERIFIED by hand — 0 parts,
  0 breaks, 0 orders on BOTH erp and erp_test, BillingConfig singleton present on both;
  `prisma migrate status` "up to date" on both; migration dirs 23 -> 25, all applied.
  (Aside: HANDOFF's "25 migrations" was already off by two before this phase; Task 20 rewrites
  that section anyway.)
  Minors 1/2/3 FOLDED INTO LATER BRIEFS rather than deferred (commit below):
    - deletePart -> PartPrice cascade test  -> Task 4
    - documentFilename INVOICE/CREDIT tests -> Task 19
    - BILLING_CONFIG_BLOCKER render test    -> Task 3
    - SURCHARGE_VIA_STEP_CODE render test   -> Task 6
  Minor 4 FIXED IN THE PLAN: Task 3's premise "truncateAll wipes the seeded row" is now false
  (Task 2 made truncateAll re-seed it). Task 3 now keeps the EMPTY fallback but tests it by
  deleting the row explicitly, so the test can actually fail.
  Minor 5 (CLAUDE.md "never a lazy create" vs Task 3's upsert-on-write) -> Task 3 brief note.
  Minor 6 (deferred): partial-unique sweep allowlist is now much broader — `orderId`,
    `partId_processStepCodeId`, `customerId_surchargeId`, `partPriceId_threshold` are
    column-NAME-only entries. No offender exists today; issue #35 already tracks scoping the
    sweep per-model. Forward-looking noise.
  Minor 7 (deferred): deleting the old breaks routes leaves stale .next/types/validator.ts
    entries, so a bare `tsc --noEmit` reports 4 phantom errors until a build regenerates them.
  Minor (deferred): no explicit RED evidence for tests/invoicing-schema.test.ts — inherent to a
    schema task whose test needs the migration applied first. Code verified by other means.
Task 2: complete (commits b532505..269f525, review clean)
Task 3: dispatched (implementer) — BASE fe5cb81, brief task-3-brief.md
Task 3: implementer INTERRUPTED mid-task (session ended; no report written). Controller
  recovered the state on resume rather than re-dispatching from scratch: Steps 1-6 are in the
  working tree UNCOMMITTED and green — src/server/billing-config.ts, tests/billing-config.test.ts
  (9 tests, all passing), src/app/api/admin/billing/route.ts. Steps 7-8 (the admin page, the nav
  entry, gates, commit) were never started; src/app/admin/billing/page.tsx does not exist.
  Re-dispatched a fresh implementer to finish 7-8 only.
Controller repair on resume: `.superpowers/sdd/.gitignore` had been clobbered back to a bare `*`,
  which silently re-ignored this entire ledger directory — the exact regression its own header
  comment was written to prevent (Phase 3's execution record was lost that way). Restored from
  HEAD; the Phase 5A ledger is tracked again. If it recurs, check what rewrites that file.
PLAN DEFECT FOUND ON RESUME (controller-resolved, folded into the Task 3 dispatch): the Task 3
  brief's Step 7 says "Add the card link on `src/app/admin/page.tsx` beside Settings", and its
  Files list says to modify that file. **There is no `/admin` index page in this app** — admin
  sections are reached from the `ADMIN` array in `src/components/Shell.tsx:33-41`, which the
  brief's own Files line simultaneously (and contradictorily) marks "no nav change". Resolution:
  add `{ label: "Billing", href: "/admin/billing" }` to that array beside Settings. Intent
  ("reached from Admin, beside Settings") is preserved; the named file is simply wrong.
Task 3: implementer (resumed, sonnet) DONE — commit 2b3b488, 98 files / 1424 tests passing,
  tsc+eslint+build clean, browser-verified (saved values persisted across a hard reload; the
  admin.edit-gated controls render DISABLED with the correct tooltip, not hidden, per §5.16).
Task 3: review dispatched (task-reviewer, opus — the CLAUDE.md-vs-upsert tension and the scoped
  Serializable branch both need judgment). Verdict: Spec ⚠️ (compliant on every checkable item),
  quality NEEDS FIXES — 1 Important, 7 Minor.
  Important (FIXED): four of the seven fields had no round-trip coverage. Only salesTaxRate and
    billForCertDefault were ever read back through getBillingConfig; otherChargeGlAccountId and
    certChargeDefault were never written OR read. Transposing two lines in the mapping (e.g.
    freightGlAccountId: row.otherChargeGlAccountId) passed tests, tsc AND eslint — both are
    `string | null` — and would have misrouted freight to the wrong GL account inside the invoice
    tasks that consume this as source of truth. This is the exact defect class types cannot catch.
  Minor 2 ADJUDICATED, NOT CHANGED — the `upsert`'s lazy-create arm vs CLAUDE.md's "never a lazy
    create". Reviewer's reading, which I accept: CLAUDE.md's rule is scoped to the READ path
    (`getBillingConfig` is a plain findFirst and never writes — honored literally), the CHECK plus
    the PK mean the create arm can only ever produce the one correct row, and on a genuinely
    rowless database it self-heals through the UI where a plain update would 404 with no in-app
    recovery. Plan-mandated (brief Step 3 dictates the upsert verbatim) AND correct on the merits.
    Documented in place with a comment rather than changed, so it is not re-litigated next phase.
  Minor 3 FIXED: the save-failure path's comment claimed "roll back before reporting why" (§5.13)
    while the code did the reverse. Harmless only because load() never calls setError(null) —
    the natural refactor would have silently erased the error banner. Reordered to match §5.13.
Task 3: fix wave 1 dispatched (sonnet) — commit 130b35a. Discrimination PROVEN, not asserted:
  the new all-fields test was run with a transposed mapping (FAIL, 1/10) then reverted (PASS,
  10/10), both outputs in the report.
Task 3: re-review (task-reviewer, sonnet, scoped to the three fixes) — Spec ✅, quality APPROVED,
  0 Critical / 0 Important. Reviewer independently reproduced the discrimination rather than
  trusting the report, and confirmed the reorder is non-regressive against a fresh read of load().
  It also noted the reorder is a clarity alignment, not a behavioral fix — load() is never awaited,
  so setError runs synchronously first either way. Correct, and worth knowing.
Task 3: controller resolution of the review's two ⚠️ "cannot verify from diff" items:
  (1) TDD RED evidence for Steps 1-6 is UNRECOVERABLE — the predecessor implementer was
      interrupted before writing a report, and its trail is gone. Not reconstructable and not
      worth faking. Mitigation is real rather than nominal: the reviewer verified independently
      that these tests DISCRIMINATE (the fallback-branch test fails if `if (!row) return EMPTY`
      is removed; the audit test asserts real before/after diff content), and fix wave 1 proved
      its own RED. Recorded as a known evidence gap in this task only.
  (2) The full-suite claim was NOT taken on trust — controller re-ran the whole gate chain
      (see the phase wrap entry below).
Task 3: MINORS DEFERRED to whole-branch review triage (reviewer's numbering):
  M4 — a configured-but-INACTIVE GL account or step code renders "(none)" on the billing page
    while still being stored and still posting to invoices. Both option sources filter
    active:true and neither passes includeInactive. Inherited pattern (step-codes/page.tsx:294),
    but this is the one screen where a silently-misreported GL account has money consequences.
    Strongest candidate of the deferred set.
  M5 — an empty `PUT {}` writes a spurious audit entry (updatedAt is @updatedAt, so Prisma's
    `update: {}` still fires). Not reachable from the page.
  M6 — concurrent PUTs can land out of order and briefly display stale values; the database is
    correct either way (each PUT is a disjoint field patch).
  M7 — auditedUpdate's before-snapshot is a plain read, so two admins saving different fields
    can misattribute history. Pre-existing everywhere, named only because the singleton is the
    one table where every admin edit contends on the SAME row.
  M8 — RESOLVED, not deferred: erp/.claude/launch.json (untracked, not ignored) is deleted; see
    the repo-hygiene entry below.
Task 3: complete (commits fe5cb81..130b35a, re-review clean)
Task 3: FULL GATE CHAIN re-run by the controller (not taken on trust from the implementer, and
  the review's ⚠️ item 2): 98 files / 1425 tests passed, tsc exit 0, eslint exit 0, build clean,
  and `npm run test:e2e` 15/15 flows PASS. E2E was run because this task added a UI screen —
  the owner's standing rule, now recorded in CLAUDE.md rather than only in session memory.

Task 4: dispatched (implementer, sonnet) — BASE 04133db, brief task-4-brief.md
Task 4: implementer DONE — commit e0cfa77, 99 files / 1433 tests passing, tsc+eslint+build clean,
  sweeps (reference-links, partial-unique, permissions) 17/17. Precondition verified before
  starting: Task 2's deletions (part-price-breaks.ts, its test, its two routes, PRICING_FIELDS,
  parts.ts's flat pricing fields) all confirmed absent.
  Implementer note: `AuditableModel`, `SNAPSHOT_INCLUDE` and the reference-links FK registration
  were ALREADY in place from Task 2's schema commit, so those files show no diff — expected, not
  an omission. Flagged for the reviewer to confirm against the tree rather than assume.
  Implementer DISCLOSED one test beyond the brief's seven (updatePriceBreak/deletePriceBreak
  scoping + read-back), on the grounds those two functions otherwise had zero coverage. Declared
  rather than slipped in; sent to the reviewer to rule on as scope, with no pre-judgement.
Task 4: review dispatched (task-reviewer, opus — money decimals differ by column, partial-unique
  columns, child-route scoping, and the LOT-vs-breaks rule that MIGRATED services in Task 2)
Task 4: review — Spec ✅, quality NEEDS FIXES. 1 Important, 5 Minor. The service itself was found
  sound and the reviewer verified rather than assumed: every decimal scale checked against its
  column (unitPrice 12,4 and break price 12,4 vs the 12,2 money fields), no findUnique/upsert near
  either partial-unique pair, canonical nesting in all six mutators, refusals naming the real
  blocker, child scoping enforced twice (read + claim WHERE).
  It also confirmed the LOT rule is whole: break-on-LOT refused, LOT-while-live-breaks-exist
  refused, and it looked for a third path and established there isn't one (partId/partPriceId are
  immutable, so updatePriceBreak needs no re-check). The Serializable use is legitimate here for
  a reason worth recording: the addPriceBreak / updatePartPrice pairing is a genuinely TWO-SIDED
  write-skew structure Postgres will abort — not the one-sided Serializable the house rules ban.
  CONTROLLER ERROR, corrected here: my review dispatch told the reviewer to check "effective
  dating" — overlapping ranges, open-ended ranges, ties. **PartPrice has no such columns and the
  plan never claimed it did** (`grep -n effective` over the plan returns nothing); I invented the
  concept from the phase's general shape. The reviewer checked the schema, found no date dimension,
  and said so rather than inventing findings to match the prompt — the correct behavior. Worth
  recording because a dispatch that asserts a false premise can manufacture work: state what to
  verify, not what is true. The real determinism guarantee, confirmed: the live partial unique
  (partId, processStepCodeId) gives exactly one live row per operation, plus explicit orderBy on
  both the rows and their breaks.
  Important (FIXED): the four new price routes had ZERO executed test coverage, and `change_prices`
    was by then enforced NOWHERE ELSE in the suite — Task 2 deleted the PRICING_FIELDS guard tests.
    Deleting any `mustDo(user, "change_prices")` left every gate green (permissions-sweep only
    checks that requireUser() is *called*, and its gating walk covers src/app/api/admin only), so
    plain parts.edit could have rewritten the pricing Task 9 turns into invoices. Inherited — the
    deleted breaks routes had the same hole — but this is now the only pricing write surface.
  Reviewer CORRECTED the implementer's report on two points, both upheld: the report claimed the
    routes were "exercised indirectly by the sweeps" (the sweeps read files as TEXT and never
    invoke a handler), and claimed the eighth test covered the "Price row" vs "Price break" not-
    found distinction (it did not — both paths asserted "Price row not found"). Do not take an
    implementer's coverage claim as coverage.
  Eighth-test scope question RULED: justified, not creep — test-only, covers two exported
    functions the brief mandates but never exercises, assertions have teeth, and it was disclosed.
  Minors 2-5 FIXED in the same wave: the second scoping tier (a break under a different price row
    on the SAME part — the case where an edit lands on the wrong row), the untested step-code-change
    branch, a stale comment citing the deleted part-price-breaks.ts, and duplicate-threshold
    refusals.
Task 4: fix wave 1 dispatched (sonnet) — commit e343a16, 99 files / 1437 tests. Discrimination
  PROVEN for the Important: with `mustDo` removed from prices/route.ts's POST the gate test failed
  `expected 200 to be 403`, and passed once restored.
Task 4: re-review (task-reviewer, sonnet, scoped to the five fixes) — Spec ✅, quality APPROVED,
  0 Critical / 0 Important / 0 Minor. The reviewer did NOT just re-run the implementer's own proof:
  it removed `mustDo` from the PATCH handler in the breaks/[breakId] route — a handler the
  implementer's discrimination proof never touched — confirmed the gate test failed
  `expected 200 to be 403`, reverted, re-ran, and verified a clean tree. That establishes the one
  route test protects all SIX mustDo call sites across the four files, not just the sampled one.
  It also verified finding 4 was precisely scoped (only claimLivePrice's comment carried the stale
  citation; claimLiveBreak's never did and was correctly left alone).
Task 4: complete (commits 04133db..e343a16, re-review clean)
Task 5: dispatched (implementer, sonnet) — BASE 2a52093, brief task-5-brief.md, carrying the
  delegated basis-change design decision in the brief's opening blockquote.
Task 5: implementer DONE — commit 48284f7, PricingSection.tsx created fresh (+403) plus 2 lines
  in parts/[id]/page.tsx. 1437 tests, tsc+eslint+build clean, E2E 15/15.
  DESIGN DECISION MADE (the one delegated to this task): a basis change among the non-LOT units
  on a row with live breaks **warns via confirm()**, naming the break count and the old/new units
  — rather than refusing it or re-stating the thresholds. Implementer's reasoning: refusing would
  foreclose a state Task 9's engine is explicitly scoped to handle, and re-stating would require
  inventing a unit conversion this screen has no basis for. Controller check before review:
  `confirm()` is an ESTABLISHED idiom here, not an invention — 14 files use it, including the
  sibling ProcessStepsSection.tsx on this very page. Sent to review to judge on the merits.
  VERIFICATION CAVEAT, disclosed by the implementer rather than hidden: this sandbox's Browser
  pane could not composite frames (screenshots timed out) and synthetic pointer events were
  unreliable, so some interactions were driven with `element.click()`. That fires the same React
  handler, so handler LOGIC is genuinely exercised — but it bypasses pointer delivery, so it
  cannot establish that a control is reachable, unobscured, or truly (not just visually) disabled.
  Claims are backed by network bodies, DOM reads and server-state reads. Flagged to the reviewer
  to separate what is evidenced from what is merely asserted; honest disclosure is neither a
  defect in itself nor a free pass. This component has NO vitest seam, so that evidence is the
  only test it has.
Task 5: review dispatched (task-reviewer, opus — a 403-line client component with no unit-test
  seam, the delegated design decision, §5.16/§5.13, and 2C-3's draft-preservation trap)

Task 5: review — Spec ⚠️ (substantially compliant), quality NEEDS FIXES. 1 Important, 7 Minor.
  DESIGN DECISION RATIFIED by the reviewer: warn is right. Refusing would make a legitimate
  correction unreachable (a user who mis-set the basis, whose thresholds are already the numbers
  they meant, would have to delete every break to fix it), and re-stating needs an EACH↔LB ratio
  this screen does not have — using Part.eachWeight would be exactly the assumption the prime
  directive forbids.
  Important (FIXED): move() rebuilt the TWO-PATCH position swap that BOTH siblings on this same
    page carry explicit comments warning against (InspectionsSection.tsx:109-113,
    ProcessStepsSection.tsx:279-281). The swap permutes the multiset of position values, so no
    sequence of clicks can ever remove a duplicate: once two rows tie, their relative order is
    frozen forever and the up/down buttons between them become permanent no-ops — on the ordering
    an invoice prints in. Three entries into that state, one of them not even a race: on a FAILED
    prices GET, `rows` is [] so addRow's nextPosition computes 0 and collides on every add.
  CONTROLLER DECISION on the fix: build the atomic reorder route rather than patch the swap.
    Precedent is threefold and unambiguous (reorderPartInspections, reorderSteps,
    reorderTemplateSteps — each with a route), and both siblings on this page were converted away
    from the two-PATCH shape already. It does NOT contradict the brief: still up/down buttons,
    still no drag handle — only the mechanism changed. One deliberate divergence from the
    inspections model it mirrors: that route gates on parts.edit alone, but every price route
    gates on parts.edit AND change_prices, so the new one matches the price routes.
    PLAN AMENDMENT: Task 4's file list did not contain this route; it is added here.
  Minors 2/3/5/7/8 FIXED in the same wave; #3 fixed in BOTH PricingSection and InspectionsSection
    (sibling-split rule applied deliberately rather than leaving a known-identical gap).
  #8 is the one that matters beyond this task: the reviewer established NOTHING in CI could catch
    a regression in PricingSection.tsx — no vitest seam, no E2E flow touched pricing, and the only
    automated check that sees the file is the client-import sweep. An e2e/flows/permission-gating
    case now covers the double gate, using a NEW fixture user/role so both halves of the AND are
    exercised (reusing the existing "restricted" user would have varied only one half).
  Minor 4 DEFERRED (own task, not this one): PricingSection's synthesized fallback <option> is
    BETTER than what InspectionsSection and customers/[id] do — so the siblings now diverge in the
    good direction. The sweep to backport it is filed, not folded in.
  Minor 6 RECORDED, no action: the component holds a full editable `rows` copy, the shape 2C-3
    warns about — but the reviewer confirmed the actual 2C-3 failure (a stale clean copy masking
    another user's edit) is unreachable here, and it matches InspectionsSection exactly.
Task 5: fix wave 1 (sonnet) — commit 2a31ea8, 1445 tests, E2E 15/15, 403 discrimination proven.
  The fixer CORRECTED TWO FACTUAL ERRORS rather than working around them, both accepted: my
  dispatch claimed "users have a delete route" (this app NEVER hard-deletes User rows —
  "deactivate instead"), and the previous session's report had claimed two roles were deleted when
  they were not. Cleanup used a guarded one-off script on the E2E harness's own precedent.
Task 5: CONTROLLER VERIFICATION of the review's ⚠️ — nobody had ever LOOKED at this 400-line
  section, so I seeded one part + price row + two breaks into the DEV database and inspected it.
  Screenshots failed here too ("the Browser pane is not displayed, so the page is not compositing
  frames") — INDEPENDENTLY CONFIRMING the implementer's disclosed limitation was environmental,
  not a failure on their part. Measured geometry instead of pixels:
    Desktop (1385px card): 0 overflowing elements, no horizontal page scroll, the grid-cols-4
      money row renders as four equal 258px columns on ONE line (Setup charge / Unit price /
      Minimum charge / Price per, all at y=1112), nested break table 1095px CONTAINED in the card.
    Narrow (644px): 2 overflowing inputs, table wider than its card, grid stays 4 columns at 73px.
      NOT a Task 5 finding — measured Inspections and Process steps at the same width and all
      three are IDENTICAL (2 overflowing, table overflows card). House baseline for a desktop
      office ERP of 1-5 users, not a regression. Recorded so it is not rediscovered as one.
  Scratch data removed afterward. The residual DEV rows ("Task 5 Test Customer/Part") are the
  implementer's, are all SOFT-deleted, and are correctly left alone — hard-deleting them would
  break the house rule that deletion is always soft outside tests.
Task 5: re-review dispatched (task-reviewer, opus — the new reorder route/service, and 106 new
  lines in the shared e2e/lib/db-fixtures.ts, whose reaper hard-deleted a developer's own rows in
  2C-3 behind a guard that checked only the database NAME)

Task 5: re-review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 6 Minor.
  The reviewer established something better than "the bug is gone": because the route renumbers to
  0..n-1 BY INDEX, an ALREADY-TIED pair is repaired by a single up/down click. The fix does not
  merely avoid new ties, it makes the permanently-frozen state both unreachable AND escapable.
  It also verified the reaper did NOT widen — assertDevDb untouched (database name `erp` AND
  localhost, no override), the three new fixture rows keyed on exact literals, no prefix scan
  reintroduced — and confirmed the new E2E case genuinely varies BOTH halves of the AND (case 1
  asserts "Requires parts.edit", case 2, holding parts.edit, asserts "Requires change_prices"),
  on two controls that are unconfounded by any second condition.
  HONEST COVERAGE ACCOUNTING from that review, worth carrying: of the six fixes, only the SERVER
  half of fix 1 and the E2E gate case would fail if regressed. Reverting move() to two PATCHes,
  or dropping the rowsReady guard, still breaks nothing in CI — PricingSection.tsx has no vitest
  seam and the E2E case exercises only the disabled state, never a reorder or an add. The defect
  we found is fenced server-side only. Not a defect in the fix; a standing fact about this file.
Task 5: fix wave 2 (controller-initiated, sonnet) — commit 48ce7e8, 1445 tests, E2E 15/15.
  Closed four Minors rather than deferring them, because two were latent traps in SHARED E2E
  infrastructure that Tasks 6+ will extend: cleanup() swept prices for one part while
  reapLeftovers() swept all of them (the next flow to price a second fixture part would have
  23503'd cleanup), and deletePartPrices swept no AuditLog rows — a bug THIS FILE HAS HAD BEFORE
  (its own comment records it as "fix-wave finding 12"), which would leak one permanent orphaned
  audit row per mutation into the developer's dev DB from the first flow that prices through the
  app. Also: the reorder route test never discriminated its parts.edit half (both 403 cases also
  lacked change_prices, so deleting mustCan left everything green) — fixed here AND on the four
  sibling price routes carrying the identical pre-existing hole, per the sibling-split rule.
  Discrimination proven for the new case. Verified by the controller against the diff rather than
  by a third review dispatch: fix 1 now passes a list, fix 2's audit sweep is scoped by exact
  entityId lists (not a blanket `entity:` wipe), 10 changeOnly assertions landed, assertDevDb
  shows zero lines in the diff. Stated plainly because it is a departure from the normal loop:
  the task was already APPROVED, and these were hygiene items on top of it.
Task 5: DEFERRED to whole-branch triage — reorder tests assert audit entry identity rather than
  before/after diff content (mirrors the part-inspections precedent verbatim, and real behavior is
  asserted separately via listPartPrices); and Minor 4 from the first review, the synthesized
  fallback <option> sweep into InspectionsSection + customers/[id] (PricingSection's version is
  the BETTER one — the divergence is in the good direction).
Task 5: report's stale opening corrected in place with a controller note rather than an edit —
  the original wording is the historical record of what the implementer believed (re-review M6).
Task 5: complete (commits 2a52093..48ce7e8, re-review clean)

Task 6: dispatched (implementer, sonnet) — BASE 9d5a70c, brief task-6-brief.md
Task 6: implementer DONE — commit fb7a2d9, 18/18 new tests (6 surcharges + 12 sweep), full suite
  1453/1453, tsc+eslint clean. Verified against the tree before writing that Task 2 had ALREADY
  extended AuditableModel and SNAPSHOT_INCLUDE — no change needed (claim passed to the reviewer
  to confirm rather than accept).
  THREE DEVIATIONS, all DISCLOSED by the implementer rather than slipped in:
  1. A NEW MIGRATION outside the brief's file list — 20260807024446_surcharge_step_code_cascade,
     dropping and re-adding SurchargeStepCode_surchargeId_fkey with ON DELETE CASCADE. Reasoning:
     SurchargeStepCode is an OWNED CHILD (setSurchargeStepCodes deletes/recreates the whole set on
     every save), same shape as ProcessStepFieldDef.codeId; without Cascade, making `surcharge` a
     BlockerTarget would let a surcharge's own step-code list block its own deletion.
  2. updateSurcharge takes the FULL SAVE shape, not a partial patch — the implementer's reading of
     "consistency rules live in the superRefine, not the service body". Brief does not test it.
  3. A 3-line duplicate-step-code-id guard in setSurchargeStepCodes, not brief-specified, for a
     clean message against a real unique constraint.
  CONTROLLER VERIFICATION of the migration (mechanical only — the DESIGN question went to the
  reviewer, since a wrong FK is far cheaper to fix now than after Task 9 depends on it):
    purely corrective, no data loss; applied to BOTH databases (26 migrations, "up to date" on
    each); schema.prisma carries the matching onDelete: Cascade; `migrate diff` reports zero drift
    ("This is an empty migration"). The two-database rule was honored without being reminded.
  OPEN QUESTION I put to the reviewer rather than settling myself: ON DELETE CASCADE is a HARD
  delete of child rows, in a system whose house rule is that deletion is ALWAYS soft and hard
  deletes happen "only in tests". Whether the ProcessStepFieldDef precedent genuinely matches, and
  whether registering `surcharge` as a BlockerTarget was even required by the brief, are design
  calls — not something to wave through because the mechanics check out.
Task 6: review dispatched (task-reviewer, opus — a hand-written migration, a schema FK change, and
  reference-links.ts + its sweep, which is the EXACT area Task 2 shipped a 500-ing defect in)

Task 4: DEFERRED, carried forward by the controller into Tasks 5 and 9 (NOT a defect in this task,
  reviewer's judgment and mine): `updatePartPrice` will move a row's basis among the non-LOT units
  (EACH → LB → PER_1000) while live breaks exist, and `threshold` is defined as being expressed in
  the parent row's price-per unit — so every existing break silently changes meaning. The old
  surface behaved the same way, and no requirement covers it. Task 5 owns the UI question (warn?
  refuse? re-state thresholds?), Task 9 owns what pricing does with it.

Repo-hygiene pass (owner-approved mid-phase, 2026-08-06, riding along with this PR — commits
974852f, b7e8008, 1cdad25). Not part of Task 3; scope-fenced to docs and config so it could run
in parallel with Task 3's review without touching erp/src, erp/tests, prisma/ or the ledger.
- `.claude/launch.json` hardcoded `/home/cojoa13/Desktop/HeatSynQ/erp` — a user that does not
  exist on this machine (machine-move residue). The dev server could not start from the canonical
  config, and Task 3's implementer silently worked around it by creating an untracked, un-ignored
  `erp/.claude/launch.json`. Root config now resolves via `git rev-parse --show-toplevel`; the
  duplicate is deleted. Reviewer's Minor 8, resolved here rather than deferred.
- CLAUDE.md's counts had rotted: "1010 integration tests" and "10 Playwright flows" against an
  actual 1425 and 15. Counts removed rather than updated — they rot on the next commit and then
  actively mislead — and a maintenance rule added banning numbers that ordinary commits move.
- HANDOFF.md was 844 lines / ~16.3k words and could no longer be read in one call: a `Read` of it
  truncated at line 436 of 845, so every session was silently reading half its own project memory.
  Split to 416 lines; 535 lines of merged-phase narrative moved VERBATIM to four `docs/history/`
  files. Preservation was verified, not asserted: each history file diffs empty against the block
  it came from, and the surviving slices plus the moved blocks reconstruct the original
  byte-identically under `cmp`. The 416 overshoots the 250 target because everything remaining is
  a section that is still operative (§6 alone is 108 lines); the agent stopped rather than delete
  live context, which was the right call.
- Deliberately NOT done: the agent did not invent a Phase 5A status narrative for §4 (prime
  directive — 5A has not merged). Whoever merges it writes that paragraph.
- `.claude/settings.json` allowlist widened with safe, frequent commands (build, test:e2e,
  migrate status, read-only git).
- Memory consolidated: the two stored memories were owner RULES already duplicated in CLAUDE.md
  and HANDOFF, i.e. three copies free to drift. They now live in CLAUDE.md alone (versioned,
  reviewable, travels with the repo); memory keeps only what the repo cannot record.
- TRAP FOUND THE HARD WAY (2026-08-06, controller): the SDD skill's `scripts/task-brief` writes
  to `.superpowers/sdd/task-N-brief.md` — FLAT — and **Phase 4's ledger is stored flat in that
  same directory**. Extracting Phase 5A's Task 4 brief silently overwrote Phase 4's
  `task-4-brief.md` ("Cert resolution chain and the freeze at order save"), and moving the output
  then showed up as a ` D ` deletion. Restored with `git checkout --`; it was recoverable ONLY
  because Phase 4's ledger had been committed. Documented in `.superpowers/sdd/README.md`.
  Standing procedure: after running task-brief or review-package, `git status` before committing,
  and treat a ` D ` on any `.superpowers/sdd/task-N-*.md` path as a clobber to restore.
  (The scripts also rewrite `.superpowers/sdd/.gitignore` to a bare `*` on nearly every run —
  four times this session. Restore is `git checkout --`; the relocation to docs/execution is what
  makes it harmless.)
- CORRECTION worth carrying: the first diagnosis of the ledger-erasure bug was wrong. It looked
  like a one-time clobber, and the proposed fix was "commit early". Testing the actual mechanism
  showed (a) already-tracked files are wholly immune — git applies ignore rules only to UNTRACKED
  paths, so the 122 committed historical ledger files were never at risk — and (b) the file is
  rewritten REPEATEDLY, including twice within this single session, so hand-restoring it does not
  hold. Both halves matter: (a) shrank the fix from a 122-file move to an 8-file one, (b) proved
  the move was still necessary. Verify the mechanism before sizing the fix.

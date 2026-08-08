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

Task 6: review — Spec ⚠️, quality NEEDS FIXES. 5 Important, 6 Minor.
  ALL THREE DEVIATIONS RULED ON:
  1. The CASCADE migration: APPROVED, and for a better reason than the implementer gave — the
     cascade can NEVER FIRE. deleteSurcharge is auditedSoftDelete and no code path hard-deletes a
     Surcharge; the only physical delete is truncateAll's TRUNCATE … CASCADE, which cascades
     regardless of the annotation. No history destroyed, AuditLog independent of the FK. The
     ProcessStepFieldDef precedent is exact (owned child, no deletedAt, hard-deleted by its
     parent's replace service, hanging off a soft-deletable parent), four more such cascades
     already exist, and the alternative was worse: registering the FK would have made a
     surcharge's own step-code list block its own deletion and name the surcharge as its own
     blocker. Registering `surcharge` as a BlockerTarget WAS brief-mandated, so the sweep failure
     was unavoidable rather than self-inflicted. My worry that Cascade contradicts the soft-delete
     house rule was answered on the facts, not waved off.
  2. updateSurcharge's full-shape SAVE: the SHAPE is defensible, the IMPLEMENTATION was not.
  3. The duplicate-step-code guard: JUSTIFIED. Without it a raw P2002 would have surfaced as
     "A surcharge with that value already exists" — actively misleading.
  Important 1 (FIXED) — THE HEADLINE. updateSurcharge validated the whole row but persisted only
    the keys the caller SENT: zod DROPS an absent optional key entirely, so Prisma left the column
    untouched. Flipping a PERCENT surcharge to FLAT persisted kind=FLAT WITH THE OLD RATE STILL
    SET — a state the superRefine declares impossible, produced by the only payload the service
    accepts (the caller cannot resend `rate`; the refine rejects it). Mirror case left a stale
    `amount`; glAccountId could never be cleared, and that path also skipped assertRefExists.
    The deviation's own justification collapsing: "the rule lives in the superRefine" only holds
    if the row reaching the database is the row the superRefine validated.
  Important 2 (FIXED) — setCustomerSurcharge meant two different things: create took schema
    defaults for omitted fields, update RETAINED them. set(rate) then set(optOut) left both, while
    the same second call on a fresh customer yielded rate=null. A `set…` that half-replaces.
  Important 3 (FIXED) — updateSurcharge and listCustomerSurcharges had ZERO coverage;
    setCustomerSurcharge's update branch had never executed, so SNAPSHOT_INCLUDE.customerSurcharge
    was unexercised on the one path that calls snapshot(); and nothing asserted an audit DIFF.
  Important 4 (FIXED) — updateSurcharge mutated soft-deleted rows. Brief-mandated (it said follow
    updateStepCode verbatim, and that function does this), but the NEWER precedent in the same
    file uses `where: { id, deletedAt: null }` with a comment recording why (Codex, PR #22:
    "audited as an update after its own delete entry, describing a change to a row nothing can
    ever see again"). The file was internally inconsistent — setSurchargeStepCodes already 404s.
  Important 5 (FIXED) — PLAN HOLE, not an implementer miss, and the controller's to close. A
    customer override could never be REMOVED: Task 6's interface had no delete, Task 7's route is
    GET+PUT, Task 8 consumed those — verified across the whole plan, no removal path anywhere. But
    a live CustomerSurcharge row blocks deleting the surcharge it points at, and optOut:false
    still leaves the row, so one override made a surcharge undeletable FOREVER. That is the exact
    shape reference-blockers.ts:12-22 names as the Visual Shop dead end this system exists to
    escape. Added deleteCustomerSurcharge (soft delete via auditedSoftDelete, 404 when no live
    override), with a test proving a soft-deleted override actually FREES the blocked delete
    rather than assuming the default liveWhere handles it.
    PLAN AMENDED: Task 8 now owns the matching DELETE route, gated like the PUT
    (customers.edit + change_prices — removing an override is a price change just as setting one
    is) plus a UI control. Removing must be as discoverable as adding.
  Minors M1-M5 all fixed. M1 mattered more than its grade: detailPath ignores its argument, so a
    regressed blockerId changed only b.id — which nothing asserted — silently producing a 404 link.
Task 6: fix wave 1 (sonnet) — commit fd7925d, tests 6 -> 17, full suite 1464/1464, tsc+eslint
  clean, no migration needed. Fix 1 chose NORMALIZE-ON-WRITE over merge-then-validate (merging
  would reintroduce the "service body re-derives merged state" shape the full-row SAVE design
  exists to avoid). RED confirmed before the fix: `expected 0.04 to be null`.
Task 6: re-review dispatched (task-reviewer, opus — verifying the normalization is TOTAL across
  every optional on both models and both write paths; one unpinned optional reproduces the whole
  defect for that field)

Task 6: re-review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 4 Minor.
  The reviewer verified the Fix 1 RED claim MECHANICALLY rather than trusting the captured output
  (zod drops absent optionals; Prisma treats undefined as no-op), and checked the normalization is
  TOTAL column by column against the schema — all six of Surcharge's settable optionals pinned,
  all three of CustomerSurcharge's, in BOTH the create and update paths. Also confirmed the
  pinned literals equal the schema defaults, so routing create through the same helper is
  behavior-preserving rather than a silent semantic change.
  Its ⚠️ (confirm the Task 8 amendment actually landed, since deleteCustomerSurcharge has no
  caller in src/ yet): CONFIRMED in HEAD, commit 6f2790a.
Task 6: fix wave 2 (sonnet) — commit b764412, 1465 tests. Closed the two coverage minors that
  mattered: three of the six normalization pins had NO discriminating test — minimumAmount
  appeared nowhere in the file at all, so deleting its pin reproduced the exact headline defect
  for that column with the suite green; and scope/active were only ever passed explicitly.
  LESSON — THE FIXER CAUGHT A BAD FIX OF MINE. My dispatch said the ordering assertion could be
  repaired by dropping `.sort()` from the actual side. It tested that and found it did NOT
  discriminate: cuid ids are near-monotonic, so insertion order coincided with sorted order and
  removing `orderBy` still passed 3/3. It strengthened the test to insert step codes in
  deliberately DESCENDING id order — now fails reliably without `orderBy` (3/3) and passes with it
  (3/3). "Prove it discriminates" earned its place here by catching the proposed remedy, not the
  original defect. Do not assume cuid ordering in any test that means to assert an ordering.
Task 6: Minors 2 and 4 folded into Task 8's plan section rather than fixed here (they are that
  task's to honor): the surcharge editor must post the WHOLE row, because normalize-on-write means
  an omitted field CLEARS it — an inactive surcharge saved from a partial form silently
  re-activates and loses its minimumAmount; and an override belonging to a SOFT-DELETED customer
  still blocks its surcharge, with the blocker panel linking at /customers/{deletedId}, so Task 8
  must decide deliberately how that override gets cleared.
Task 6: complete (commits 9d5a70c..b764412, re-review clean)
CONTROLLER MIS-FILING, corrected: I folded the "editor must post the whole row" carry-forward into
  Task 8 only, following the reviewer's own wording. Wrong — `updateSurcharge` is called by
  TASK 7's route (Admin → Surcharges IS the surcharge editor); Task 8 is the customer-side
  override editor and needs the same discipline for `setCustomerSurcharge`. Now recorded on BOTH
  task sections, each naming the function it actually calls. A carry-forward is only useful if it
  lands on the task that owns the code.
Task 7: brief extracted. PLAN DEFECT, same one Task 3 hit: the Files list names
  `src/app/admin/page.tsx`, which does not exist — there is no /admin index page; admin sections
  live in Shell.tsx's ADMIN array. Pre-resolved in the plan and in the dispatch rather than left
  for the implementer to trip over a second time.

Task 7: dispatched (implementer, sonnet) — BASE fc37830, brief task-7-brief.md, carrying the two
  pre-resolutions (no /admin index page; the editor MUST post the whole row).
Task 7: implementer DONE — commit 689d698, 10 files / +760. 1476 tests (25 new route tests + 4
  percent-conversion unit tests), tsc+eslint+build clean, E2E 15/15.
  WHOLE-ROW VERIFIED LIVE, and verified the way I asked: set minimumAmount=75 and active=false,
  then edited ONLY position (1->5), reloaded, and confirmed minimumAmount/active/rate/scope/
  stepCodeIds all survived — from captured network bodies, not inference. That is the exact trap
  normalize-on-write creates, checked against the running server rather than reasoned about.
  Disclosed deviation: a single admin.edit gate rather than step-codes' create/edit/delete split,
  on the grounds the brief's own route-test spec calls for exactly that. Sent to the reviewer.
  UNDISCLOSED addition, caught by the controller reading the diff rather than the summary:
  src/lib/surcharge-percent.ts (+35) and tests/surcharge-percent.test.ts (+35) are NOT in the
  brief's file list and were not mentioned in the report-back. Probably right — a client component
  cannot import from src/server/**, so a shared pure module in src/lib is the sanctioned pattern
  (permission-constants.ts is the precedent) — but it went to the reviewer to rule on, WITH the
  note that unlike this phase's other deviations it was not declared. Read the diff, not the
  summary: three deviations this phase were disclosed, this one was not.
  Same environmental limitation as Task 5 (no frame compositing, unreliable coordinate clicks);
  verification done via DOM/event driving and fetch() against the real authenticated session.
Task 7: review dispatched (task-reviewer, opus — five routes, a 440-line page with no vitest seam,
  and the percent<->decimal round trip, which is the likeliest real bug in the task)
CONTROLLER ERROR, corrected: I told the reviewer surcharge-percent.ts was an UNDISCLOSED addition.
  It was disclosed — the report file documents it in four places (lines 34-36, 93-102, 219, 222).
  I read the implementer's short report-BACK summary and treated its silence as the report's
  silence. The report-back is a 15-line digest by design; the report file is the disclosure. Check
  the file before accusing anyone of not declaring something. (The reviewer ruled the extraction
  justified on the merits either way: a "use client" page cannot import src/server/**, and
  src/lib/invoice-constants.ts is already shared by both sides — same precedent as
  permission-constants.ts.)
Task 7: review — Spec ✅, quality NEEDS FIXES. 2 Important, 5 Minor.
  Reviewer singled out two things as genuinely right, both worth keeping: the whole-row payload is
  TYPE-ENFORCED (SaveFields is a total type and buildBody returns it, so adding a control that
  sends a partial patch is a COMPILE ERROR, not a silent regression — Task 6's headline defect is
  structurally closed, not merely avoided); and the percent conversion is correct across
  Decimal(9,6)'s ENTIRE range, checked at the boundaries (999.999999 round-trips exactly; 1e-6
  still stringifies as "0.000001" rather than flipping to exponent form and failing the regex;
  percentToDecimal("0") returns 0, not null, so a 0% surcharge saves).
  Important 1 (FIXED) — SIBLING-SPLIT RULE AGAIN, and the sharpest instance yet: the page inherited
    step-codes' idioms WITHOUT its saveQueue, and the sibling's own comment
    (step-codes/page.tsx:75-86) reads like a description of this file — "two overlapping saves are
    last-writer-wins over the whole set, and they overlap on the most ordinary interaction there
    is: editing a label and then clicking a control." Because buildBody makes every PUT a whole-row
    write, exactly one of two overlapping edits ALWAYS dies, silently, with no error. Two traced
    losses: (a) type a rate then click Active — the typed rate lives only in textDrafts and is
    never mirrored into rowsRef, so the second PUT carries the OLD rate; (b) check two step codes
    in succession — THE BRIEF'S OWN STEP 4 SCENARIO — where the non-optimistic checkbox invites
    the second click during the window and the second PUT drops the first code. Fenced by nothing:
    no vitest seam, no E2E flow, and the verification script awaited each interaction so it could
    not reproduce either.
  Important 2 — PLAN-MANDATED AND SELF-CONTRADICTORY, so escalated to the owner rather than
    decided by me: Step 1 specified a single admin.edit gate, Step 2 said copy from step-codes,
    which splits. OWNER RULED (2026-08-07): SPLIT — POST admin.create, PUT admin.edit, DELETE
    admin.delete, matching every other admin CRUD list. Recorded as a plan amendment superseding
    Step 1. Rationale: admin.edit-without-admin.delete is the only lever the model offers, and
    under one gate anyone who could edit a surcharge could soft-delete a definition Task 9 consumes.
  Minors 3-7 folded into the same wave. Minor 5 is the one worth remembering: buildBody IS the
    whole-row guarantee — the single thing this task was dispatched to get right — and it was
    unexported inside a client component, so nothing could assert it; it was held up by TypeScript
    alone. Extracted to src/lib/surcharge-body.ts with its own tests. The highest-risk logic in the
    task had no test while the lowest-risk (the percent helpers) did.

Task 7: fix wave 1 — commit daf1cfd. The implementer completed the code and gates but LOOPED
  waiting on its own E2E run and never reported; two prompts produced no written report. Controller
  ran the gates (1483 tests / 102 files, tsc, eslint, build, E2E 15/15), verified the fixes against
  the tree, and committed. Evidence assembled into task-7-fix-wave-1-note.md, labelled by source.
  CONTROLLER ERROR, corrected in that note: I first recorded Fix 1 as "reasoned, not empirically
  demonstrated" because no report existed. Wrong — the implementer HAD reproduced both loss cases;
  it simply never wrote them down. Asking produced audit timestamps and response codes specific
  enough to check. ABSENCE OF A REPORT IS NOT ABSENCE OF VERIFICATION — ask before concluding.
  The evidence, worth keeping: BEFORE, two audit entries 6ms apart, PUT#2's `before` snapshot still
  read the pre-typed rate (the typed value lives only in textDrafts, never mirrored into rowsRef),
  final state reverted silently. AFTER, PUT#2's `before` carried the already-updated rate — that
  snapshot is the tell that it ran only once PUT#1's load had landed. Case (b) was WORSE than
  predicted: two quick step-code clicks did not merely lose one, the concurrent Serializable
  transactions collided outright and returned a 409 — a user-visible error on an ordinary
  interaction, not just silent loss.
Task 7: re-review — Spec ✅ (all seven fixes present), quality NEEDS FIXES. 1 Important, 5 Minor.
  Important: THE QUEUE'S FRESHNESS INVARIANT WAS DEFEATED BY useLatest. `load()` returned without
    writing rowsRef.current when its ticket was superseded, so a save queued between a superseded
    load and the load that superseded it composed from the PRE-save row — re-opening the identical
    silent whole-row revert the wave had just closed, narrower window, same silence. And it was a
    divergence from the sibling in exactly the cited spot: step-codes/page.tsx:45-51 writes
    codesRef.current unconditionally. The queue's own comment asserted the invariant the code did
    not hold. Reviewer traced the entry: rate blur -> add() -> Active click.
Task 7: fix wave 2 (sonnet) — commit cfe2d45. Chose to drop the latest gate on the REF write only
  (the sibling's shape, one localized change) over plumbing load()'s return through six call sites.
  useLatest still guards the RENDERED state, which is what it exists for (issues #5/#15/#23); the
  ref exists for a different purpose — handing queued runs fresh server truth — and was wrongly
  sharing the ticket. REPRODUCED before the fix with the reviewer's own interleave: audit showed
  before.rate "0.3" -> after.rate "0.09", the typed value reverting; after the fix, before.rate
  "0.4" -> after.rate "0.4", only `active` changed. Race window widened with a fetch-delay shim,
  DISCLOSED as such — real PUT/POST/audit calls throughout, nothing fabricated.
  Controller verified the diff rather than dispatching a third review: rowsRef.current = r now
  lands BEFORE the ticket check with only setRows/setGls/setStepCodeOptions gated, matching
  step-codes exactly, and the stale comment was rewritten to state the invariant actually held.
  Stated plainly because it departs from the loop: round 3 on one task, a single localized change,
  matching a precedent I checked myself, with empirical before/after.
Task 7: Minor 4 CLOSED by the controller — the committed task-7-report.md described the pre-ruling
  gates (POST/DELETE on admin.edit) and carried "Concerns: none outstanding" over the very
  deviation that was escalated and ruled against. Corrected with a header note rather than an edit;
  the original text is the record of what was built and why.
Task 7: DEFERRED to whole-branch triage — (a) NOTHING FENCES THIS PAGE'S WRITE PATH: no vitest
  seam, and `grep -rn surcharge e2e/` returns zero hits across all 15 flows, so fixes 1/3/4/7 are
  protected by nothing and both race demonstrations were manual and unrepeatable in CI. The right
  instrument is an E2E case firing overlapping surcharge saves — and per the reviewer it should
  drive an add()/delete interleave, not just two field saves, so it would also cover the freshness
  hole. (b) Draft clearing is keyed to the queue TAIL, so a backlog can wipe typing still in
  progress. (c) removeRow stays outside the queue — no integrity risk (updateSurcharge scopes
  `deletedAt: null`), but a save queued behind a delete surfaces "Surcharge not found" just as the
  row correctly disappears. (d) No fix-wave TDD RED record from the implementer.
Task 7: complete (commits fc37830..cfe2d45, Important closed and verified)

Task 8: dispatched (implementer, sonnet) — BASE e85c5d4, brief task-8-brief.md, whose opening
  blockquote carries the plan hole I closed (the DELETE route) plus two Task 6 carry-forwards.
Task 8: implementer DONE — commit 05b2293, 10 files / +710. 1501 tests, E2E 15/15, gates clean.
  Two deviations, BOTH disclosed, BOTH ruled sound by the review:
  1. Gated the surcharge options behind `customers` permissions rather than the brief's literal
     admin.view route. I sent this up as a possible unilateral security loosening. The reviewer
     found it does NOT contradict the brief — Step 4's own binding language says
     mustCan(..., "customers", "view"), and the "Consumes:" line I read as a gate is an interface
     note. It also checked the DIRECTION: the payload carries only surchargeId/name/kind plus this
     customer's own override values; every plant-wide monetary field stays behind admin.view. That
     is TIGHTER than the established precedent for the same need (PricingSection reads step codes
     from /api/picklists, gated on session presence alone, §5.15). Lesson for me: check what a
     payload actually exposes before calling something a loosening.
  2. Touched admin/surcharges/page.tsx outside its file list to close the deleted-customer escape
     hatch. Right place; the reviewer verified the load-bearing assumption (the blocker's id for
     customerSurcharge->surcharge is the CUSTOMER's id, not the override row's).
  All three behaviors this phase has already paid for were verified GENUINELY PRESENT, not merely
  claimed: the payload type is total (omitting a field is a compile error), one shared saveQueue
  covers both write paths with the payload composed inside the run, and rowsRef is written BEFORE
  the isCurrent check. Task 7's defects did not recur.
Task 8: review — Spec ✅, quality NEEDS FIXES. 2 Important.
  Important 1 (FIXED) — A FAILED LOAD IMPERSONATED AN EMPTY LIST, violating an owner ruling. The
    section routed its load failure into the page's SHARED banner, which the page's own concurrent
    mount load() clears (setError(null)) — so a failed request left "No active surcharges are
    configured." asserted to someone editing pricing. HANDOFF §5.15 rules exactly against this, and
    the page ALREADY CARRIED the dedicated channel: optionsError/addOptionsError, documented as
    "its own state specifically so that no unrelated refresh can clear it out from under the user",
    added for an earlier review finding on this very file. The sibling it was modelled on
    (PricingSection) uses it AND keeps a rowsReady flag so "loaded and empty" is distinguishable
    from "never loaded". Sibling-split rule, third distinct instance this phase.
  Important 2 (FIXED) — the only body-reading DELETE in the app parsing without .catch, so a
    body-less request threw SyntaxError out of the handler (500) instead of the intended 400.
    Seven other DELETE routes use the catch; http.ts documents the convention.
Task 8: fix wave 1 — commit 8227931. THIRD consecutive implementer to finish the work and then
  stall in a wait loop instead of reporting; controller ran the gates (1502 tests / 103 files,
  tsc, eslint, build) and committed. That is now a pattern, not an accident.
  SCOPE EXPANSION, and the careful kind: Fix 3 needed a typed discriminator instead of branching on
  the display string entityLabel === "Customer". The fixer added `label` to Blocker as OPT-IN
  (off by default) rather than always-populated, after discovering an always-on field would have
  broken strict toEqual assertions in reference-blockers/process-step-codes tests across the app —
  then ran nine test files to prove the opt-in leaves them untouched. Wrote the reasoning down.
  That is how to widen shared infrastructure.
  IMPLEMENTER HONESTY WORTH RECORDING: it disclosed a false start (monkey-patched fetch + synthetic
  Link clicks, which silently caused full page reloads so the patch never applied — caught via the
  network log and DISCARDED rather than reported as evidence), and a second false positive (React
  Fast Refresh preserved component state across its edit, so rowsReady stayed true and the empty
  text still showed — recognized as a test-method artifact, not the real fresh-mount case, and
  discarded). It then forced a genuine full navigation and verified properly: optionsError banner
  rendered, the page's own GET succeeded concurrently (so setError(null) really did run), and "No
  active surcharges are configured." did NOT appear. Two discarded false results are worth more
  than a clean claim.
  It also stated plainly that Fix 2 was NEVER red/green checked — fix and test written in one pass.
  CONTROLLER CLOSED THAT GAP: reverted the .catch, ran the test, confirmed RED (SyntaxError escaping
  the handler, exactly as the review predicted), restored, confirmed GREEN 33/33.
Task 8: DEFERRED to whole-branch triage — showing the plant-wide value beside the override field
  (needs a permission-widening decision, owner ruling); two rate conventions on one screen (raw
  decimal for sales tax, percent for the rate override — each matches the plant field it overrides,
  which is the better rule, but `4` in the wrong box stores 400%); GET on an unknown customer
  returning 200; save()'s silent no-op for a row missing from rowsRef; CustomerSurchargeOptionRow
  duplicated between lib and server; no audit-content assertion for the two new scalar columns.
  AND the standing one: `grep -rli surcharge e2e/` still returns nothing, so none of this task's
  client behavior is fenced either.
Task 8: dev-DB note — the fixer hard-deleted its own FIXW1 fixture via raw psql rather than the
  app's soft-delete path. Dev-only and its own row, but worth naming: this system hard-deletes
  outside tests nowhere else. Three older soft-deleted customers (ACME, T8CUST, TESTCUST) remain
  from earlier sessions; correctly left alone.

Task 8: re-review — Fixes 1/2/4 ✅ APPROVED, Fix 3 ❌. One Important, and it INVERTED the value of
  the scope expansion I had praised a turn earlier.
  THE FINDING: the "typed discriminator" was a TAUTOLOGY. The panel's list comes only from
  findBlockers("surcharge", …), so every row originates from a link with targetKind "surcharge" —
  and both such links (customerSurcharge, invoiceLine) carry `label: "Surcharge"`. Not coincidence:
  `label` is DEFINED as "column header wherever this FK is displayed or exported", and the header
  for a surchargeId FK is "Surcharge". So the new conjunct was true for 100% of rows, all
  discriminating power still rested on the display string the fix existed to stop trusting, and the
  future collision its own comments promised to exclude would still have passed both conjuncts.
  Full cost paid (shared type widened, client mirror, a new option on a many-caller data-integrity
  guard, ~25 lines of comment asserting sturdiness), zero benefit — and, as the reviewer put it,
  worse than the original honest fragility, because the next maintainer would trust a guarantee the
  code did not provide. LESSON: a marker is only a discriminator if it VARIES across the set it
  filters. Check that before paying for the plumbing — and be suspicious of praising a change for
  its care rather than its effect, which is what I did.
Task 8: fix wave 2 — commit cbbb141. Discriminates on `model` ("customerSurcharge"), a member of
  the typed ReferenceLinkModel union — Prisma-model identity, not a rendered string. Replaced the
  `label` marker through the whole chain rather than adding a third field (it had no other
  consumer). Comments rewritten to state the property actually held. Fix 3's opt-in is now a real
  conditional spread, so the key is genuinely absent rather than present-and-undefined. Fix 2's
  banner message now names its source, matching the page's two sibling option fetches.
  It built a REAL discriminating test rather than a hypothetical: billed a surcharge onto an actual
  InvoiceLine and confirmed it returns model "invoiceLine" and is excluded by the filter. And it
  was precise about the limit — discrimination against a not-yet-written future link is not
  empirically testable; that rests on `model` being genuine model identity.
  This implementer REPORTED PROMPTLY, breaking the three-in-a-row stall pattern.
  FLAKE CLAIM VERIFIED, NOT ACCEPTED: it reported 1502/1503 with "an unrelated pre-existing timeout
  flake". "Unrelated" and "pre-existing" are exactly the words that hide real breakage, so the
  controller re-ran the full suite: 1503/1503 clean, plus tsc/eslint/build. Claim was accurate.
Task 8: complete (commits e85c5d4..cbbb141, re-review clean on the fixes that were re-run)

Task 9: dispatched (implementer, OPUS — the arithmetic heart of the phase; an error here becomes a
  wrong number on real paper, silently) — BASE 8227931, brief task-9-brief.md (421 lines).
Task 9: implementer DONE_WITH_CONCERNS — commit 67b6a59, pricing.ts (+318) and its test (+619).
  63 new tests, full suite 1566/1566, tsc+eslint+build clean.
  It ran ELEVEN MUTATIONS of the arithmetic and reverted each, confirming every one was caught:
  round-unit-before-multiply, banker's rounding, round-once-at-the-end, compounding surcharges,
  qty/100 break basis, >= on the minimum tie, tax including freight, >= on the break threshold,
  setup inside the minimum, a surcharge emitted with nothing qualifying, needsPrice zeroing the
  amount. Mutation testing, unprompted, on money code — the right instinct.
  Purity is enforced BY A TEST that re-reads the source and asserts every import starts with
  ../lib/. The reviewer went further and ran the file with DATABASE_URL pointed at 127.0.0.1:1 —
  63/63 pass, so the module genuinely needs no database, not merely "imports none".
Task 9: review (task-reviewer, opus) — Spec ⚠️, quality NEEDS FIXES. 1 Important, 3 Minor.
  The reviewer SPOT-CHECKED four of the eleven mutations itself rather than accepting the list,
  reproduced the failure counts exactly, and added a fifth of its own. Also verified precision at
  scale by hand: 999,999.99 lb at $0.0575/lb returns exactly 57500, no drift.
  Important (FIXED) — needsPrice read the row's LIST price instead of the price that actually
    RESOLVED. A break-only row (unitPrice null, minimumCharge null, one break at 100 @ $6.00,
    shipped 144) prices CORRECTLY at $864.00 — and still returns needsPrice: true. The flag is
    load-bearing: spec §5 refuses Finalize while any line has needsPrice, so a fully and correctly
    priced invoice could not be finalized, and the warning told the operator that an operation
    which HAS a price needs one. Both workarounds were bad (type a redundant list price onto a row
    that deliberately prices by break only, or hand-edit and flip priceSource to MANUAL, removing
    it from regeneration). Reachable, not hypothetical — part-prices.ts makes unitPrice optional
    and only refuses LOT-with-breaks.
    AND THE SUITE COULD NOT TELL THE TWO READINGS APART: the reviewer applied the fix and all 63
    still passed. So the fix was only half the job; the discriminating test was the other half.
    Plan-mandated in the letter (brief:393 states the literal condition) but NOT in the intent —
    needsPrice means "this line has no price" and a break-only row HAS one. Treated as a plan
    defect the controller corrects, not a deviation by the implementer. Fix wave commit 96026bc,
    RED "expected true to be false" against the old condition, GREEN after. 64 tests, suite 1567.
  SPEC CONTRADICTION RESOLVED WITH EVIDENCE, not escalated. The implementer flagged that the P5A
    spec's basis pseudocode (PER_100 -> qty/100, thresholds compared against basis) contradicts
    owner ruling 2C-2 §3.1 ("a per-each / per-100 / per-1000 part's break thresholds are PIECES").
    I was ready to put this to the owner as a money decision — a PER_100 row with a 500 break and
    1,000 pieces shipped either takes the break or does not. The reviewer settled it on evidence:
    prisma/schema.prisma's PartPriceBreak.threshold column CITES THE 2C-2 RULING BY NAME, so the
    ruling governs and the spec's pseudocode simply conflated the extension basis with the
    break-comparison basis. Spec amended (§6, dated 2026-08-07) to write the two bases separately;
    no total moves for a row without breaks. It also corrected the section number both the
    implementer and I had wrong — the pseudocode is §6, not §5.
  Minors 2 and 3 fixed (purity regex widened to catch require()/dynamic import(); roundCents's
    assumed input precision documented — it can round 12.344999999999999 up to 12.35, unreachable
    from this module's own inputs but it is EXPORTED for callers who compute their own floats).
  Concerns 1 and 3 ruled correctly Task 11's, and folded into its plan section: every CHARGE line
    arrives with a null GL (the engine cannot reach BillingConfig without breaking its purity
    contract, so Task 11 must assign otherChargeGlAccountId), and glAccountName's ?? "" is a
    CORRECT normalization since InvoiceLine.glAccountName is NOT NULL.
  ⚠️ resolved by the controller and folded into Task 11: zero shipped quantity bills the FULL
    minimum plus setup ($675 at qty 0, pinned deliberately as the spec's formula). Task 9's report
    asserts Task 11 only feeds non-zero net lines — that assertion is now an explicit, testable
    requirement on Task 11 rather than an assumption spanning two tasks.
Task 9: complete (commits 8227931..96026bc, Important closed with a discriminating test)

Task 10: dispatched (implementer, OPUS) — BASE 24aed12, brief task-10-brief.md.
  CONTROLLER ERROR in the dispatch, caught by the implementer: my scene-setting prose described
  Task 10 as the order-pricing layer that "feeds the engine real data". That is TASK 11. The brief
  and plan (line 1510) both say Task 10 is `invoice-guards.ts` + the new order/shipment invariants.
  The implementer read the brief FIRST (as the template instructs), built the brief, and flagged
  the mismatch rather than trying to reconcile my prose — exactly right. The brief is the source of
  truth and it won; nothing in the commit touches the pricing seam. Lesson: the dispatch's prose is
  scene-setting, the brief is the contract — when I get the prose wrong, a good implementer follows
  the brief. (My prose being wrong cost nothing here only because the brief was right and the
  implementer trusted it over me.)
Task 10: implementer DONE_WITH_CONCERNS — commit cfc904c, invoice-guards.ts + guards threaded into
  the brief's five mutators (replaceCharges, voidOrder, voidShipper, replaceShipperLines,
  addOrderToShipper). 17 new tests, full suite 1584, tsc+eslint+build clean. E2E correctly SKIPPED
  and said so — service-layer only, and nothing browser-reachable can create a FINALIZED invoice
  yet (that is Task 11+), so no flow could exercise a single new refusal. 12 mutation checks run,
  all caught, two tests strengthened first.
  FOUR concerns, all disclosed, none acted on unilaterally:
  1. Four shipment mutators unguarded and not in the brief; two flagged as likely real holes
     (removeOrderFromShipper, updateShipper). The implementer explicitly did NOT expand scope —
     "undisclosed scope expansion is its own failure mode" — and asked the controller to rule.
     That restraint is correct; a plan hole is the human's call, per the skill.
  2. The shipment guard batches over the whole shipment, so an invoiced order A blocks correcting
     order E's grid on the same truck. Conservative on purpose (over-blocks, never under-blocks).
  3. voidOrder's guard runs before shipmentBlockers, so the message names the invoice rather than
     sending the user to void a shipment voidShipper would then refuse. Pinned by a test.
  4. Task 13's finalize/unlock MUST claimOrder first or the guards' freshness argument fails.
Task 10: CONTROLLER RULINGS on the concerns:
  #1 — VERIFIED both holes myself before ruling (read removeOrderFromShipper and updateShipper in
     full, not just the implementer's description). removeOrderFromShipper strips an order's
     shipped qty and is the exact mirror of the guarded addOrderToShipper — sibling-split, the
     defect this project keeps paying for. updateShipper patches billFreight/freightAmount, both
     billed. Both already claim the shipper, so the guard has a claimed row to hang off. RULED:
     guard both; leave the two packaging mutators (containers/serials) unguarded WITH a comment,
     since neither changes a billed qty/weight. Fix wave 59dcdca.
  #2 — accepted as the brief's shape; safe (over-blocks). Flagged for the whole-branch review / an
     owner UX call rather than changed now.
  #3 — accepted; sound and tested.
  #4 — folded into Task 13's plan section (claim the order in claimOrdersInOrder order at the top of
     both finalize and unlock, before reading or writing invoice state).
Task 10: fix wave 1 (sonnet) — commit 59dcdca. removeOrderFromShipper guards the removed order;
  updateShipper's guard is SCOPED to billFreight/freightAmount with a passing negative test proving
  a comment-only edit on an invoiced shipment still succeeds (without that negative, a
  refuse-everything guard would pass too). Both packaging mutators carry a comment explaining why
  they are deliberately not guarded (pricing bills off shippedQty/shippedWeight alone, never off
  containers or which serials were attached). Controller ran the gates: 1588 tests, tsc/eslint/
  build clean, guards verified scoped in the diff. (Implementer stalled on a background test run —
  fourth in a row — controller ran gates and committed.)
Task 10: review dispatched (task-reviewer, opus — money-adjacent concurrency guards; verifying each
  reads invoice state UNDER the claim, the updateShipper scoping, the packaging ruling, and the
  Task 13 cross-task dependency note)

Task 10: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 2 Minor.
  The reviewer VERIFIED the packaging-mutator ruling against the code rather than accepting it:
  pricing.ts's PricingInput has no container/serial field, and ship-ledger.ts selects only
  orderLineId/qty/weight from ShipperLine — so neither packaging mutator can touch a billed
  quantity. Confirmed every guard reads finalized state UNDER its claim (the print-vs-void defect
  class from Phase 4, avoided here), and ran its own mutation spot-checks: blanketing
  updateShipper's guard fails the comments-allowed negative; batching removeOrderFromShipper fails
  the clean-removal negative; deleting the voidShipper guard fails its refusal test. Scope
  decisions are pinned, not merely present.
  Two ⚠️ cross-task seams, both mine and both already held: freight must bill FROM
  Shipper.freightAmount/billFreight into PricingInput.freight (Task 11 — the updateShipper scoping
  is correct only if it does), and finalize/unlock must claimOrder before flipping Invoice.status
  (Task 13 — documented in finalizedInvoiceFor's doc comment AND folded into Task 13's plan).
  DEFERRED to whole-branch triage (both Minor, both message/consistency, neither correctness —
  stopping-rule discipline: an approved task does not get another fix+re-review cycle for polish):
    M1 — removeOrderFromShipper runs its printed-paper check BEFORE its invoice guard, so an
      invoiced+printed order gets the two-hop runaround (told to void the shipment, which then
      refuses naming the invoice) that voidOrder's ordering was specifically designed to avoid.
      Removal is still correctly blocked; message quality only. One-line reorder if picked up.
    M2 — batched (voidShipper/replaceShipperLines/addOrderToShipper) vs precise
      (removeOrderFromShipper) guard scoping is internally inconsistent: a user can fully REMOVE a
      clean order B from an invoiced-sibling truck but cannot EDIT B's lines. Reviewer ruled
      acceptable — every path over-blocks, never under-blocks; the brief's literal shape; unlock
      undoes it. Recorded for the record, not for a fix.
Task 10: complete (commits 24aed12..59dcdca, review clean — approved first pass)

Task 11: dispatched (implementer, OPUS — money-critical: pricing becomes a real invoice) — BASE
  907f25c, brief task-11-brief.md (356 lines), carrying the three seams folded in from Tasks 9-10.
Task 11: implementer DONE — commit efe54bc, invoices.ts (+614) + tests (+398). 17 new tests, full
  suite 1603, gates clean. REPORTED PROMPTLY (broke the four-in-a-row stall). Three seams handled
  and each pinned: CHARGE lines get BillingConfig.otherChargeGlAccountId; surcharge glAccountName
  ?? "" (compile-enforced); zero-net lines skipped (a $600-minimum line contributing nothing keeps
  the total at $100, the correct discriminator). The row-lock concurrency test discriminates —
  deadlock with claimOrder removed, clean refusal restored.
  Implementer flagged multi-order freight as a possible over-bill, deferring it to "the §5 grouping
  task".
Task 11: CONTROLLER — the freight concern is NOT a later task's; the spec explicitly says there IS
  no grouping task (ruling 5: one invoice per order, §7.6 grouping SUPERSEDED). It is a genuine
  contradiction in the spec: ruling 5 (per-order invoicing) vs the freight rule §582 (each order's
  invoice sums its shipments' billFreight) — and a Shipper carries ONE freight amount for the whole
  truck, so N orders on one billable-freight truck each bill the full freight, an N× over-bill.
  I verified the spec myself before ruling, then put it to the OWNER as a billing-policy decision
  (four options: single-order-only / freight-on-one-order / split / defer).
  OWNER RULING 2026-08-07: DEFER. "We do not pay for freight at my work. So will probably have to
  look into how other shops do it." The shop does not bill freight, so the over-bill is LATENT for
  this deployment — no billable-freight-on-a-multi-order-truck data exists to be wrong. Recorded as
  a dated amendment beside the spec's freight rule AND in HANDOFF §6. Do not invent a split; when
  picked up it must sum back to the truck's exact freight once. The code is spec-faithful to §582
  (reviewer confirmed: sums live shipments' billFreight, deduped by shipper, no split) so nothing
  changes in the code now.
Task 11: review — Spec ✅, quality APPROVED. 1 Important, 4 Minor. Money verified correct end to
  end (tax base excludes freight and only freight; customer-rate-over-plant precedence pinned at
  $5.40 on $135 @ 0.1-over-0.04; every line maps to the right column/scale). Candidacy exact,
  idempotency via findFirst (not findUnique) against the partial index, row locks right, audit
  after-snapshot carries every line amount + total with orderBy on the lines collection.
  Important (FIXED) — createInvoiceInTx ran SERIALIZABLE but called assertRefExists for NONE of its
    registered FKs. Backwards: in this codebase Serializable-on-a-writer exists specifically to
    pair with assertRefExists (the FK-writer pattern), spec §5.1 names the three FKs, and the
    createShipper precedent guards its carrierId. The implementer kept the isolation and dropped
    the guard — the isolation cost without the protection it buys. Reviewer's concrete concern: the
    config GL read does not filter deletedAt, so a soft-deleted GL could in principle reach a line.
    RULING: add the guards. Spec-mandated, cheap, precedent exists, and the guard is the local
    permanent protection rather than depending on a distant blocker (BILLING_CONFIG_BLOCKER) staying
    in place. Not over-fixing — over-fixing adds what the spec did NOT ask for; this adds what it
    explicitly did.
Task 11: fix wave 1 (sonnet) — commit 556e367, 20/20 in-file, full suite 1608. Guards every
  distinct glAccountId/processStepCodeId/surchargeId on tx after the claim, PLUS
  BillingConfig.certChargeStepCodeId (which never lands on the CERT line's own column but is still
  referenced — the implementer caught that itself). Soft-deleted-GL refusal proven: 400 "That gl
  account does not exist", zero invoices written. Also fixed the empty-partNumber CHARGE warning,
  a redundant GL-name query, and added a renderAddress test. Reported promptly.
Task 11: DEFERRED to whole-branch triage — listPartPrices called without tx inside the Serializable
  transaction (reads the global singleton, opens a second connection, could disagree with a
  concurrent price edit). NOT folded in: fixing it means threading tx through Task 4's shared
  listPartPrices signature and its callers, out of scope for a Task 11 polish; the order claim +
  Task 10 invoice guards keep the practical window narrow. Plus: billTo/shipTo rendering and the
  no-GL warning path had thin coverage (renderAddress now tested in the fix wave).
Task 11: re-review dispatched (task-reviewer, sonnet — scoped to the FK-guard completeness,
  placement under the claim, and the three minors)
Task 11: re-review — Spec ✅, quality APPROVED, 0 findings. The reviewer proved the guarded FK set
  COMPLETE by cross-checking InvoiceLine/Invoice's FK columns in the schema against the registered
  BlockerTargets in reference-links.ts (only glAccountId/processStepCodeId/surchargeId qualify;
  orderLineId/orderChargeId target non-reference child rows read live under the same claim), and
  confirmed the cert-step-code special case closes a real gap (buildPricingInput's own
  processStepCode.findFirst does not filter deletedAt). Spot-checked load-bearing: disabled the
  three guards → soft-deleted-GL test went red, invoice silently created against the dead account
  ($937.44); restored → 20/20 green, clean tree. Placement, dedup, and all three minors verified.
Task 11: complete (commits 907f25c..556e367, re-review clean — approved)

Task 12: dispatched (implementer, OPUS) — BASE 556e367, brief task-12-brief.md.
Task 12: implementer DONE — commit cb66551, invoices.ts (+484/-59) + tests (+162). 8 new tests
  (28/28 in file), full suite 1616, gates clean. Reported promptly.
  ANTI-DRIFT handled the right way: extracted the create path's engine->line mapping into shared
  helpers (mapComputedLines, assertLineRefs, wireComputedParents, totalsFromLines) that BOTH
  createInvoiceInTx and recalculateInvoice call — no second pricing path to fork. Proven by a
  deep-equal test: recalc, then discard + re-create as baseline, and the derived lines match
  including amounts/GL. The -59 is that refactor of Task 11's already-approved create path —
  flagged to the reviewer as the regression risk (extraction must be behavior-preserving).
  Draft-only: claimLiveInvoice (models claimLiveShipper) claims the order then FOR UPDATE on the
  invoice, refuses FINALIZED (400, named) and discarded (404); all four mutators go through it.
  Two concerns, both disclosed: (1) the spec doesn't enumerate editable header fields; it chose
  poNumber/invoiceDate/termsName/billTo/shipTo, excluding identity/totals/lifecycle — a sensible
  default, sent to the reviewer to rule on rather than to the owner (a one-line change if wrong,
  and the owner said not to ask for routine calls). (2) recalc refreshes header taxRate but
  preserves descriptive header snapshots so an edited PO survives — flagged as intended.
Task 12: review dispatched (task-reviewer, opus — the create-path refactor must be
  behavior-preserving, the anti-drift deep-equal must cover money fields, draft-only guards under
  the claim, assertRefExists on the new write paths)
Task 12: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 3 Minor.
  The reviewer verified the create-path extraction is FIELD-FOR-FIELD behavior-preserving
  (mapComputedLines identical to the prior inline lineData incl. the CHARGE-GL seam; assertLineRefs
  reproduces the FK-guard loop; create's totals path untouched), and proved anti-drift discriminates
  by mutating recalc's derived amounts +$0.01 → the "no drift" test went red on both PART and
  OPERATION lines, reverted clean. Draft-only guard confirmed discriminating (neutered the FINALIZED
  throw → test 1 red). Precision exact against every column (and noted the brief mislabeled
  breakThreshold as 12,4 — it is 12,2 in the schema; the code follows the schema).
  BOTH report concerns ruled sound: the editable-header set includes invoiceDate (spec §4 line 453
  mandates it editable while draft) and exposes no immutable field; recalc refreshing taxRate is
  correct (it is inseparable from the regenerated TAX line) while preserving edited PO/terms/addrs.
  3 Minors DEFERRED to whole-branch triage (all coverage/polish, none correctness — the shared
  helper makes the drift they'd guard structurally impossible): anti-drift test compares a subset
  of money fields (omits position/unitPrice/rate/glAccountId); no audit-CONTENT assertion on the
  replace/recalc paths specifically (update and discard have theirs); materialName/processNames
  header snapshots are write-once at create, so a re-priced invoice can show a stale process-name
  summary while its OPERATION lines regenerate fresh (display-only, no money impact).
  THREE cross-task ⚠️ items folded into the tasks that own them (controller):
    - Task 13: unlock MUST set status back to DRAFT, or Task 12's FINALIZED-only refusal keeps
      every edit blocked and "unlock" does nothing actionable. Added beside the existing
      claim-before-finalize note.
    - Task 16: money-changing invoice routes (lines/recalculate/credit) need change_prices, not
      just invoicing.edit; the service layer deliberately does not gate it, so the route is the
      only backstop. The 401/403 sweep must discriminate (invoicing.edit-without-change_prices
      refused by those routes, accepted by the header PATCH).
    - Task 19: printInvoice must claim the invoice row FOR UPDATE before inserting the
      StoredDocument — the print-vs-discard serialization, the Phase 4 print-vs-void lesson.
Task 12: complete (commit cb66551, review clean — approved first pass)

STALE-CONSTRAINTS DEFECT FOUND (2026-08-07, controller). The `.superpowers/sdd/global-constraints.md`
  I was handed at session start and pointed implementers/reviewers at is **PHASE 4's** — left at the
  old flat ledger path, never updated for 5A. Its owner-rulings bullet says "void only, NO REVERSING
  SHIPMENTS, REOPENED stays unreachable." The 5A spec REPEALS that: §5.2 line 356 "INVOICED and
  REOPENED become reachable", line 430 "finalizing an INVOICE writes INVOICED", and Task 15 IS the
  reversing shipment. Caught when Task 13's commit message ("INVOICED and REOPENED become reachable")
  contradicted the constraint I thought was binding — I verified the spec before reviewing rather
  than flagging the implementer, and the implementer was RIGHT (spec-mandated).
  Blast-radius assessment: NO harm to Tasks 1-12 — none touched reversing shipments or the
  invoice-owned statuses, the durable technical constraints in the Phase 4 file are all still
  accurate, and every task's brief (extracted from the 5A plan) carried the correct phase-specific
  requirements, which is the source of truth an implementer follows. The live risk was Task 15
  being reviewed against "no reversing shipments." Fixed: wrote a correct Phase 5A
  global-constraints.md at the phase ledger (durable technical constraints restated + 5A's actual
  owner rulings incl. INVOICED/REOPENED invoice-owned, the reversing shipment reusing void_shipper,
  one-invoice-per-order/no-grouping, the freight deferral). Tasks 13-20 point at THAT file; the
  Phase 4 one is not cited again. LESSON: a "global constraints" file is phase-scoped context that
  can go stale like any other; verify a surprising constraint against the phase spec before trusting
  it, and the phase spec/brief outranks a leftover constraints file.

Task 13: dispatched (implementer, OPUS) — BASE cb66551, brief task-13-brief.md (carries the two
  folded-in requirements: claim-before-flip, unlock->DRAFT).
Task 13: implementer DONE — commit 9ddc2db, invoices.ts (+133) + ship-ledger.ts (+24) + tests.
  Full suite green, gates clean, reported promptly. INVOICED/REOPENED now reachable (spec-mandated).
  finalize/unlock share claimInvoiceRow (order claim -> invoice FOR UPDATE); Read-Committed
  concurrency test RED with the claim removed. unlock->DRAFT proved by all four Task-12 edits
  refusing while finalized and succeeding after unlock. finalize refuses on needsPrice (resolved
  price, so a break-only line does not block), freezes, re-prices nothing.
  Two disclosed concerns: (1) the recompute skip stayed order.status-based (ship-ledger tests
  demand it) and unlock un-invoices via a `released` escape-hatch param on recomputeOrderStatus —
  this is spec-correct (§5.2: skip while invoice-owned; unlock calls recompute to return
  ship-derived), sent to the reviewer to confirm ONLY unlock passes `released`. (2) added a
  voided-order refusal to finalize beyond the brief's steps (consistent with create/recalculate,
  upholds §5.7, and needed to make the claim test discriminate on outcome) — disclosed, sent to
  review to rule on as scope.
Task 13: review dispatched (task-reviewer, opus, pointed at the CORRECT 5A constraints file — the
  status-ownership skip vs arithmetic status, the `released` escape-hatch being unlock-only, both
  transitions claiming before the flip, unlock->DRAFT, needsPrice freeze)
Task 13: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 3 Minor.
  THE IMPLEMENTER CAUGHT A BROKEN BRIEF. The brief's literal step-5 code
  (recomputeOrderStatus(tx, [orderId]), 2-arg) would have stranded orders at INVOICED FOREVER:
  unlock clears the invoice's status but the ORDER is still INVOICED when recompute runs, so the
  status-based skip skips it. The `released` third arg is the minimal correct repair, and the
  reviewer grep-verified it is confined to unlock — all eight shippers.ts and three orders.ts
  recompute sites use the 2-arg form, so no shipment path can drop INVOICED. All six hard checks
  pass; claim-before-flip on both transitions; unlock->DRAFT restores all four Task-12 edits;
  needsPrice reads the resolved price and finalize freezes (edited $1 line stays $1).
  Voided-order-refusal addition RULED in-scope and correct (consistent with create/recalculate,
  §5.7). Status skip confirmed status-OWNERSHIP not arithmetic (ship-derived derivation untouched).
  3 Minors DEFERRED to whole-branch triage: unlock's audit test asserts reason + end-state but not
  the status before/after diff (finalize covers that pattern); the brief's mandated ordering test
  was correctly NOT added because the `released` design makes the ordering non-load-bearing (a test
  that can't discriminate) — I ACCEPT that design change as controller, it repairs a broken brief;
  and the finalizeInvoice(id, tx?) seam used only by the concurrency test.
  TWO cross-task ⚠️ folded into the tasks that own them:
    - Task 15: the reversing shipment writes REOPENED DIRECTLY and must NOT pass `released` to
      recomputeOrderStatus (that would re-open the exact hole the skip closes).
    - Task 16: finalize/credit routes call the NO-tx service form (the tx? overload bypasses the
      Serializable + withDbErrors bracket) — added beside the change_prices note already there.
Task 13: complete (commit 9ddc2db, review clean — approved first pass)

Task 14: dispatched (implementer, OPUS) — BASE 9ddc2db, brief task-14-brief.md.
Task 14: implementer DONE — commit 7af7c00, invoices.ts (+146) + tests (+139). 11 new tests, full
  suite 1641, gates clean, reported promptly.
  CROSS-TASK CORRECTNESS CATCH: the brief assumed Task 13's finalize already branched on `kind`,
  but it wrote Order.status = INVOICED UNCONDITIONALLY. Left as-is, finalizing a CREDIT would have
  written INVOICED to the order, violating spec §5.2 ("finalizing a CREDIT changes no order
  status"). This is a LATENT defect in already-approved Task 13 code that could not manifest until
  credits existed — Task 13's review could not have caught it (no CREDIT to finalize). The
  implementer added `if (invoice.kind === "INVOICE")` around the order write, proven RED on both
  branches. The "property untestable in Task N becomes testable in N+1" pattern, exactly.
  Sign flip: amounts negate, qty/weight stay as billed, total negative, header+lines share one
  sign (totalsFromLines over the negated lines); negateMoney normalizes a zero line's -0 to +0.
  FINALIZED-INVOICE-only: refuses DRAFT source, CREDIT source, voided order — each named, read
  under claimInvoiceRow. credit_number from allocateNumber; CREDIT coexists live with its source
  INVOICE (partial index scoped to kind='INVOICE'). Anti-drift: reuses claimInvoiceRow/
  assertLineRefs/totalsFromLines/wirePayloadParents (widened to a structural {key,parentKey}); does
  NOT use mapComputedLines (credit lines are stored rows, not engine output).
  Disclosed concern: the credit copies the source's invoiceDate verbatim (brief said "copy every
  header snapshot") rather than stamping today. 5A has no aging machinery (5B), so date is
  display-only now; sent to the reviewer to rule on, flagged for the owner demo rather than a
  mid-flow interrupt (one-line change, brief-faithful as built).
Task 14: review dispatched (task-reviewer, opus — the Task-13 finalize kind-guard fix on the
  money-status path, the sign flip incl. -0, FINALIZED-invoice-only refusals under the claim,
  anti-drift reuse, and the CREDIT/INVOICE coexistence)
Task 14: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 3 Minor. The reviewer proved
  the Task-13 kind-guard discriminating in BOTH directions itself (mutated to if(true) → both
  credit-branch tests red; if(false) → Task 13's INVOICE test red; clean-tree revert, 50/50). Sign
  flip drift-proof (totals from the already-negated lines, -0 normalized to +0), refusals read
  under claimInvoiceRow, coexistence verified against the real partial index (kind='INVOICE'), and
  it confirmed createCredit has NO tx? seam so no bypass footgun. invoiceDate verbatim-copy ruled
  acceptable for 5A (brief-mandated, cosmetic only — printed credit bears the source's date), filed
  in spec §16 for 5B to decide issue-date semantics.
  3 Minors DEFERRED to whole-branch triage: no credit-specific test for the copied-FK guard (rests
  on inherited create/replace coverage); the audit-content assertion is a stringify-contains rather
  than a structural field check; and the invoiceDate 5B note (now in spec §16).
  Both ⚠️ downstream seams already covered: the credit ROUTE's change_prices gate is in Task 16's
  folded note (it names lines/recalculate/credit); credit page/print rendering is Tasks 17-19.
Task 14: complete (commit 7af7c00, review clean — approved first pass)

Task 15: dispatched (implementer, OPUS — one of the phase's most dangerous: negative-qty lines,
  REOPENED status, shared claim path) — BASE 7af7c00, brief task-15-brief.md (carries the
  REOPENED-direct / no-`released` requirement).
Task 15: implementer DONE_WITH_CONCERNS — commit dddf064, shippers.ts (+235) + ship-ledger.ts +
  reverse route + tests. 12 reverse tests + 1 route-permission test, full suite 1654, gates clean.
  E2E correctly skipped (route is the only surface, no page wired). Reported promptly.
  REOPENED written DIRECTLY (auditedUpdate on order); seam test proves the invoiced order never
  reaches recomputeOrderStatus and `released` is always []. Net shipped total drops (negated lines
  share orderLineId → nets to 0), with a below-zero guard refusing a second reversal. Claim
  serializes (claimOrdersInOrder + claimShipperRow; RED with the claim removed).
  SPEC-VS-BRIEF CONFLICT RESOLVED ON EVIDENCE (concern 1): the brief's illustrative test expected
  OPEN for a NON-invoiced reversal; the implementer implemented SHIPPED and flagged it. I verified
  §5.2 myself: OPEN/PARTIAL_SHIPPED/SHIPPED are ship-derived from the human line-complete flags and
  "quantities never enter this decision" — a reversal adds negative-qty lines without touching those
  flags, so recompute derives SHIPPED. The brief's OPEN would require quantities to drive status,
  which the spec forbids. Implementer followed the BINDING SPEC over the brief's illustrative test —
  correct precedence. No owner question needed (the spec resolves it); flagged for the Task 20 demo
  as a behavior to confirm in context, since "reverse a shipment, order still shows SHIPPED" may
  surprise a user — but that would be a spec amendment to the derivation rule, not this task's call.
  Two conservative spec-silent refusals (concern 3): reversing a voided original → 404, reversing a
  reversal → 400 (avoid netting a different shipment / driving the ledger up). Sent to the reviewer
  to rule on as scope.
Task 15: review dispatched (task-reviewer, opus — grep that no shipment path passes `released`, the
  SHIPPED-vs-OPEN resolution being genuinely spec-DERIVED not hardcoded, the below-zero netting
  guard, claim discipline, and the two conservative refusals)
Task 15: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 3 Minor. The reviewer
  grep-verified the whole codebase: the only 3-arg recomputeOrderStatus call is unlock
  (invoices.ts); every shippers.ts site incl. the new one is 2-arg — so REOPENED can only be the
  direct write, confirmed by a discriminating seam test. SHIPPED confirmed genuinely FLAG-DERIVED
  (the original line stays live and lineComplete, so recompute derives SHIPPED — not hardcoded).
  Both conservative refusals RULED correct and in-scope: a voided original already contributes 0
  (re-shipping its negatives would net down a DIFFERENT shipment), and reversing a reversal negates
  negatives → drives the ledger UP (a phantom re-ship the spec gives no path for; undo a mistaken
  reversal by voiding it). Below-zero guard sound; concurrency test discriminates (competitor at
  Read Committed). REOPENED scoped strictly to a finalized INVOICE (a finalized CREDIT never
  triggers it). Numbering clean.
  3 Minors DEFERRED to whole-branch triage: a spurious cert/serialization warning on a reversal
  RESPONSE (the reversal has no cert of its own; advisory-only, never blocks, but noise on a
  correction document); the create-entry audit content is not test-asserted (only the REOPENED
  order-update entry is); the claim choreography is inlined rather than reusing claimLiveShipper
  (justified — the reversal needs a wider include — but a second copy to keep in sync).
  Two ⚠️ carried to later tasks: when the reversal UI lands (Task 17/18), §5.16 disabled-with-
  tooltip on void_shipper + an E2E flow; and the spec-silent header choices (reversal copies no
  freight/containers/serials, creates no cert) are owner-demo confirmation items (Task 20), not
  defects — defensible (a reversal is a ledger correction, not packaging).
Task 15: complete (commit dddf064, review clean — approved first pass)

Task 16: dispatched (implementer, sonnet — route wiring on established patterns; the permission
  discrimination is the crux) — BASE dddf064, brief task-16-brief.md (carries change_prices split
  + no-tx form notes).
Task 16: implementer DONE — commit c737322, 10 route files + invoices.ts (+72 read helpers) + the
  sweep + invoice-routes.test.ts (+409). 12 route tests, full suite 1667, gates clean. E2E skipped
  (no page yet). Reported promptly. Discrimination proven (deleted mustDo change_prices from lines
  → the edit-only 403 assertion failed; restored → green).
  Implementer flagged concern 1: the brief's per-route TABLE said recalculate=edit-alone and
  credit=create-alone, contradicting the brief's own binding header note AND spec §5.5. It resolved
  toward the spec (added change_prices to both) and flagged it.
Task 16: CONTROLLER VERIFICATION of the gates against the BINDING SPEC (§5.5/§5.6), before review —
  because these are the only authorization on the invoice surface and two are contested:
  - unlock = mustDo("unlock_invoice") + reason (§5.5 line 483). The implementer used unlock_invoice;
    MY OWN folded note (Tasks 13/16) wrongly said unlock=invoicing.edit. The implementer followed
    the SPEC over my note — correct. Recording my note's error so it doesn't propagate: finalize is
    invoicing.edit, but UNLOCK is the unlock_invoice special action.
  - recalculate = invoicing.edit + change_prices — spec-correct (recalculate replaces every derived
    line = changes money = the §5.5 general rule). The brief's table was stale; implementer right.
  - credit = GENUINELY AMBIGUOUS, sent to the reviewer to adjudicate against §5.6's actual text.
    §5.6 says a credit's "permissions are the invoice's", and raising an invoice is invoicing.create
    ALONE (§5.5, amounts derived not user-set) — a credit's lines are likewise derived (negated from
    source), so a literal read says the credit-creation route is invoicing.create ALONE, matching the
    brief's original table. The implementer added change_prices; TWO prior reviews (Task 11, Task 14
    ⚠️) and MY folded note asserted credit needs change_prices citing "§5.6" — but §5.6's text says
    the opposite. Did not pre-decide: the reviewer reads §5.6 and rules. If create-alone, the added
    change_prices comes off; if create+change_prices, it stays with the reasoning recorded.
    LESSON: three sources (two reviews + my note) asserted a gate citing a spec section whose text
    contradicts them — a citation is not a quote; check the section actually says what the citation
    claims, especially on a money gate.
Task 16: review dispatched (task-reviewer, opus — every gate vs the spec, the credit-gate
  adjudication against §5.6, discrimination of the money-route 403s, the sweep not weakened,
  no-tx form on every route)
Task 16: review — Spec ⚠️ (11 of 12 gates spec-correct), quality NEEDS FIXES. 1 Important, 1 Minor.
  The reviewer RULED the credit gate = invoicing.create ALONE, reading §5.6's actual text ("a
  credit's permissions are the invoice's") against §5.5 (invoice creation = create alone, amounts
  derived). Inputs→harm: a subject with invoicing.create but not change_prices can raise an invoice
  (POST /api/invoices needs only create) but was 403'd on the corrective credit — the asymmetry
  §5.6 forbids. It also CONFIRMED the implementer's unlock=unlock_invoice was right and my folded
  note (unlock=invoicing.edit) was wrong, and that recalculate correctly carries change_prices.
  Discrimination verified live (removed a mustDo → the specific 403 assertion redded).
  Important (FIXED, commit 685e9bf): credit route now gates invoicing.create alone; dead mustDo
  import removed; test flipped (createOnly → 200, no-create → 403 kept so create still discriminates,
  proven by removing the gate → 403→200). Full suite 1667 green, tsc/eslint clean.
  Minor DEFERRED: the permission sweep is file-level not handler-level, so a NEW handler bolted onto
  an existing multi-verb route file with no gate would slip through (a brand-new route FILE is
  caught). Pre-existing, shared with the admin sweep; issue #35-class. Filed for whole-branch.
  CONTROLLER: corrected the plan's Task 16 note (it had asserted credit needs change_prices, and
  had unlock=invoicing.edit) so the whole-branch review isn't misled; struck both errors with the
  §5.6 reasoning and the "a citation is not a quote" lesson.
Task 16: complete (commits dddf064..685e9bf, review clean after the one-gate fix)

Task 17: dispatched (implementer, sonnet — UI on the ShippingList precedent) — BASE 685e9bf,
  brief task-17-brief.md.
Task 17: implementer DONE — commit e138f04, invoicing/page.tsx + InvoicingList.tsx (+317) + export
  route. Full suite 1667, gates clean, E2E 15/15 (no new flow — that's Task 20). Reported promptly.
  Thorough browser verification via real fetch/DOM against the authenticated session (pane can't
  composite — 0x0 viewport confirmed): seeded 5 real SHIPPED uninvoiced orders, candidates appeared,
  tick+Create moved them to Invoices, a FRONT-of-loop failure still let a later order succeed with
  the error beside the failed row (which stayed a candidate, re-tickable — §5.13 reload-then-report),
  filters narrowed per network request, export downloaded a real 6.8KB valid xlsx honoring the
  filter, and a view-only user saw checkbox+Create disabled with title "Requires invoicing.create"
  (not hidden). Fixtures cleaned via app APIs, 0 live rows after.
  Commit scope clean — the report stayed untracked (implementer said "committed as required" but the
  actual commit is 3 erp/src files only; report not in it).
  Concern (non-blocking): Invoices show total 0.00/needsPrice because the DEV DB has no PartPrice
  fixtures — out of scope, expected.
Task 17: review dispatched (task-reviewer, opus — the four UI defect-classes this phase already paid
  for: empty-list impersonation, stale-response race, §5.16 gating, per-order-independent create;
  plus the export honoring the filter and the client/server boundary)
Task 17: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 3 Minor. The reviewer
  confirmed all FOUR paid-for defect classes are STRUCTURALLY prevented (the bar I set), reading the
  code not just the manual session: empty text gated on `loaded && !error` with dedicated per-list
  error banners (no swallow); both loads useLatest-ticketed checking isCurrent on success AND
  failure with `query` in the deps; controls disabled+titled never hidden; per-order create is a
  sequential try/catch-into-a-Map loop so a front-of-loop failure cannot abort it, failed ids stay
  ticked, §5.13 reload-before-report. Export route is the customers/export precedent line-for-line,
  gated invoicing.view, sharing the list route's exact filter parse so export and list can't
  disagree — not a dump-everything leak.
  3 Minors DEFERRED, all precedent-consistent: the export LINK is ungated (matches every other
  export in the app — ShippingList, customers/export; the route is gated, so gating just this one
  would make it the inconsistent one — the implementer correctly chose precedent over the dispatch's
  literal "gate export"); a customer-picker load failure can be clobbered by the shared error state
  (pre-existing, identical to ShippingList — not introduced here); and no vitest fence for the page
  (Task 20's E2E is the net).
Task 17: complete (commit e138f04, review clean — approved first pass)

Task 18: dispatched (implementer, sonnet — capstone UI on the ShipmentDetail precedent; the
  per-action gate table is the crux, front-loaded from Task 16's corrected route gates) — BASE
  e138f04, brief task-18-brief.md.
Task 18: implementer DONE — commit 18042ac, InvoiceDetail.tsx (+807) + page shell + InvoicesSection
  + hub wiring. Full suite 1667, gates clean, E2E 15/15 (new flow is Task 20). Reported promptly.
  Report untracked (commit is 4 erp/src files only). Exceptionally thorough browser verification:
  drove the FULL lifecycle end to end (create → edit line [priceSource MANUAL, needsPrice cleared]
  → recalculate [manual line preserved, derived regenerated] → finalize [order INVOICED, every
  control probed disabled with the right title] → unlock w/ reason [order SHIPPED, controls
  re-enabled] → raise credit [own page, sign-flipped] → discard w/ reason), and confirmed the
  DOUBLE-GATE title picks the actually-missing permission in BOTH directions using two throwaway
  restricted users (Requires change_prices vs Requires invoicing.edit). Hub section links both ways;
  Create-invoice disables once a live invoice exists. Fixtures cleaned, 0 live rows after.
  Per-action gate table as built matches Task 16's corrected routes: header edit / line+recalc
  double-gate / finalize edit / unlock=gateDo(unlock_invoice) / discard delete / credit=create
  ALONE / create-invoice create / print=view (404s until Task 19, by design).
  Disclosed design choice: editing a line's amount stamps priceSource MANUAL + clears needsPrice
  (not spec-mandated) — consistent with the server behavior Tasks 9/12 established (a manual line is
  preserved by recalculate); sent to the reviewer to confirm no client/server disagreement.
Task 18: review dispatched (task-reviewer, opus — every UI gate MATCHING its route gate [a money
  control enabled that the route refuses = Critical], status-locking on every editing control,
  the sibling-group hooks key=/useMutationGate/useEditGuard, and the MANUAL-stamp choice)
Task 18: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 4 Minor. The reviewer verified
  the gate table STRUCTURALLY, citing both file:lines for each: every UI gate matches its Task 16
  route gate, including the two mid-phase corrections (unlock=gateDo(unlock_invoice) not
  invoicing.edit; credit=invoicing.create ALONE not change_prices). Double-gate title correct in
  both directions in CODE (identical to PricingSection). MANUAL-stamp ruled consistent (it is the
  intended mechanism by which an operator-corrected amount survives Recalculate — Tasks 9/12 preserve
  MANUAL lines). key={id}, useMutationGate through load+every write, useEditGuard, §5.13 reload-then-
  report all confirmed. Status-lock complete with unlock/print/credit correctly exempt.
  Minor 1 (FIXED — it was the recurring empty-list-impersonation defect, and a sibling-split): the
  hub InvoicesSection rendered "No invoices raised yet" on rows.length===0 with no loaded/error
  guard, AND computed hasLiveInvoice from the empty rows so "Create invoice" stayed ENABLED on a
  SHIPPED order after a FAILED load — the operator could double-create. Task 17's sibling
  (InvoicingList) gates on loaded && !error; this diverged. Fixed to match: `loaded` flag,
  hasLiveInvoice = loaded && !error && …, empty text gated, Create disabled with "Could not confirm
  this order's invoice status" when unloaded/errored. Forced a real 500 to verify (error shows,
  "none yet" does not, Create disabled). Commit da5773a.
  Minor 2 (FIXED, same wave): Raise-credit was HIDDEN on a CREDIT (§5.16 says disabled-with-title,
  and the tooltip "A credit cannot itself be credited" was already computed = dead code). Now shown
  disabled with that tooltip.
  Minors 3-4 DEFERRED (draft-only cosmetic, disclosed): a hand-added CHARGE line appends after the
  TAX line (canonical-order §5.3, draft only); editing qty/weight on a derived line doesn't
  recompute amount until Recalculate (inherent to amount-is-king; operator controls amount directly).
Task 18: complete (commits 18042ac..da5773a, review clean after the two-minor fix)

Task 19: dispatched (implementer, OPUS — pdfmake-under-Node, the documents.ts CHECK, and the
  print-vs-discard concurrency) — BASE 18042ac, brief task-19-brief.md (carries the print-claim note).
Task 19: implementer DONE — commit e908b34, pdf/invoice.ts (+334) + print service/route +
  documents.ts + tests. Full suite 1683, gates clean, E2E 15/15. Reported promptly. No schema change
  (INVOICE/CREDIT already in the enum + CHECK from Task 2 — verified in the commit).
  E2E CAUGHT A REAL REGRESSION: completing KIND_LABELS changed the hub's document labels from raw
  enums to friendly text, and multi-order-shipment.mjs had the old strings hardcoded — the
  implementer updated the flow to the new labels. That is E2E doing its job (a required step changed
  a label a flow asserted).
  printInvoice claims the invoice row FOR UPDATE before storeDocument (claimInvoiceForPrint takes
  order+invoice, the same claim discard uses); concurrency RED proven (remove the claim → print
  resolves + archives for a concurrently-discarded invoice instead of rejecting /voided/). Reprint
  compares STORED bytes with Buffer.compare; fresh renders pinned by %PDF-/pageCount/content, never
  Buffer.compare'd. Discarded/voided refuses a NEW print (VOIDED_PRINT) while a stored print still
  downloads.
  Disclosed choice: a credit's PDF titles itself "Credit" not "Invoice" (§10 says "same layout",
  doesn't enumerate the title; a credit memo reading "Invoice" would be wrong). Sound default —
  accepting it, flagged for the owner DEMO (the owner reviews printed samples there and can reword,
  e.g. "Credit Memo"); one-line revert if they disagree. Sent to the reviewer to confirm it doesn't
  contradict §10.
Task 19: review dispatched (task-reviewer, opus — the print-claim-before-archive concurrency [RED
  with claim removed], the stored-vs-fresh byte-comparison direction, discarded-refuses-new-reprints-
  stored, the documents.ts filename cases, whether the E2E flow edit matches an intended label change
  vs hides a regression, and the credit title vs §10)
Task 19: review — Spec ✅, quality APPROVED, 0 Critical / 0 Important, 1 Minor. The reviewer
  INDEPENDENTLY removed the invoice-row claim and confirmed the concurrency test goes RED (print
  archived against a freshly-discarded invoice instead of rejecting /voided/), both sides at Read
  Committed so the row lock — not SSI — is the guarantee. Byte distinction verified NOT inverted
  (stored compared with Buffer.compare; fresh renders pinned by %PDF-/pageCount/content). Credit
  title ruled a sound reading of §10 (it lists "title and company" as a layout block, never mandates
  the string "Invoice"). E2E flow edit ruled a correct label-update, not a weakening (same
  assertion structure, friendly labels). documents.ts additions match the CHECK (INVOICE/CREDIT →
  invoiceId alone). No schema change.
  1 Minor DEFERRED → owner demo ping: negative money renders "$-937.44" (sign between $ and digits);
  unusual customer-facing form, Phase-7 template-editable, spec §10 only says "negative amounts".
  ⚠️ the Task 20 seam: no flow yet drives print→archive→reprint end to end — Task 20 adds it.
Task 19: complete (commit e908b34, review clean — approved first pass)

Task 20: dispatched (implementer, sonnet — the close-out: 16th E2E flow, demo, docs) — BASE 0060f1a,
  brief task-20-brief.md, carrying the accumulated demo pings.
Task 20: implementer DONE — commit 026ff4c. 1688 tests (109 files), gates clean, E2E 16/16 run 3×
  consecutively. Reported promptly.
  E2E flow drives the full lifecycle incl. print→archive: two-PartPrice order → ship complete →
  Ready-to-invoice → create → invoice shows 2 OPERATION rows + surcharge + tax → Finalize (lock,
  board Invoiced) → Print → document appears in the invoice's Documents list → Unlock w/ reason
  (board back to Shipped). Waits for post-navigation content (the doc-number badge), not the /new
  URL trap. Reaper un-widened, AuditLog sweep added for the new fixtures.
  GAP CLOSED, not worked around: the invoice page's Documents panel was calling
  GET /api/invoices/[id]/documents — a route Task 19's brief never listed and never built, so every
  real print left that panel 404ing. Task 20 built listDocumentsForInvoice + the route + tests
  (mirroring the shipper/cert precedent). This is NEW production code in the close-out task — the
  whole-branch review must cover it (route + service, not just docs/E2E).
  Demo doc (docs/2026-08-07-phase-5a-demo.md) NAMES all deviations, verified by rendering real PDFs
  vs the owner's sample (three named layout gaps): the freight deferral, reverse-leaves-SHIPPED,
  credit titled "Credit", "$-937.44" sign format, credit's copied invoiceDate.
  Docs drafted: CLAUDE.md (frozen-paper invoice reads, invoice-guards leaf, creditNumber sweep
  exemption), HANDOFF §4a (pre-merge scaffolding, condenses at merge per the split rule), §6 pings,
  §9 rewritten as the 5B kickoff carrying spec §16. Controller verified §4a factually accurate
  (deliverables, ruling numbers, freight deferral, the invoice-guards leaf, Task 2's snippet defect,
  the Task-20-found-Task-19 gap all correct).
  Disclosed: the tax fixture uses Customer.salesTaxRate rather than mutating the global BillingConfig
  singleton — a deliberate safety deviation (a shared-singleton mutation in a fixture could bleed
  across the serial suite); sound.
Task 20: complete (commit 026ff4c) — reviewed as part of the whole-branch pass, per the process.

=== PHASE 5A FEATURE-COMPLETE: all 20 tasks done, each through implement→review→fix→re-review or
    approved first pass. Next: the finish sequence — controller final gate run, then ONE whole-branch
    review on the strongest model (fed this ledger's deferred-minors as triage), one fix wave, the
    owner demo, the PR. ===

FINISH SEQUENCE
Controller final gate run (before the whole-branch review): 1688 tests / 109 files, tsc 0, eslint 0,
  build clean, E2E 16/16 (incl. the new invoice-shipped-order flow). Branch verified good, not taken
  on per-task-report trust.
Whole-branch review: ran as a WORKFLOW (ultracode on) — 4 dimension reviewers on opus/high, each
  over its own targeted diff of 712def3..HEAD (merge-base), focused on CROSS-TASK seams the per-task reviews
  structurally could not see. 27 load-bearing seams confirmed SOUND across concurrency (the claim
  discipline, the released-arg grep, print-vs-discard, the reversing shipment), money (anti-drift
  create/recalc/credit share one mapper, rounding order, tax base), permissions (the full corrected
  gate table route↔UI), and schema (both CHECKs, partial-unique, the CASCADE that can't fire).
  Findings: 1 Critical, 2 Minor.
  CRITICAL (CONFIRMED, the textbook whole-branch catch — invisible to every per-task review):
    recalculateInvoice had no kind guard. Task 12 built recalc assuming an INVOICE (re-derive from
    the order); Task 14 added CREDIT sharing the same page/route/lifecycle but never taught recalc to
    refuse it. Clicking Recalculate on a DRAFT CREDIT rebuilt its lines at full POSITIVE prices —
    a credit that should REDUCE the customer's balance instead ADDS to it, and finalizes+prints
    cleanly. No test, no guard at any layer. Neither task's review could catch it: credit didn't
    exist when recalc was reviewed; recalc wasn't re-examined when credit was added.
  MINOR 1 (CONFIRMED, data-integrity of audit history): SNAPSHOT_INCLUDE.partPrice.breaks had no
    deletedAt filter and ordered only by threshold (unique among LIVE rows only) — a break re-added
    at a soft-deleted break's threshold put two same-threshold breaks in the snapshot, spurious
    history diff + a deleted break the live UI never shows. Issue-#24 class.
  MINOR 2 (PLAUSIBLE, spec-silent — FILED for owner, NOT fixed): addLine/updateLine on an order with
    a finalized invoice aren't blocked by the §5.7 freeze (only replaceCharges/voidOrder are). §5.7
    enumerates charges/void/shipment-edit, not order-line edits; the invoice is frozen paper and
    self-corrects on unlock+recalculate, so no money error. The reviewer itself downgraded it to a
    note. Owner decides whether order-line edits should freeze too.
Fix wave 1 (whole-branch): the Critical + Minor 1. recalculateInvoice refuses kind=CREDIT
  (HttpError 400, named); InvoiceDetail's recalcGate disables Recalculate on a credit with a title;
  audit breaks include now `where: { deletedAt: null }, orderBy: [{ threshold: "asc" }]`. Both tests
  discriminate: the recalc-credit test asserts total −937.44 before, 400 on recalc, and lines
  UNCHANGED after (deep-equal) — RED if the guard is removed (recalc flips to +937.44); the audit
  test asserts the snapshot's breaks contains only the live one. (Fixer stalled on its test run —
  controller verified the fixes in-tree and ran the gates.)
Controller gate run on the fix (commit f9cbc8d): 1690 tests / 109 files, tsc 0, eslint 0, build
  clean, E2E 16/16. Committed.
Fix re-review (task-reviewer, opus, scoped to f9cbc8d) — Spec ✅, quality APPROVED, 0 findings.
  Independently ran BOTH revert-to-red spot-checks: neutralize the kind guard → the recalc-credit
  test reds with the credit re-priced to +937.44 (money-inverting bug reproduced); revert the audit
  filter → the part-prices test reds with breaks length 2. Both restored, tree clean. Confirmed
  REFUSE is correct per §5.6, and traced EVERY writer to establish NO remaining credit-sign-
  inversion path (createInvoice INVOICE-only, recalc guarded, replaceInvoiceLines is the line-edit
  path, createCredit refuses a non-INVOICE source, print reads stored negated lines) and no
  soft-deleted break reaches a user diff.

POST-DEMO OWNER RULINGS (2026-08-07, at the demo walkthrough):
- #2 freight deferral / #3 credit title "Credit" / #4 "$-937.44" format / #5 credit invoiceDate→5B /
  #6 the three PDF layout gaps: all approved/deferred as-built, NO code change (recorded in the demo doc).
- #1 REVERSING A SHIPMENT REOPENS THE ORDER — ruled and built. Owner's reasoning: a reversal is to
  correct qty/weight (reverse → correct → reprint the corrected ship ticket), so the order must
  reopen to be re-shippable. It is NOT the §5.2-quantity amendment I first feared: the clean fix is
  that a reversal clears the line-complete flag on the lines it reverses, and the EXISTING
  flag-derivation reopens the order to PARTIAL_SHIPPED — §5.2's "never from quantity" rule stays
  intact. (I over-analyzed it in the first exchange; the owner's 1000-pc worked example clarified it.)
  Owner's acceptance scenario (1000pc): ship 350 not-complete → PARTIAL; ship 650 complete → SHIPPED;
  reverse the 650 → PARTIAL (350 still out); ship 463 → PARTIAL; ship 187 complete → SHIPPED.
  Fix commit aea35a3 (reverseShipperInTx clears lineComplete on the reversed shipment's lines under
  the existing claim; recompute rule untouched; spec §5.2/§5.6 amended). RED proven: scenario failed
  at step 3 (stayed SHIPPED) before the fix. Invoiced path preserved: invoice→finalize(INVOICED)→
  reverse(REOPENED, direct)→unlock derives PARTIAL_SHIPPED not SHIPPED; `released` still unlock-only.
  Full suite 1692, E2E 16/16. Review (task-reviewer, opus, scoped to aea35a3) — Spec ✅, quality
  APPROVED, 0 Critical / 0 Important, 1 Minor. Reviewer did the revert-to-red itself: neutralizing
  the flag-clear step reds exactly 3 tests (non-invoiced reopen, the 1000pc step 3, and the
  invoiced→unlock path) — the invoiced→unlock red proves the flag-clear is what makes unlock derive
  PARTIAL_SHIPPED. Confirmed recomputeOrderStatus is NOT in the diff (rule untouched, no quantity in
  the decision), `released` still unlock-only across all 13 call sites, and no cross-order corruption
  (completeLineIds drawn only from the reversed shipper's own lines). Spec §5.2/§5.6 amendment
  accurate.
  Minor (owner awareness, NOT a fix): clearing lineComplete on the reversed shipment's own lines
  means the ORIGINAL shipment now reads "not complete" in the order-hub Shipments list, and a
  not-yet-printed original ticket would omit "Shipped Complete." Already-printed tickets are
  byte-immutable (unaffected). This is correct — a reversed shipment IS no longer a complete
  shipment — and it feeds no status/money logic; it's the intended, §5.6-documented shadow of the
  mechanism. Flagged to the owner.
VS SCREEN LIBRARY (owner added 2026-08-07): 125+ Visual Shop screens under docs/samples/00-…06-.
  Owner ruling: GITIGNORE (live company data, would push to the remote; VisualShopTraining.pdf
  precedent). The 5 tracked layout-sample PDFs are unaffected. Created a TRACKED capture wishlist
  (docs/visual-shop-capture-wishlist.md) of VS screens still worth grabbing for 5B/5C/later, keyed
  to VS's real menu labels (read the A/R and Billing menus to name functions precisely). Both
  registered in HANDOFF's document map. Commit for the gitignore+wishlist+map is separate.

=== PHASE 5A: REVIEW-COMPLETE (2026-08-07). 20 tasks + whole-branch review + 1 fix wave + scoped
    re-review, all clean. Final: 1690 tests / 109 files, tsc/eslint/build clean, E2E 16/16. 103
    commits on phase-5a-pricing-invoicing (LOCAL, not pushed). Remaining are OWNER actions:
    (1) the demo walkthrough docs/2026-08-07-phase-5a-demo.md — rule on the named deviations + the
    filed order-line-freeze question; (2) open/merge the PR (attribution in the body, never a commit
    trailer — a hook blocks them); (3) post-merge verify + kick off 5B from §9. The controller does
    NOT open the PR or push — outward-facing, owner's call. ===

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

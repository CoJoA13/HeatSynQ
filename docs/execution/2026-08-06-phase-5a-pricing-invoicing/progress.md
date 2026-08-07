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

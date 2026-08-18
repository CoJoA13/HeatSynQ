# Round 2 Group D — the stale-load class — progress ledger

Branch `group-d-stale-loads`, opened 2026-08-18 from `b7460fc`.
Issues: **#31 (the ruling) + #3, #5, #15, #23, #110**, plus the sibling-page sweep.

## The #31 owner ruling (2026-08-18, opens the group)

Asked as the group's first action, per the backlog's "decide #31 before fixing any of the others."

**Ruling: option 1 — keep fetching in effects.** The `react-hooks/set-state-in-effect` override in
`eslint.config.mjs` becomes a **documented permanent decision**, not a deferral pending #31.
`src/lib/use-latest.ts` is the standing discipline: the ticket idiom for stale responses, the
invalidation idiom (`invalidateBackupBanner` precedent) for cross-component staleness.

Reasoning recorded on the issue (comment, 2026-08-18): the build is complete through Phase 8, so
the issue's "decide before Phase 3 adds pages" framing no longer applies — the pages exist and are
tested. A fetch library or Server Components would be a real migration over working paper for
consistency, not correctness, and both cut against deliberate early choices (dependency-light;
client components against guarded APIs, which sidestep the every-server-page-must-`requireUser`
constraint).

**Sweep scope ruling (same exchange): named issues + sibling audit.** Recon audits every
fetch-into-state page for the class, not just the five named instances — "fixing them one at a
time is how the class survived this long."

## Recon inventory (2026-08-18)

One-off lint run with the rule set to `warn` (reverted immediately): **77
`set-state-in-effect` hits across ~48 files** — up from the 21/19 in #31's text; phases 3–8 added
reports, receivables, invoicing, orders detail, certs, and admin templates. The full hit list was
the sweep audit's work-list.

Recon ran as 16 agents (4 targeted deep-reads + 12 sweep auditors). Headline findings, all bound
into the brief:

- **#5 is already fixed** — `aeed372` (Phase 2C-2, PR #13) gated the customers list and birthed
  the parts list gated; `use-latest.ts:2–5` cites the issue. Closed with evidence, not re-fixed.
- **#3/#15 cannot be fixed by any queue arrangement** (the optimistic set happens at call time,
  outside the queue; an awaited rollback inside the failing key's fn deadlocks) — the fix is an
  epoch-gated, detached, settle-deferred rollback reload, one shared pure helper (brief Task 2).
- **#23 and #110 confirmed** exactly as filed, fix shapes pinned to the in-repo precedents
  (the ticket idiom; the `invalidateBackupBanner` clone with a banner-side renders-nothing guard).
- The sweep found the class alive well beyond the named issues: ~15 genuinely ungated shared
  `load()`s (three with server-side write-back amplification through stale refs — roles,
  step-codes, surcharges), the four mutation-gate detail pages' rollback-drain residue,
  a stale-closure pair, and TemplateEditor's 409 path that unrecoverably destroys mid-flight
  edits. All in the brief (Tasks 5–8). Out-of-class adjacent finds are filed as issues at
  close-out (Task 9), not fixed — the scope line that keeps the group from ballooning.
- **Clean bills recorded** for: all six /reports screens, NewShipment, processes list,
  QuoteLinkPicker, ReceivablesList, AgingReport, Scoreboard, orders/[id] sections
  (Shipments/Process/Invoices), customers detail sections (TemplateAssignments/
  SurchargeOverrides/Receivables), PreviewPane (serialized by `rendering`), admin/backups,
  orders/new autosave + handleSave (both mutation surfaces verified clean).

## Task verdicts

**Task 2 (#3 + #15, save-scope helper + adoptions)** — implementer `dc00c5c`/`02a3da5`/`cf72267`,
RED watched on all four brief traces. Review: **Spec ✅ · Needs fixes**, one Important —
**plan-mandated (the brief's own algorithm)**: the epoch was captured AFTER the settle-wait, so a
save beginning while the reload was parked on `allSettled` was counted as already seen, and the
resumed GET could apply a payload predating its commit — the group's own clobber class through a
narrower window. Controller ruling: fix, not ratify. Fixed on-branch with the missing test
watched RED first (`Expected "b1", Received "b0"` through the parked window), the one-line
capture move, and the brief's algorithm corrected in place with an amendment note. The review's
two actionable minors also landed (the explicit `pendingGets()===0` settle-defer pin; the
sibling-save-clears-banner note is the pages' design, pinned by the ordinary-failure case).
Both implementer deviations verified sound by the reviewer (InspectionsSection `move` in-spirit;
`rowsLatest` subsumed by the scope's strictly-stronger gate). **Approved after fix round 1.**

**Task 3 (#23 + step-codes page)** — implementer `a6e875e`/`e751a1d`/`0516b69`, RED watched on
the leaf's stale-drop cases. Review: **Spec ✅ · Approved (round 1)**, zero fixes. The reviewer
traced #23's five-step stale sequence closed end-to-end (including the pre-effect flush window),
verified recon §B's queue-hold invariant survived the refactor (the blocker GET is still awaited
inside the queued run), and proof-checked the one deliberate deviation — `codesRefGate.accept()`
consuming tickets minted by `latest.next()` — against `use-latest.ts`'s applied-monotonic
semantics (sound; the PR #22 whole-array rewind stays closed and queued runs still read the
freshest ref). Two minors noted for awareness only (a self-healing draft-clear reveal window; the
F7 swallow's invisibility at call sites), no action required.

**Task 4 (#110, SetupBanner invalidation)** — implementer `6abc950`/`ee9f7cf`/`20a2e43` (report
commit re-created in the Task 6 boundary split), 13-case RED table. Review (on the regenerated
clean package after the contamination correction): **Spec ✅ except one item · Needs fixes** —
one Important: the `/login` reset is silently overwritten by an in-flight fetch's commit (the
`/login` path never bumps the generation, `cancelled` is hardwired false), and the new
resolve-time `fetched: true` re-latches over the reset — the NEXT session (possibly a different,
non-admin user) shows the prior session's readiness strip all session. The old code's unguarded
`.then(setData)` shared the transient half but could never re-latch. Fix round dispatched to the
implementer: the one-line `/login` generation bump, a pure-seam test pinning the sequence where
cheap (reviewer minor 3), and the fail-toward-blank comment (minor 2). Reviewer confirmed the
no-per-nav-argon2 invariant holds on every traced sequence, the skip-guard predicate cannot
disagree with the render, the call-site set is complete, and minor 4 (a counted-kind DELETE
skipped by the renders-nothing guard) is the brief's own ruling followed faithfully.
**Fix round 1 (`537b0cf`) → Approved.** The `/login` branch now bumps the generation FIRST and
the reset's own commit rides the bumped value (verified both halves + the double-bump edge);
the synchronous pre-dispatch half became the exported hook-free `beginSetupFetch` owning both
load-bearing orderings, with the finding's exact trace pinned RED-first (and the inverse pin:
a plain navigation must NOT move the generation). All previously-verified invariants re-confirmed
untouched. 32/32 banner tests, tsc/eslint clean.

**The concurrency incident (for the record):** Task 4's report commit (`cd9d9aa`, since split
away) swept Task 6's nine staged files through the shared git index; Task 6's implementer split
the tip into `20a2e43` + `b1b8dc6` (trees verified byte-identical to the pre-split tip), and the
Task 4 review package — generated from the contaminated commit — was regenerated and the
in-flight reviewer corrected. All implementers since commit with explicit pathspecs
(`git commit -- <paths>`), which makes a shared-index sweep structurally impossible to repeat.

**Task 6 (the nine-site ungated-load sweep)** — implementer `b1b8dc6`/`6ace27d`. Review:
**Spec ❌ on one site · Needs fixes** — eight of nine adoptions verified exact, complete, and
regression-free (including the hardest: the processes template gate covering the rename
bookkeeping, with the removed dead catches proven dead; and the Statements
deselection-invalidates-in-flight pair, with the moved `next()` proven exclusive to
`loadPreview`). The one Important: CertificationsSection's `showLoadGap = loaded && !error`
conjunct — the `!error` half was the implementer's addition beyond the brief's `loaded`-only
gate — hides the §4.1 gap line and every create button unrecoverably after a transient CREATE
failure (the create's catch writes the same shared `error` and never reloads), where the cited
InvoicesSection precedent actually keeps the control rendered and disables it with a reason
(§5.16). Fix round dispatched: split the load-failure channel from the create-failure channel,
or follow InvoicesSection literally, folding in the disabled-with-reason treatment for the
failed-mount case. The commit-boundary split was independently verified byte-identical.

**Task 5 (shared components: Shell ×2, HistoryPanel, AttachmentsSection, ReferenceTable)** —
implementer `13bf9a3`/`061a21b` (explicit-pathspec discipline held under a live concurrent
tree modification). Review: pending.

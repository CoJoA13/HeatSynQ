# Round 2 Group H2 — the client-state batch — progress ledger

Branch `group-h2-client-state`, opened 2026-08-19 from `ed5ee77`.
Issues in this PR: **#144, #145, #146, #147, #148, #149** — the Group-D-filed six the H brief
queued as a separate PR.

## Kickoff (2026-08-19)

- Per the H brief's H2 section: no new recon. But the filed refs predate the D and H merges,
  so a six-agent verification fan-out re-pinned every target at HEAD (`a8ed769`). **All six
  issues verified still real.** Three material corrections the brief carries: the board
  set-default control now spans two files (H's #33 slice), the orders hub never adopted
  `useEditGuard` (its #149 half is an adoption, not an extension), and no
  `tests/use-edit-guard.test.ts` exists (the suite is created, not extended).
- No owner rulings needed: every open choice is settled by an in-repo precedent. Controller
  calls recorded in the brief: #148 → the merge port (the precedent's own stated rule), #144
  customers list → split load/action channels (dissolves the filed trade-off), #145
  InvoicingList → the functional `setTicked` update, AttachmentsSection → per-operation error
  scoping.
- Brief committed first (`7cf2b00`). Three parallel implementers dispatched (file-disjoint;
  per-task scratch DBs from the start — the H incident-3 convention, now standing).

## Process incidents

1. **The brief's scratch-DB override was broken as written** (controller's own): the kickoff
   convention said `DATABASE_URL=…scratch npm test`, but `tests/helpers/setup.ts:4` reassigns
   `DATABASE_URL` from `.env`'s `DATABASE_URL_TEST`, so the override never redirected the
   suite — every "scratch" full-suite run silently hit the shared `erp_test`, and two
   implementers' concurrent runs collided exactly the way the convention exists to prevent
   (both runs invalid, no durable damage). Task 3's implementer diagnosed it via
   `pg_stat_activity` and verified the working override is **`DATABASE_URL_TEST=…scratch`**
   (dotenv doesn't override shell-set vars, so the shell value flows through the reassignment).
   Brief corrected in place; the convention wording for future groups is
   `DATABASE_URL_TEST=…scratch npm test`.

## Task verdicts

**Task 1 (#149, typed-text overlay)** — implementer `2c614d7`/`708d0c7`/`f491e85`/`9dd3d2c`
(+ fix round `9d58d2a`). Review: **Spec ✅ · Approved (round 1)**. The reviewer verified the
keyed variant provably additive (the scalar bodies differ only by `cell: null` writes; the
seven consumers appear in no hunk), the two orders-page invariants character-identical against
base (travelerPrinted monotonic ternary; mutation-gate/drain byte-identical), and the disclosed
optimistic-patch deviation behavior-equivalent (blur clears the slot before `commit`, so
merge-wrapping the patch would be a semantic no-op) — the adoption even removes a latent
spurious-PATCH the old `focusedValue` ref carried. One Minor applied by the implementer, TDD:
the disappearing-row branch now RELEASES the cell slot — the reviewer inverted the report's
dismissal (soft-delete is precisely what lets a same id leave and re-enter the payload via
`includeInactive`/reactivation), and with the row's input guaranteed to unmount there is
nothing left to protect. 23/23 leaf tests; two record-only notes.

**Task 2 (#144 + #145, error channels + in-flight guards)** — implementer `03bee03`/`1b1bc1e`/
`2b9d006`/`e54b986`/`d663f08`/`f1f3225`/`8bc4415`/`b7cfe25`. Review: **Spec ✅ · Approved
(round 1)**, zero Important. The reviewer verified every channel split against its actual
precedent (incl. the customers `loadError`/`actionError` split genuinely dissolving the filed
trade-off — the ticket-gated clear sits after `isCurrent`, `actionError` is add()-only), both
AttachmentsSection directions, the board's no-unordered-PATCH window closed, and PricingSection's
handler bodies byte-identical to base around the new guards. Two deviations judged strictly MORE
correct than the brief's literal text: the Quotes `bumpingIds` Set (a scalar's `finally` after
row B starts would clear B's live guard) and the functional `setTicked` (`failures ∪ (prev ∖
ran)`). Five record-only minors (single banner slot inherent to the sanctioned tagged channel;
kind-scoped guard breadth matching the `addingRow` precedent; never-auto-cleared picker states
being the precedent's own rule; untick-mid-run re-tick kept as out-of-scope; no TDD by design —
client components, nothing extracted).

**Task 3 (#146 + #147 + #148, the precedent-copies)** — implementer `de21da0`/`60a5fb0`/
`96f588b` (+ fix round `653e516`). Review: **Spec ✅ · Approved (round 1)**, zero Important.
The reviewer verified #146's catch covers both firing paths with no double-report possible
(the panel's own load self-catches and never rejects), #147's gating exhaustive (`error` only
ever lands with `loaded=true`, so the ternary covers every state; Export disables through
`exportTitle !== undefined`), and #148's `rowsAfterSave` race-safe (functional `setRows`
serializes keystroke-vs-merge through React's updater queue; `rowsAtSave` captured from the
same closure the diff used). Both judgment calls endorsed: NOT clearing gaps in Close's catch
(cleared gaps read as a false all-clear to a future ungated consumer — stale gaps at worst
over-disable) and the new `field-drafts.ts` leaf over extending `step-drafts.ts` (shared rule,
zero shared types/code). Fix round: one Minor applied — a re-sorted-server fixture pinning the
merge to fieldId keying, proven red under a temporarily-positional variant (13/13 after) — and
the report's #146 probe note corrected (wrong in the safe direction). One record-only: the
month-switch transient stale-affirmative window is the page's deliberate sibling idiom
(`closeTitle`/schedule carry the identical window), ticket-self-correcting and server-backstopped
by `exportClose`'s 409 — recorded, not changed.

Task 3's implementer also found the scratch-DB override defect (incident 1 above) and
re-verified its gates on a genuinely private database.

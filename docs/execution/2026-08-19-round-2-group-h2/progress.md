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

## Group tally

Three implementation tasks, three reviews — **three Approved round 1, zero Important findings
across the group**. Two single-Minor fix rounds, both TDD'd by their own implementers (Task 1's
disappearing-row slot release `9d58d2a`; Task 3's fieldId-keying pin `653e516`, proven red
under a positional variant). Task 2's five minors all record-only. Six issues closed by the PR
(#144–#149). No migrations. Two new `src/lib/` leaves with suites (`field-drafts.ts`; the
keyed edit-guard variant inside `use-edit-guard.ts` with its first-ever test file).

## Codex round 1 (PR #154, 2026-08-19)

Two findings, **both verified real and accepted** — and the P1 is the sharper lesson: it was a
regression introduced by OUR OWN review round (the `9d58d2a` clear-on-absence), the classic
late-round pattern of findings living in code written for the previous round.

- **P1 (`cc0e946`)**: `applyDetail` merges addresses then contacts through ONE guard slot, and
  the fix-round release fired whenever the focused row was absent from the incoming array — a
  focused contact is ALWAYS absent from the addresses array, so the sibling collection's merge
  destroyed the registration: a dirty contact cell was overwritten wholesale (the exact #149
  defect), and a focused address lost its blur no-op guard to a cleared `atFocus: ""`, turning
  an untouched blur into a spurious PATCH. The pre-fix-round code was accidentally safe
  (absence left the slot alone). Fix: the cell identity is now `{collection, rowId, field}` —
  `mergeRows(collection, …)` acts on the slot only when the registration names its own
  collection. RED-first (3 failed / 23 passed on the exact cross-collection constructions),
  26/26 after; the customers page narrows the collection type to its own union.
- **P2 (`e4941dd`)**: the functional `setTicked` kept `prev ∖ ran` with no intersection
  against the REFRESHED candidates, so an order ticked mid-run and invoiced by another session
  stayed invisibly ticked — Create enabled against a row that no longer renders. Fix:
  `loadCandidates` returns the ids it just applied (`null` when the fetch failed or was
  superseded — nothing applied, stale rows still render, so the un-pruned set is the
  consistent state) and the ENTIRE post-run set — failures included, closing the pre-existing
  half — intersects with it. The prune deliberately lives only in the post-run update, not at
  every load.

Both replied + resolved per the loop; one push carrying both fixes (re-triggering review).

## Codex round 2 (2026-08-19)

One P2, **verified real and accepted — then widened twice** (`d599ec1`):

- Codex's finding: `mergeRows` MUTATES the guard's `focused` slot (the untouched-branch
  re-snapshot) inside functional setState updaters. React updaters must be pure; Strict Mode
  (on — Next's default, dev) double-invokes them with the same prev, so call 2 reads call 1's
  write, judges the untouched cell dirty, preserves the stale local value over the refresh, and
  a later blur commits it over the server change. React 19's rebasing can re-run updaters in
  production too — a correctness fix, not dev cosmetics.
- Widening 1 (controller): the scalar `merge` carries the SAME mutation and has shipped inside
  functional updaters since Phase 4 across seven consumer pages — Codex flagged only the keyed
  variant, but the mechanism is one and the orders adoption had just extended the scalar
  exposure. The whole leaf went pure: `merge`/`mergeRows` read `focused` and never write it;
  the transition moved to paired companions (`noteMerged`/`noteMergedRows`, called beside every
  setState, INSIDE accept branches so a dropped payload is never noted); `noteMergedRows` owns
  the round-1 collection scoping and release-on-absence. All 13 apply sites across the seven
  consumers paired; the pairing discipline is in the leaf header.
- Widening 2 (implementer, catching a hole in the controller's design): a single mutable
  snapshot overwritten by the companion is STILL unsafe — React can defer a batched updater
  past the companion call (guaranteed for the 2nd/3rd dispatch in one handler, exactly
  `applyDetail`'s shape), and the deferred updater then reads the transitioned snapshot and
  misjudges dirty through the other door. Since React fixes neither the order nor the count of
  updater runs, the slot keeps a per-focus-session **grow-only snapshot set** (at-entry value +
  every noted server value); "untouched" is membership — the text is a value the box was GIVEN,
  not typed. Merge results are identical under every note/updater interleaving and any
  invocation count. Blur semantics: untouched and dirty-typed unchanged; revert-to-server-value
  becomes a no-op (strictly better — the server already holds it); revert-to-at-entry stays a
  no-op (the shipped, pinned behavior — deliberately not changed by a purity fix).
- TDD: 11 failed / 25 passed observed RED (double-invocation purity both variants,
  note/updater orderings incl. the deferred cases, revert edges), **36/36** after. Full suite
  **3359/200**, tsc/eslint/build clean, **E2E 23/23 (third run)**.

## Codex round 3 (2026-08-19) — the fixpoint

One P2, **verified real and taken as the lesson-4 trigger** (`8f3d1cb`): three consecutive
rounds on one mechanism means redesign to a fixpoint, not another patch. The finding: round
2's companions still left `merge` READING the live focus slot inside a deferrable updater
while `noteMerged` ran at dispatch — two consultations of mutable state at different times, so
a focus change between them lands the note on the old session and the merge on the new one
(spurious PATCH of a server-given value; can overwrite a concurrent edit). Reachability today
is essentially nil (default-priority updates flush in microtasks; focus is a macrotask;
nothing here uses startTransition) — but React guarantees neither order nor count, so the read
was the same contract violation the write had been.

The fixpoint: the guard's state is a single **focus session** — an immutable-identity value
object created at focus and REPLACED, never mutated, by the next focus/blur/release; while
current it accumulates the grow-only snapshot set. Every apply is
`applyPayload(incoming)` / `applyRows(collection, incoming)`: capture the session ONCE at
dispatch, note the payload into that same captured identity, return a pure updater closed over
it — capture, note, and merge derive from one identity, and **mispairing is not representable
at a call site**. `capturePayload` is the low-level pair for orders' composed
travelerPrinted-ternary updater. Live-session reads exist at exactly two kinds of places:
user-event handlers (never deferred) and the single synchronous capture instant
(grep-swept). The one residual — a payload committing after a focus change repaints the
newly-focused untouched box without its session learning the value — is DOCUMENTED in the leaf
header as a boundary (needs macrotask-scale deferral, unreachable here today, equals the
pre-adoption `focusedValue` behavior in a strictly narrower window; closable only by an
effect-time note of the DOM-rendered value) and pinned by an expected-current-behavior test.

TDD: 6 failed / 36 passed observed RED (capture-across-focus-change scalar + keyed, ended
session, `capturePayload`, double-invocation, boundary pin), **39/39** after; most consumer
sites simplified to one line. Full suite **3362/200**, tsc/eslint/build clean, **E2E 23/23
(fourth run)**.

## Codex round 4 (2026-08-19)

**CLEAN** — no new comments within the watch window, zero unresolved threads. The fixpoint
ended the chain, as with the float-arithmetic (Group C) and travelerPrinted chains before it.

## Merge (2026-08-19)

Squash-merged as `1ba0d34` (PR #154). **All six issues (#144–#149) auto-closed** — the
one-`Closes`-per-issue discipline from PR #152's lesson, applied and now verified working.
9 issues open after: #33 (deferred create/edit split), #153, parked #4/#8/#69/#71/#77, #134,
#137 — all owner-gated; Round 2's grouped work is complete.

## Gates (re-run IN FULL after the Codex round; final tree `cc0e946`)

| Gate | Result |
|---|---|
| `npm test` | **3349 passed / 200 files** (solo runs on `erp_test`; 3346 pre-Codex, +3 cross-collection tests; Group H closed at 3310/198) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean |
| `npm run test:e2e` | **23/23 flows**, twice — at `653e516` pre-PR and re-run at `cc0e946` after the Codex fixes (both UI-behavioral) |

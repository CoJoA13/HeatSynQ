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

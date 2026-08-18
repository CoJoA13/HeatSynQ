# Round 2, Group E — progress ledger

Branch `group-e-close-gl`, base `ed55ffe`. Brief committed first (`62149da`).

## Task 1 — #139 freeze-the-pair + #140 coverage-precise removal

- **Implemented** `fc93b11` (report `9a5f7c2`). Guard inside `claimLiveShipper` (the six-door
  chokepoint), #140 predicate swapped to the `documents.ts` coverage branch, §5.16 UI gate in
  `ShipmentDetail.tsx`. Full suite 3175 green, tsc/eslint clean. RED table in the task-1 report.
- **Review round 1:** Spec Compliance ✅ · Task quality **Needs fixes** — one Important, two
  minors, no Critical.
  - **Important (plan-mandated, i.e. the BRIEF's flaw, not the implementer's):** the brief's lock
    argument claimed the post-claim pair reads are "serialized at ANY isolation." False at the
    doors' actual isolation: they run Serializable with snapshots fixed at the stub read, so the
    `liveReversal` read can miss a just-committed reversal. The header/membership/line doors are
    still closed deterministically by SSI (they write rows the reversal creation READ — Shipper
    header, ShipperOrder set, ShipperLine rows — completing the rw-cycle with the predicate read,
    40001→409). `replaceShipperContainers`/`replaceShipperSerials` write rows the creation never
    reads, so one can commit on a freshly live pair.
  - **Controller ruling — ACCEPT the two-door window, fix the comment.** Verified against the
    creation code (step 6 clones LINES only — no container/serial read anywhere in
    `reverseShipperInTx`): the leaked outcome is serial-equivalent to editing BEFORE the reversal
    existed, which is a legal history, and the reversal's paper, the pair's mirror-lines property
    and the ledger are byte-identical either way. This is the repo's existing accepted pattern —
    publish-by-immutability's "a print racing a publish may legitimately render the prior
    published version; 'from that moment' means commit order" (§5.1). The deterministic close
    (creation touching the original's Shipper row to force 40001 at every door's claim) is known
    and cheap if the owner or Codex wants the letter of the ruling instead; flagged in the PR
    body for owner visibility.
  - **Fix applied:** the `claimLiveShipper` comment rewritten to state the true per-direction
    mechanism (on-row / conservative-stale / SSI-closed / accepted-window) instead of the
    overclaim. Comment-only; no behavior change.
  - **Minors, both accepted as-is:** (1) on an INVOICED live pair the edit doors now name the
    reversal first (two truthful hops — unlock → void → edit — instead of one); the brief never
    demanded invoice-first on edit doors and the void path's documented invoice-first order is
    unchanged and pinned. Owner-taste; noted for the PR body. (2) `?? "?"` fallback reachable
    only via test-only hard deletes; matches file idiom.
  - E2E owed at group end (UI touched: ShipmentDetail gate + banner) — scheduled in the brief.

## Task 2 — #73 future received dates + #80 un-footed batch posts

- **Implemented** `685417a` (report `f3d8e8e`). Guard at the sole `receivedDate` writer with one
  clock sample; foot check off the claimed row's `controlTotal` in `toBatchDetail`'s own integer
  cents; UI `max` on the date input. Targeted gates 136 green, tsc/eslint clean.
- **Review round 1: Spec ✅ · Approved.** Sole-writer, same-claim, timezone (UTC-midnight both
  sides; west-of-UTC evening entry accepted) and SSI read-set-only-widens arguments all
  independently verified. Four minors, none blocking.
  - **Minor 1 fixed on-branch (controller):** the remedy sentence was under-entry-shaped even for
    an over-entered batch — first clause now direction-aware ("Void the extra payment" vs "Enter
    the missing payments"), pinned by the over-entered test.
  - Minors 2–4 accepted as-is: refusal-only assertions on three #80 cases (one code path, the
    under case pins OPEN); a sub-millisecond midnight-straddle flake window in the tomorrow test
    (same class as the suite's existing today-based tests); UI `max` staleness across UTC
    midnight on an unrefreshed page (server is the authority).

## Task 3 — #88 broken-chain flag

- **Implemented** `81ff93d` (report `8cc7732`). `chainBroken` + `priorEndingAr` derived in-memory
  over the one existing `findMany` (calendar-arithmetic prior, cents comparison, REOPENED rows
  never flagged themselves); red badge + sentence in Close.tsx. Six new tests including the
  ruling's real reopen/re-close flow through the actual services (flag raises at 0→150, clears on
  re-close). Targeted gates 77 green, tsc/eslint clean.
- **Review round 1: Spec ✅ · Approved.** Two minors.
  - **Minor 1 fixed on-branch (controller):** the flagged-row sentence named an action the server
    would 409 in the gap case ("re-close this month" — the skipped-month rule refuses it) and
    cited a "prior month's ending 0.00" that doesn't exist there. Now three-way (§5.14): moved
    prior ending → re-close this month; gap → close the missing month first; nonzero genesis →
    beginning should be 0.00. Both null-prior shapes are corruption-only corners (the close
    refuses skipped months at creation), so no test fixture change — the badge tests pin the flag.
  - Minor 2 accepted: O(n²) find/some over the in-memory rows — one row per closed month for the
    life of the shop; a Map is the shape if a heavier consumer ever appears.

## Tasks 4+5 — #93 export audit journal + #90 minors bundle (bundled — same area)

- **Implemented** `5749983` (report `2c12bb5`). #93: `summary` (side/frozen account/debit/credit)
  on the export's create-audit; inert `SNAPSHOT_INCLUDE` entry → `undefined`; `SNAPSHOT_SELECT`
  belt excluding the two Bytes columns. #90: 40P01 translation + retryability; P2002 retry made
  OPT-IN (only `closePeriod` opts in); comment corrections (migrate diff verified empty); shared
  `ReadinessGapKind`; `MIN/MAX_CLOSE_YEAR` across four sites; empty export → 400 BEFORE
  `allocateNumber`; two no-changes recorded; E2E locator stabilized on a testid. Full suite
  3197 green.
- **Review round 1: Spec ✅ · Approved.** The risk item — allocation paths no longer retry ANY
  P2002 — survived the reviewer's independent sweep: the three nonce writers replay in-attempt
  (the P2002 never reaches the wrapper), every allocated number is serialized by the counter
  claim, and no other unique constraint is reachable inside the eight allocating transactions.
  Two minors:
  - **Minor 1 fixed on-branch (controller):** `?year=10000` through the readiness route itself —
    the only consumer of `period.ts`'s hand-built ceiling — now pinned (the other three sites
    were already covered).
  - Minor 2 accepted: the #93 test's exact-order assertion couples to `aggregateLines`'
    insertion-order contract, which the register's side filter already relies on; commented.

# Task 3 — #88: the broken-chain flag — implementer report

**Commit:** `81ff93d` `feat(close): flag a closed month whose beginning no longer chains to the prior ending (#88)`
**Branch:** `group-e-close-gl`

## What landed

- `src/server/close-periods.ts` — `ClosePeriodListItem` gains `chainBroken: boolean` and
  `priorEndingAr: number | null`; `listClosePeriods` derives both per row from the ONE existing
  `findMany` (which already fetches every row), in integer cents via the file's own `cents()`.
  Prior month found by calendar arithmetic (month − 1 with year rollover), never array adjacency —
  a gap month has no row. CLOSED + prior row (any status): `cents(beginningAr) !==
  cents(prior.endingAr)`. CLOSED + no prior row: flagged if any earlier row exists (a gap) or the
  beginning is nonzero (genesis begins at $0). REOPENED rows never flag themselves; a REOPENED
  prior still serves as the comparison base (its `endingAr` is its frozen last-close value). The
  read stays the plain `findMany` — no claim, no audit, not Serializable (Phase 8A rule, restated
  in the ruling). No schema change, no write path.
- `src/app/receivables/close/Close.tsx` — local type mirror extended (never imports from
  `src/server/**`); when flagged, a red `CHAIN BROKEN` badge beside the status badge (the existing
  :358–360 idiom) plus one sentence under the money line: "Beginning X no longer matches the prior
  month's ending Y — re-close this month to re-chain." Nothing disabled, nothing refused. When
  `priorEndingAr` is null (flagged genesis/gap), Y renders the chain-from-zero baseline `0.00`
  (commented in place).
- `tests/close-periods.test.ts` — new describe `listClosePeriods — the broken-chain flag (#88)`,
  the file's first `listClosePeriods` coverage (6 tests).

## Fixture strategy

Raw `prisma.closePeriod.create` fixtures for the five shape tests (the reports precedent — the
flag is a pure read over frozen rows; stated in the describe's banner comment). The ruling's real
flow IS covered end-to-end in a sixth test — it turned out cheap with the file's existing
`makeFinalizedInvoiceDated` helper and the real `closePeriod`/`reopenPeriod` services: close July
(0→100) and August (100→130), reopen July, add a missed July-finalized invoice, re-close July
(0→150) → August flags with `priorEndingAr: 150`, July does not, nothing refused; re-close August
(150→180) → flag clears. Both re-closes reconcile against the aging for free because recognition
is `finalizedAt`-based on both sides.

## RED table (all watched failing before implementation)

| Test | RED failure |
|---|---|
| intact chain (incl. Dec→Jan rollover) → no flags, priorEndingAr populated | `expected undefined to be false` on `dec.chainBroken` (field absent) |
| prior ending moved → NEXT month flags, moved month doesn't | `expected undefined to be false` on the June row's `chainBroken` |
| nonzero genesis → flags | `expected undefined to be true` on `chainBroken` |
| gap before a closed row → flags even when figures match | `expected undefined to be false` on the May row's `chainBroken` |
| REOPENED never flags itself, still serves as prior | `expected undefined to be false` on the 2025-03 row's `chainBroken` |
| the ruling's real flow end-to-end | `expected [undefined, undefined] to deeply equal [false, false]` |

All six failed because `chainBroken`/`priorEndingAr` did not exist on the list items — the right
reason.

## Gates

| Gate | Result |
|---|---|
| `npx vitest run tests/close-periods.test.ts tests/receivables-routes.test.ts tests/gl-export.test.ts` | 3 files, 77 passed |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |

E2E: owed at group level per the brief's sequencing ("E2E in background near the end — UI is
touched: ShipmentDetail, BatchDetail, Close.tsx"); not run per-task.

## Reviewer attention

- The gap test (May + July, no June) is the one that pins calendar-arithmetic-vs-adjacency: July's
  beginning deliberately equals MAY's ending, so an adjacency implementation would pass the figures
  and miss the gap.
- `hasEarlier` considers rows of ANY status (a REOPENED earlier row still evidences a gap). The
  brief's wording ("an earlier-month row exists") doesn't qualify by status; flagging is the safe
  direction either way.
- UI sentence when `priorEndingAr` is null: renders `0.00` (chain-from-zero baseline). For the gap
  case the figure is secondary to the badge; the brief prescribed exactly one sentence, so no
  gap-specific variant was added.
- `GET /api/receivables/close` passes the new fields through automatically (the route returns
  `listClosePeriods()` verbatim); `receivables-routes.test.ts` stays green with no shape pin
  broken.

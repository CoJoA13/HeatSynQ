# Codex review round 2 — fix wave report

PR #39, branch `phase-3-orders`, starting at `43536dd` (the tip of round 1's fix wave). Seven
confirmed findings, all fixed, TDD throughout (failing test first for every behavior change),
four coherent commits, pushed to `origin/phase-3-orders`. All six inline review threads replied to
and resolved; finding 1 (a top-level review body, no inline comment_id) covered via a PR comment.

Per the task's own pointer: read round 1's concern #1 (`vi.spyOn` on this Prisma Client's model
delegates does not call through and does not restore correctly) before starting. None of this
wave's fixes needed a stub at all — the one concurrency test (finding 4) uses a genuine second
transaction holding a real row lock (the `part-process-steps.test.ts` holder pattern), never a
spy — so the hazard didn't come up, but it shaped how that test was built from the start.

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest) | **953 / 953 passing** (baseline 929 + 24 new tests across the wave) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | succeeds (route table includes the new `/api/orders/[id]/process`) |
| `npm run test:e2e` | **10/10, twice** (two full, independent runs, no retries needed either time) |

No schema changes this wave — `prisma/schema.prisma` untouched, no new migration, both databases
unaffected. Findings 1, 6, and 7 touch pages the e2e flows render (the order hub, `/orders/[id]`,
via `order-entry-full`'s tail and all of `void-order`) — confirmed those pages keep rendering
clean end to end. Note for the record: no existing e2e flow drives the parts-page Inspections
add-row (finding 1) or the hub's rider-remove button (finding 6) with a specific assertion on
either behavior — those fixes are covered at the vitest route/service layer, which is where the
task's own per-finding test instructions pointed. Not treated as a gap to close outside that
instruction (no new flow steps invented).

---

## Finding 1 — Inspections add-row drops sampleQty (P1, top-level review body)

**File:** `erp/src/app/parts/[id]/InspectionsSection.tsx`

**Bug:** the add-row `POST` body built by `add()` listed `inspectionCodeId`, `scaleId`, `min`,
`max`, `location`, and `sort` — never `sampleQty`. Every inspection added through the UI silently
lost whatever the operator typed into the Sample qty field; the server has no way to tell "the
field was left blank" from "the field was never sent" (both parse to the schema's own `""`
default).

**Fix:** one line — `sampleQty: draft.sampleQty` added to the request body, with a comment naming
the fix-wave item.

**Commit:** `a284ef2` — fix: inspections add-row drops sampleQty

**Test evidence:** a service-level round-trip already existed
(`tests/part-inspections.test.ts`'s `sampleQty round-trips as free text...`), but nothing exercised
the actual **route** the add path uses. Added
`tests/parts-routes.test.ts`'s `POST /api/parts/[id]/inspections persists sampleQty, confirmed by
a GET read-back` — POSTs a body carrying `sampleQty: "8"` through the real route handler, then
GETs the list back and asserts the stored row shows `"8"`. Caveat stated plainly: this codebase has
no component-test harness (vitest is `environment: "node"` throughout, no jsdom/testing-library),
so this test cannot itself fail red against the pre-fix `InspectionsSection.tsx` — it exercises the
route/service plumbing the client talks to, which was already correct; the defect was purely in
what the client chose to send. Confirmed the route-level test passes identically before and after
the one-line client fix (expected, since the service side was never the problem) — the actual
regression coverage for the client bug is inspection of the diff itself, per the task's own
allowance for "route-level or read-back assertion."

---

## Finding 2 — load-split can produce a negative final load (P1)

**File:** `erp/src/lib/load-split.ts`

**Bug:** each non-final load's weight was rounded to the cent independently
(`Math.round((totalCents * qty) / totalQty)`); the last load absorbed whatever that left over. When
several loads' independent roundings all go the same direction, the last one can go negative to
balance the books. Confirmed the exact counter-example: `totalQty=5, totalWeight=0.03, loadWeight`
cap `0.01` → `[0.01, 0.01, 0.01, 0.01, -0.01]`.

**Fix:** replaced per-chunk rounding with cumulative rounding — `weight_i = round2(cumShare_i) −
round2(cumShare_{i−1})` (the standard largest-remainder/apportionment technique). Sums stay exact
by construction (a telescoping sum), every load's cents land within one cent of its ideal
proportional share, and no load can go negative.

**Commit:** `d21ee5f` — fix: load-split safety caps, order-line warnings, and locked-recipe reads

**Test evidence** (`tests/load-split.test.ts`):
- The exact counter-example, asserting every load's weight `>= 0` and the cumulative-rounding
  contract's precise per-load values (`[0.01, 0, 0.01, 0, 0.01]`).
- A property check over 23×47 `(totalQty, cents)` combinations: no load ever negative, no load's
  cents ever more than 1 off its ideal proportional share, and the qty/cents sums always exact.
- **The existing matrix needed no changes.** Verified by hand before touching the implementation:
  every existing fixture in `load-split.test.ts`, `orders.test.ts` (the mockup 14-load case
  included), and `order-loads.test.ts` has a `totalWeight/totalQty` ratio that is an exact whole
  number of cents per unit — meaning neither the old nor the new algorithm ever has a cent to lose
  on any of those specific numbers, so no per-load value could possibly shift. Confirmed
  computationally (by hand and by running the full existing suite unchanged before adding the new
  cases) rather than assumed; all pre-existing tests passed unmodified.

---

## Finding 3 — Unbounded load count (P1)

**File:** `erp/src/lib/load-split.ts`, `erp/src/server/orders.ts`, `erp/src/server/order-loads.ts`

**Bug:** nothing capped how many loads a split could produce — `qty=10,000,000` with `loadQty=1`
synchronously allocates 10 million objects before returning anything.

**Fix, both layers:**
- `splitLoads` computes the load count analytically (`Math.ceil(totalQty / perLoadQty)`) **before**
  the allocation loop runs at all, and throws a plain `Error` (no server import in this file) once
  that count exceeds `MAX_LOADS = 10_000`, naming the count and the cap: `"This split would
  produce N loads (max 10,000) — check the part's load quantity"`.
- `orders.ts` exports `runSplitLoads`, the one seam that translates that plain throw into a clean
  `HttpError(400, message)` — the same shape `parseDate` gives `parseDateOnly`'s own plain throw.
  Both `createOrder` (orders.ts) and `resplitLoads` (order-loads.ts) call `runSplitLoads` instead
  of `splitLoads` directly — a live `loadQty`/`loadWeight` cap edited down against an existing
  large order is exactly as reachable as a tiny cap from order creation, so both call sites needed
  the guard.
- Line qty is independently capped at `.max(10_000_000)` in zod (`LINE_QTY`, shared by `LINE` and
  `UPDATE_LINE`) — a sanity bound on any one line's value, reached before (and independent of) the
  separate load-count check.

**Commit:** `d21ee5f`

**Test evidence:**
- `load-split.test.ts`: the exact repro (`totalQty: 10_000_000, loadQty: 1`) throws instantly
  naming `10000000`; a `10,000`/`10,001` boundary case (exactly at the cap is allowed, one over is
  refused); the weight-cap path (loadQty derived from loadWeight) hits the same guard.
- `orders.test.ts`: `createOrder` maps the >10,000-load case to a 400 with the exact message and
  writes nothing (`order.count()` stays 0); a separate case rejects a `10_000_001` line qty as a
  `ZodError`, independent of the load-count path; `updateLine` gets the same zod-cap test.
- `order-loads.test.ts`: `resplitLoads` maps the identical case (a live cap edited down against an
  existing order) to the same clean 400.

---

## Finding 4 — Traveler print vs void race (P2)

**File:** `erp/src/server/traveler.ts`

**Bug:** the in-tx re-check (`live = await tx.order.findFirst(...)`) read `deletedAt` with a plain,
unlocked `SELECT` — Postgres MVCC never blocks a plain read on another transaction's lock — so a
`voidOrder` call whose own update committed in the gap between that read and the `storedDocument`
insert went unnoticed: a print could archive against an order that was, by the time anyone looked,
already voided.

**Fix:** claims the `Order` row with `SELECT "id" FROM "Order" WHERE "id" = $1 FOR UPDATE` **before**
the re-check, inside the same transaction — the same instrument (and the same justification)
`part-process-steps.ts`'s `workingRevision` uses for its own revision-lock race: `voidOrder`'s own
`tx.order.update(...)` (via `auditedSoftDelete`) takes a write lock on the same row at *any*
isolation level, so whichever side gets there first is guaranteed to see the other's committed
result rather than a stale one.

**Commit:** `a381ab3` — fix: traveler print vs void race

**Test evidence:** the discriminating shape is `tests/part-process-steps.test.ts`'s holder pattern,
carried over directly. A holder transaction takes the exact row lock, signals it has claimed it,
then — **while still holding that lock** — performs the void write (mirroring `voidOrder`'s own
update) before releasing (committing). `printTraveler` is started once the holder has claimed the
lock; a 200 ms race against a timeout confirms it hasn't settled (documented, per the same
precedent, as corroborating evidence rather than the discriminator itself — this specific fixture's
render is ~100ms of real CPU, so a slow settle isn't proof of blocking on its own). The actual
discriminator: once the holder releases, `printTraveler` must reject with the voided-order 400 and
must leave zero `StoredDocument` rows for that order — which only happens if its own claim
genuinely waited for the holder's commit. Failed red pre-fix (`printTraveler` resolved successfully
with real PDF bytes, racing straight past the concurrent void); green after, confirmed stable
across 5 additional runs.

---

## Finding 5 — bulk-grid removal intents not orphan-detected (P2)

**File:** `erp/src/lib/bulk-grid.ts`

**Bug:** `detectOrphans` early-returned whenever `edits` was empty, so a `removedIds` entry
referencing a row that vanished in an id-churn refresh (another actor's delete-then-recreate save)
was never inspected — it survived, doing nothing, while the row it meant to remove reappeared in
`compose`'s output (the filter `!removedIds.has(r.id)` no longer matched the row's new id), with no
warning posted. The exact same "unsaved work silently set aside" shape `edits` was already
protected against.

**Fix:** extracted the churn decision into a pure, exported `computeOrphanChurn` helper — given the
live id set, the previous one, the pending edit keys, and the pending removedIds, it reports
`"unchanged"`, `"first-seen"`, or `"churned"` (carrying both orphaned edit keys **and** orphaned
removedIds). `detectOrphans` now clears both categories and posts the shared warning whenever
either is non-empty — the early-return condition changed from "`edits.size === 0`" to "nothing in
either set actually orphaned."

**Commit:** `2515e1b` — fix: bulk-grid removal-intent orphan detection

**Test evidence:** this hook had zero existing test coverage (UI-only, no component-test harness in
this codebase) — per the task's own instruction, made the decision logic independently testable as
a pure function rather than writing a throwaway harness component. New `tests/bulk-grid.test.ts`
covers the full matrix: unchanged (by content, not Set identity), first-seen, edits-only orphaned,
**removedIds-only orphaned (the regression's own shape — previously unreachable behind the old
early return)**, both at once, and churn that orphans neither. 7/7 green.

---

## Finding 6 — removeLine returns no loads-mismatch warnings (P1)

**File:** `erp/src/server/orders.ts`, `erp/src/app/api/orders/[id]/lines/[lineId]/route.ts`,
`erp/src/app/orders/[id]/page.tsx`

**Bug:** `removeLine` returned the bare `OrderDetail`, unlike `addLine`/`updateLine`. A rider
removal changes the order's Σqty/Σweight against an unchanged loads collection — precisely what
`loadsMismatchWarnings` exists to catch — but the hub's `applyMutation` clears the warnings banner
whenever a response carries no `warnings` key (there is no way to tell whether a stale warning
still applies), so a removal that just caused (or resolved) a mismatch reported nothing either way.

**Fix:** `removeLine` now returns `{ order, warnings: loadsMismatchWarnings(order) }`. The DELETE
route already just forwards the service's return value, so no route-shape change beyond a
clarifying comment; `page.tsx`'s `unwrapMutation`/`applyMutation` already generically handle the
`{ order, warnings }` shape (it only needed its own doc comments corrected — they explicitly
listed `removeLine` in the "bare `OrderDetail`" group).

**Commit:** `d21ee5f`

**Test evidence:** new case in `orders.test.ts` — auto-splits a mockup order into 14 loads, removes
the rider, and asserts the returned `warnings` contains the sum-mismatch string. Updated the three
pre-existing `removeLine` tests that destructured the old bare return shape
(`const after = await removeLine(...)` → `const { order: after } = await removeLine(...)`) and the
route-level test in `order-routes.test.ts` (`removed.json().lines` → `removed.json().order.lines`,
plus an assertion that `warnings` is present-but-empty for that particular removal, which resolves
a mismatch the same fixture's earlier PATCH introduced).

---

## Finding 7 — Voided order's recipe unreadable after part deletion (P2)

**File:** `erp/src/app/orders/[id]/ProcessSection.tsx`, `erp/src/server/orders.ts`,
`erp/src/server/part-process-steps.ts`, new `erp/src/app/api/orders/[id]/process/route.ts`

**Bug:** a part is deletable once every order referencing it is voided (`parts.ts`'s `deletePart`),
but the hub's Process section read the **live** part (`getRevision`'s own part-liveness gate, via
`GET /api/parts/[id]/process/revisions/[n]`) — so once that legal deletion happened, the section
404'd "Part not found" instead of showing the order's own locked, historical recipe.

**Fix:**
- `part-process-steps.ts`: extracted the include-tree + mapping into
  `getRevisionContentUnchecked(partId, revisionNumber)`, doc-commented as restricted to callers
  already anchored on a stored `(partId, revisionNumber)` pair they have independent authority to
  read. `getRevision` now runs its own liveness check, then delegates to it — behavior for every
  existing caller (including the entry page's `OrderLineCard.tsx`, which still hits the original
  route) is unchanged; confirmed via the full `part-process-steps.test.ts` suite and the
  `revision-cut`/`typed-fields`/`template-build-and-load` e2e flows, all still green.
- `orders.ts`: new `getLockedRevision(orderId)` — resolves the order with **no** `deletedAt` filter
  (a voided order is fully readable here; only a truly missing id 404s), reads the lead line's
  stored `(partId, revisionNumber)`, and calls `getRevisionContentUnchecked` directly.
- New `GET /api/orders/[id]/process`, gated `orders.view` **only** (see concern below) —
  `ProcessSection.tsx` now takes just `orderId` and fetches this endpoint; the `leadPartId`/
  `revisionNumber`/`processesGate` props (and the "denied" UI branch, now unreachable) were removed,
  along with `page.tsx`'s now-unused `lead`/`processesGate` locals.

**Commit:** `d21ee5f`

**Test evidence:**
- `orders.test.ts`: `getLockedRevision` returns byte-identical content to `getRevision` for a
  normal order; stays 200 with the full locked content after the order is voided **and** the part
  is soft-deleted (confirmed against the same part, `getRevision` itself now 404s — proving the
  test genuinely exercises the deliberate exception, not something `getRevision` would have
  returned anyway); 404s an unknown order id.
- `order-routes.test.ts`: 401 unauthenticated, 403 wrong permission, 200 for `orders.view` with the
  locked content, stays 200 through the same void-then-delete sequence, and 404s an unknown order
  id.

**Owner-visible behavior change worth flagging explicitly** (directed by the finding's own text,
not invented): viewing the order hub's Process section previously required `processes.view`
in addition to `orders.view`; it now requires `orders.view` alone. This is intentional — every
caller who can view the order hub at all already holds `orders.view` (`page.tsx`'s own
`if (!order) return …` gate), and this read is order-scoped historical data, not a live
parts-process one — but it does mean a user holding `orders.view` without `processes.view` can now
see a (frozen) process recipe through an order they can already view, where before they could not
see it at all. Worth a one-line double-check that this matches intent, since it is a real, if
narrow, relaxation of what a role combination can see.

---

## Reply / resolve log

All six inline threads replied to (one-liner naming the fix + short SHA, ending with the required
attribution line) and resolved via GraphQL `resolveReviewThread`; finding 1 (top-level review body,
no inline comment_id) covered via `gh pr comment 39`. Verified after the fact: all six threads show
`isResolved: true` and exactly 2 comments each (original + reply), with the reply containing the
required marker line.

| # | comment_id | file | reply_id | commit |
|---|---|---|---|---|
| 2 | 3707709060 | load-split.ts (negative load) | 3707932452 | d21ee5f |
| 3 | 3707709066 | load-split.ts (load cap) | 3707933362 | d21ee5f |
| 4 | 3707709072 | traveler.ts | 3707934004 | a381ab3 |
| 5 | 3707709073 | bulk-grid.ts | 3707935351 | 2515e1b |
| 6 | 3707709079 | orders.ts (removeLine) | 3707936184 | d21ee5f |
| 7 | 3707709083 | ProcessSection.tsx | 3707936968 | d21ee5f |

Finding 1 (top-level review body): PR comment
https://github.com/CoJoA13/HeatSynQ/pull/39#issuecomment-5172152961 — commit `a284ef2`.

---

## Commits (pushed to `origin/phase-3-orders`)

```
d21ee5f fix: load-split safety caps, order-line warnings, and locked-recipe reads
a284ef2 fix: inspections add-row drops sampleQty
a381ab3 fix: traveler print vs void race
2515e1b fix: bulk-grid removal-intent orphan detection
```

`d21ee5f` bundles findings 2, 3, 6, and 7: all four touch `orders.ts` substantially (`load-split`
math and the new `getLockedRevision`/`removeLine` changes sit in largely disjoint regions of the
same file), and 6/7 additionally share `page.tsx`. Rather than attempt a risky hunk-level split
inside one file across separate commits, they were grouped into one commit — the same "group by
shared file/theme" pattern round 1's own report used (e.g. its `e8ba4ae` covered three findings).
Each finding's PR reply above still names it individually against that shared SHA.

## Concerns / notes for the owner

1. **Finding 7's permission-model change** (detailed above, in that finding's own section): Process
   section visibility moved from `processes.view` to `orders.view` alone, per the finding's
   explicit instruction. Flagging for a deliberate double-check since it changes what one
   permission combination can see, even though it was directed, not assumed.
2. **Finding 2/3's existing test matrix needed zero changes**, not "changes only where the
   invariant-preserving change genuinely moves them" — every pre-existing fixture happens to have
   an exact-whole-cent-per-unit ratio, so neither the old nor new rounding algorithm ever had a cent
   to lose on those specific numbers. Verified by hand and by running the full pre-existing suite
   unchanged before adding any new cases, rather than assumed.
3. **round 1's concern #1 (`vi.spyOn` unsafe on this Prisma Client) did not recur** — this wave's
   one concurrency test (finding 4) used a genuine second transaction holding a real row lock, the
   same holder pattern `part-process-steps.test.ts` already established, never a spy on a model
   delegate.
4. **E2E coverage gap, not introduced by this wave**: no existing flow specifically drives the
   parts-page Inspections add-row (finding 1) or the order hub's rider-remove button (finding 6).
   Both fixes are covered at the vitest route/service layer per the task's own per-finding test
   instructions; no new e2e flow steps were added, since that wasn't asked for and would have been
   scope beyond the seven findings.
5. `npm run test:e2e` was run twice, full 10/10 both times, with no retries needed on either run
   (round 1's report noted one unrelated transient flake across three runs; none observed here
   across two).
6. GitHub Actions' `ci` check was still `pending` at push time (queued immediately by the push) —
   every gate it runs was already verified green locally with the identical commands before this
   report was written; the remote run's completion was not waited on.

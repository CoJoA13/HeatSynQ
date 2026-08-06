# Task 10 report — Void a shipment; the order edit invariants; the cert cascade

## What was implemented

**`src/server/shippers.ts`**
- `shipmentBlockers(db: Db, orderId: string, orderLineId?: string): Promise<Blocker[]>` — every
  LIVE shipment attached to `orderId` (optionally scoped to one `orderLineId`, matching only
  shipments carrying a live `ShipperLine` for that exact line), as the shared `Blocker` shape
  (`entityLabel: "Shipment"`, `name: "Packing List ${shipperNumber}"`, `href: /shipping/${id}`),
  deduplicated by shipper and ordered by `shipperNumber` ascending for determinism.
- `voidShipper(id: string, reason: string): Promise<void>` — reason trimmed/required in the
  service; Serializable `$transaction`; resolves the live shipper, `claimOrdersInOrder` over every
  order it touches; `auditedSoftDelete("shipper", …)`; `auditedSoftDelete("cert", …)` for every
  live cert with that `shipperId`, same reason; `recomputeOrderStatus`. Numbers/sequences are
  simply never written to — permanence is the absence of a write, not a guard.

**`src/server/orders.ts`**
- New import: `shipmentBlockers` from `./shippers` (the new cycle edge), `shippedTotals` from
  `./ship-ledger`, `type Blocker` from `./reference-blockers`.
- New local helper `shipmentBlockerTail(blockers)` — the shared "Packing List X — void the
  shipment(s) first" tail every §5.5 refusal appends.
- `removeLine`: after the existing lead-position check, refuses removal when
  `shipmentBlockers(tx, orderId, lineId)` is non-empty, naming the shipment.
- `updateLine`: when `data.qty`/`data.weight` is present and falls below `shippedTotals`, refuses
  and names the shipment. Equal-to-shipped is allowed (only strictly below is refused).
- `voidOrder`: refuses when `shipmentBlockers(tx, id)` (no line scope — any live shipment on the
  order) is non-empty, naming the shipment(s).

**`src/server/documents.ts`**
- `VOIDED_PRINT` constant and `assertPrintable(owner: { deletedAt: Date | null }): void` — throws
  400 `VOIDED_PRINT` when the owner is voided. Placed right before `storeDocument`.

**`src/server/traveler.ts`**
- `printTraveler` now calls `assertPrintable(live)` instead of its own inline
  `if (live.deletedAt !== null) throw new HttpError(400, VOIDED)`. The local `VOIDED` constant
  (`"Cannot print a traveler for a voided order"`) is removed.

**Test-only consequence of the message change** — `tests/traveler.test.ts`'s three assertions
that pinned the literal old string now import and assert against `VOIDED_PRINT` from
`@/server/documents` instead (Task 3's brief called this test "stays green **in behaviour**", not
byte-for-byte frozen text — see Task 3's own report: it explicitly deferred `assertPrintable` to
this task rather than adding it early, so this task is the one that necessarily unifies the
message). Nothing else about that test changed — same 400 status, same "stored prints survive,
new prints refused" behavior, same row-lock race coverage.

**Test-only consequence of the new `voidOrder` invariant** — `tests/ship-ledger.test.ts`'s
pre-existing "leaves a voided order's status untouched" test built an order with a live shipment
(via its own raw-prisma `shipLine` fixture) and then called the real `voidOrder` directly. That is
now exactly the case Task 10 refuses. Fixed by voiding the underlying shipper via raw prisma
immediately before `voidOrder` — `shipLine` was already raw prisma standing in for a real
`createShipper` write (this file's own fixtures-note precedent), and voiding the shipper this way
does not itself call `recomputeOrderStatus`, so the order's `status` column stays exactly
`SHIPPED`, unaffected — the actual thing that test is proving (`recomputeOrderStatus` skips voided
orders) is untouched.

**Also added** — `tests/documents.test.ts` gets a direct `describe("assertPrintable", …)` block
(2 tests: throws 400 `VOIDED_PRINT` for a voided owner incl. status/message shape, no-op for a
live owner) per the brief's "unit-test it directly here."

## Files changed

- `src/server/shippers.ts` — `shipmentBlockers`, `voidShipper`
- `src/server/orders.ts` — wired `shipmentBlockers` into `removeLine`/`updateLine`/`voidOrder`
- `src/server/documents.ts` — `VOIDED_PRINT`, `assertPrintable`
- `src/server/traveler.ts` — `printTraveler` now calls `assertPrintable`
- `tests/shipper-void.test.ts` (new) — 6 tests
- `tests/order-ship-invariants.test.ts` (new) — 6 tests
- `tests/documents.test.ts` — +2 tests (`assertPrintable`)
- `tests/traveler.test.ts` — 3 assertions repointed at `VOIDED_PRINT`
- `tests/ship-ledger.test.ts` — 1 fixture adjusted for the new `voidOrder` invariant

## Tests and results (final)

```
npm test        → 87 files, 1228 tests passed
npx tsc --noEmit → clean
npx eslint src tests → clean
npm run build    → succeeds (webpack production build, no import-cycle error)
```

New/changed files in isolation:
```
tests/shipper-void.test.ts          6 passed
tests/order-ship-invariants.test.ts 6 passed
tests/documents.test.ts             29 passed (27 + 2 new)
tests/traveler.test.ts              28 passed (unchanged count, 3 assertions repointed)
tests/ship-ledger.test.ts           15 passed (1 fixture changed)
```

## TDD evidence (RED → GREEN)

1. Wrote `tests/shipper-void.test.ts` (brief's 3 tests + 3 of my own: unknown-id 404,
   already-voided 404, audit-entry-carries-reason) before `voidShipper` existed.
   RED: `npx vitest run tests/shipper-void.test.ts` → 6/6 failed, `TypeError: (0 , voidShipper) is
   not a function` (and one `runWithContext`/`asSystem` wrapper failure for the same root cause).
2. Wrote `tests/order-ship-invariants.test.ts` (brief's 3 tests + 3 of my own: rider-with-no-
   shipment removable, qty may rise freely, weight-reduction mirror of the qty test) before
   `shipmentBlockers` was wired into `orders.ts`.
   RED: `npx vitest run tests/order-ship-invariants.test.ts` → 3/6 failed (the 2 negative
   "allows…" tests and the "increase" test trivially passed since nothing blocked anything yet;
   the 3 refusal tests failed — one on a real assertion mismatch after an early fixture bug was
   found and fixed, described below).
3. Implemented `shipmentBlockers`/`voidShipper` in `shippers.ts`, then wired the three call sites
   in `orders.ts`. Reran both files → GREEN (6/6 and 6/6, the weight test added after the first
   green pass — see the dedicated RED check below).
4. `assertPrintable`/`VOIDED_PRINT` (`documents.ts`) were added directly (no separate RED for
   these two lines — they are a mechanical extraction of `printTraveler`'s existing, already-
   covered inline check into a two-line shared function; the 2 new `tests/documents.test.ts`
   cases exercise them directly and passed on the first run once written, since the function
   already existed by then). `printTraveler`'s repoint and the 3 literal-string test updates were
   verified together: `npx vitest run tests/documents.test.ts tests/traveler.test.ts` → 57/57
   green, confirming the shared guard preserves `printTraveler`'s exact behavior (400 status, void
   refused, stored prints survive, the row-lock race test) under the new shared message.
5. A fixture bug was caught mid-RED: my first `shipmentOfOneLine()` shipped the ORDER'S LEAD line
   (position 1). `removeLine` refuses position 1 unconditionally ("void the order instead") before
   it ever reaches the shipment-blocker check, so that test failed on the WRONG error message
   (`"The lead part cannot be removed…"` instead of the `Packing List` regex) — a real RED, but
   for the wrong reason. Fixed by making the fixture ship a RIDER line instead (comment in the test
   file explains why); re-ran → the intended refusal fired and the test went GREEN for the right
   reason.
6. Added a 4th refusal test (weight-below-shipped) after the first GREEN pass, since the brief's
   own literal test only covers `qty`. Verified it is not vacuous: temporarily guarded the
   `data.weight !== undefined && data.weight < totals.weight` branch in `orders.ts` with
   `if (false && …)`, reran `npx vitest run tests/order-ship-invariants.test.ts -t weight` → RED
   (assertion failed, weight reduction silently succeeded), restored the real code from a
   pre-edit backup, reran the whole file → GREEN again (6/6). `npx tsc --noEmit` and
   `npx eslint src tests` re-run clean after the restore, and the full suite re-run green
   (1228/1228), to make sure the restore didn't silently corrupt anything.
7. `tests/ship-ledger.test.ts`'s pre-existing "leaves a voided order's status untouched" test broke
   as a genuine, expected consequence of the new `voidOrder` invariant (see above) the moment the
   full suite ran — RED with a real `HttpError` ("Order #1000 has live shipments — Packing List
   90006 — void the shipment first") coming out of `voidOrder` inside that test, not a test-harness
   error. Fixed the fixture (void the shipment first via raw prisma) rather than the invariant;
   reran `tests/ship-ledger.test.ts` alone → 15/15 green, then the full suite → 1228/1228 green.

## How the new `orders.ts -> shippers.ts` import edge was verified (not assumed)

**Static check**: read both modules end to end. `shippers.ts` imports `isDuplicateClientRequestId`
from `orders.ts` — used only inside `saveNewShipper`'s catch block (a function body), never at
module-evaluation time. `orders.ts` now imports `shipmentBlockers` from `shippers.ts` — used only
inside `removeLine`/`updateLine`/`voidOrder`'s bodies, likewise never at module-evaluation time.
Neither file has a top-level `const`/class/enum initializer that reads a value off the other
module. Both crossing exports (`isDuplicateClientRequestId`, `shipmentBlockers`) are plain
`export async function` / `export function` declarations — hoisted bindings, never a `const`
arrow function — which is what the existing `order-locks.ts` header comment (and
`order-constants.ts`'s comment on `INT4_MAX`) identifies as the thing that makes a crossing export
safe regardless of which side of the cycle a given entry point evaluates first.

**Empirical check #1 — both load orders, standalone process, no Vitest module-cache tricks**: two
throwaway scripts under the scratchpad directory, each a fresh `tsx` process (no shared module
cache with anything else), one importing `shippers.ts` before `orders.ts`, the other the reverse:

```
DATABASE_URL=... SESSION_SECRET=... npx tsx cycle-check-shippers-first.ts
→ shippers-first OK function function true function

DATABASE_URL=... SESSION_SECRET=... npx tsx cycle-check-orders-first.ts
→ orders-first OK function function function
```

Both orderings load cleanly with every crossing export resolving to a real `function` (no
`ReferenceError`/TDZ, no `undefined`). (First attempt set `process.env.DATABASE_URL` inline in the
same ESM file above the `import` statements — that does NOT work, because static `import`s are
hoisted above all other top-level code regardless of source position, so `db.ts`'s
`if (!process.env.DATABASE_URL) throw` fired first. Fixed by exporting the env vars on the shell
instead, which is also a more realistic simulation of two genuinely fresh module graphs.)

**Empirical check #2 — full test suite**: `npm test` exercises the real (non-scratchpad) modules
under Vitest/esbuild across 87 files that import `orders.ts` and `shippers.ts` in every possible
order the test runner happens to pick, 1228 tests, all green — a TDZ bug of this shape reliably
throws at import time, not conditionally, so a clean full run is strong corroborating evidence on
top of check #1, not merely "the tests I wrote happen to pass."

**Empirical check #3 — production build**: `npm run build` (Next.js/webpack, a different bundler
and module system than both Vitest/esbuild and tsx) also completes cleanly, including every route
that touches either module (`/api/orders/**`, order pages, etc.) — a third, independent toolchain
agreeing rules out a bundler-specific circular-import quirk that vitest/tsx might not surface.

## Self-review against the brief and spec §5.5/§5.6

- **Interfaces match the brief verbatim**: `voidShipper(id: string, reason: string): Promise<void>`
  and `shipmentBlockers(db: Db, orderId: string, orderLineId?: string): Promise<Blocker[]>`.
- **Blocker shape reused, not reinvented**: `shipmentBlockers` returns exactly
  `{ entityLabel: "Shipment", name: "Packing List N", id, href: "/shipping/{id}" }` — the same
  `Blocker` type `reference-blockers.ts` exports and `BlockerPanel` already renders.
- **Reason discipline matches precedent**: `voidShipper` trims/requires the reason in the service,
  mirroring `voidOrder`/`voidCert` exactly (not the route layer).
- **Numbers/sequences untouched by construction**: `voidShipper` never writes `shipperNumber`,
  `bolNumber`, or any `ShipperOrder.sequence` — verified by the "keeps the number" assertion in
  `tests/shipper-void.test.ts` and confirmed by re-reading the function body, which contains no
  such write.
- **Cert cascade uses the same reason**: `auditedSoftDelete("cert", cert.id, why, tx)` passes the
  identical `why` used for the shipper's own delete — asserted by the "voids shipment-scoped
  certs" test checking `deletedAt` is set (a same-reason audit-content assertion was considered but
  the brief's own test only checks `deletedAt`; the shared `why` variable makes divergence
  structurally impossible here, so a separate audit-payload assertion would be redundant, not
  additive).
- **Row-lock discipline**: `voidShipper` claims every order the shipment touches via
  `claimOrdersInOrder` before any write, matching CLAUDE.md's "row locks, not isolation levels"
  rule and the exact shape `updateShipper`/`addOrderToShipper`/etc. already use.
- **Refusals name the blocker and link to it** in all three `orders.ts` call sites — verified by
  reading each thrown message, not just the tests: `removeLine` → "…cannot remove — shipped on
  Packing List N — void the shipment first"; `updateLine` → "…cannot reduce qty below N already
  shipped — Packing List M — void the shipment first"; `voidOrder` → "Order #X has live shipments —
  Packing List N — void the shipment first." Every one includes the shipment's name (which,
  through `shipmentBlockers`, always carries an `href` too, even though the plain-text `HttpError`
  message itself doesn't render markup — consistent with every other text-only refusal in this
  codebase; a UI surfacing `Blocker[]` directly, the way `BlockerPanel` does elsewhere, is out of
  this task's scope since no route was added).
- **`assertPrintable` matches the brief's exact signature and constant text.** `printTraveler`'s
  existing test suite was kept fully green by repointing its 3 literal-string assertions at the
  new shared constant (see TDD section above) rather than by leaving two different voided-print
  messages in the codebase — Task 3's own brief/report make clear this exact unification was
  deliberately deferred to this task.
- **A real bug caught and fixed during self-review, before commit**: `voidShipper`'s doc comment
  originally claimed a shipment-scope cert's `orderId` is "created… only when THAT order is added
  to the shipment — `saveNewShipper`/`addOrderToShipper` above." That's wrong —
  `addOrderToShipper` never calls `createCert`; only `saveNewShipper`'s own per-order loop at
  CREATE time does. The claim-coverage reasoning the comment makes (every shipment-scope cert's
  order is inside `orderIds`) is still correct, since `addOrderToShipper` only ever adds MORE
  orders to the claimed set — but the comment cited a nonexistent call path. Fixed by re-reading
  `shippers.ts` for every `createCert` call site (found exactly one, in `saveNewShipper`) and
  correcting the comment to say so precisely.
- **YAGNI**: no route/permission wiring added (correctly out of scope — no shipping routes exist
  yet in this codebase at all; `mustDo(user, "void_shipper")` is left as "the route's job," the
  exact phrasing `voidOrder`/`voidCert` already use for the identical reason). No UI change. No
  schema change (none needed — `Cert.shipperId`, `Shipper.deletedAt` etc. all predate this task).
- **Test quality**: every added test that isn't the brief's own literal text was independently
  checked for being non-vacuous — the weight-reduction test was proven non-vacuous by disabling
  the guard and watching it go RED (documented above, with restore verified via `tsc`/`eslint`/
  full suite afterward); the "rider with no shipment is removable" and "qty may rise freely" tests
  are the direct negation of what the refusal tests check, so a false-positive (the refusal firing
  unconditionally) would fail them immediately.

## Concerns

None. All three quality gates plus a full production build are green; the import-cycle question
the task explicitly flagged as risky was checked three independent ways (static reasoning, two
standalone fresh-process load orders, and two real toolchains — Vitest/esbuild and Next/webpack)
rather than assumed from precedent alone.

---

## Addendum — review round 2 fixes (2026-08-04)

Review came back **Needs fixes**: one Important (the cert cascade could write to an order it never
claimed) and two Minors. All three are fixed. This section documents what changed, on top of
commit `6a30109` and the owner's own `17490ca` (the spec §5.6 amendment the review requested,
already committed ahead of this work).

### Important — cert cascade writing outside its own claim

**The bug, confirmed by re-reading the review's repro against the code**: `voidShipper` derives
`orderIds` from `shipperOrderIds(tx, id)` — the shipment's *current* `ShipperOrder` rows — and
claims only those via `claimOrdersInOrder`. It then finds every LIVE cert with `shipperId = id`
and soft-deletes each one. A cert created for an order that was later removed via
`removeOrderFromShipper` (legal any time before a ticket prints — the only two guards are "last
order" and "ticket already printed") still carries `shipperId = id` but its `orderId` is no longer
in `orderIds`, since the join row is hard-deleted (`ShipperOrder` has no `deletedAt` — spec §4.2).
`voidShipper` would soft-delete that cert anyway, writing to descendant data of an order whose row
it never claimed with `FOR UPDATE`.

My original doc comment on `voidShipper` (the one the review quotes) reasoned only about orders
*added* later via `addOrderToShipper` (correctly noting that path creates no cert of its own) — it
never considered the *removed* case, which is exactly where the gap lives.

**Fix, at the source, per the review's direction and the now-committed spec §5.6 amendment
(`17490ca`)**: `removeOrderFromShipper` (`src/server/shippers.ts`) now finds that order's own live
SHIPMENT-scope cert (`orderId: target.orderId, shipperId: id, deletedAt: null` — at most one row
can match, by `createCert`'s own scope-instance uniqueness) and voids it with
`auditedSoftDelete("cert", …, "Order removed from shipment (Packing List ${shipperNumber})", tx)`,
under the SAME claim `claimOrdersInOrder(tx, orderIds)` already took for `target.orderId` a few
lines above (`orderIds` there is computed BEFORE removal, so it still includes the order being
removed). This runs before the actual `ShipperOrder`/children deletion, as its own audit entry
(different entity — "cert", not "shipper" — so it cannot be folded into the existing
`auditedUpdate("shipper", …)` call).

`voidShipper`'s own doc comment is corrected to state the REAL reason its cascade is safe: not
"every order that ever touched the shipment is still in `orderIds`" (false — an order can leave),
but "by the time a shipment-scope cert can still be found live in `voidShipper`, its order is
necessarily still ON the shipment, because `removeOrderFromShipper` already voided any cert
belonging to an order that left" — so `orderIds` genuinely covers every cert the cascade can touch.

**New regression test** — `tests/shipper-void.test.ts`, `"a removed order's shipment-scope cert is
voided at removal, so voidShipper's later claim never has to reach it (spec §5.6, 2026-08-04
amendment)"`: a new fixture `twoOrderShipmentWithShipmentCertOnFirst()` builds a two-order shipment
where only `orderA` is cert-required at SHIPMENT scope (`orderB` exists solely so `orderA` is
removable without hitting the "last order" guard). The test removes `orderA`, asserts its cert's
`deletedAt` is already set (BEFORE `voidShipper` ever runs), then calls `voidShipper` and asserts
— via a `vi.mock("@/server/order-locks", …)` spy on `claimOrdersInOrder` (the exact module-boundary
mock `tests/shipper-children.test.ts` already established, reused rather than reinvented) — that
its one call to `claimOrdersInOrder` carries only `[orderB.id]`, never `orderA.id`.

**RED verified by hand**: temporarily removed the `removeOrderFromShipper` cert-void block (backed
up the file first) and reran the new test alone —

```
× voidShipper > a removed order's shipment-scope cert is voided at removal, ...
  AssertionError: expected null not to be null
  ❯ tests/shipper-void.test.ts:181:93
```

— failing exactly at the discriminating assertion (the cert was still live immediately after
`removeOrderFromShipper`, because the old code never voided it there). Restored the real code from
the backup; reran the same test → GREEN; reran the full file → 7/7; reran
`tsc`/`eslint`/full suite afterward to confirm the restore introduced no corruption — all clean.

(The test's second assertion — `claimedIds` equals `[orderB.id]` — is true under BOTH the old and
new code, since `removeOrderFromShipper` always hard-deletes the `ShipperOrder` row for the removed
order regardless of cert handling; it is included as a direct, positive statement of the safety
property the fix establishes, not as the discriminating assertion. The first assertion — the cert
is already voided at removal time, before `voidShipper` ever runs — is what actually catches the
regression, confirmed above.)

### Minor 1 — cascaded cert's audit reason was unobserved

`tests/shipper-void.test.ts`'s `"restores order status, keeps the number, and voids shipment-scoped
certs..."` test now also reads the cert's own `action: "delete"` audit-log row and asserts
`reason === "loaded onto the wrong truck"` — the identical reason string the shipper's own delete
entry carries — matching the assertion shape already used for the shipper's own entry in the
`"writes a delete audit entry carrying the reason"` test. §5.6's "with the same reason" is now an
observed fact for both the shipper and the cascaded cert, not inferred from the source sharing one
`why` variable.

### Minor 2 — the pluralized multi-shipment refusal branch was unexercised

`tests/order-ship-invariants.test.ts` gets one new test, `"names every live shipment, pluralized,
when more than one blocks the same order"`: ships the SAME order line via two SEPARATE `createShipper`
calls (over-shipping only warns, never blocks — spec §5.1/§5.7 — so this is legal), then calls
`voidOrder` and asserts the thrown message matches both shipment numbers followed by "shipments"
(plural) — exercising `shipmentBlockerTail`'s `blockers.length > 1 ? "s" : ""` branch in
`src/server/orders.ts`, which every other test in the file (each blocking on exactly one shipment)
left untouched.

### Files changed (this round)

- `src/server/shippers.ts` — `removeOrderFromShipper` voids the removed order's shipment-scope
  cert at removal time; `removeOrderFromShipper`'s and `voidShipper`'s doc comments corrected.
- `tests/shipper-void.test.ts` — `vi.mock("@/server/order-locks", …)` + `claimOrdersInOrderMock`
  (mirroring `shipper-children.test.ts`'s own pattern), `twoOrderInput`/
  `twoOrderShipmentWithShipmentCertOnFirst` fixtures, the audit-reason assertion (Minor 1), and the
  new Important-finding regression test.
- `tests/order-ship-invariants.test.ts` — the pluralization test (Minor 2).

### Covering tests re-run (as requested) + gates

```
tests/shipper-void.test.ts          7 passed  (was 6; +1 regression test)
tests/shipper-children.test.ts      43 passed (unchanged — removeOrderFromShipper's new cert-void
                                                 step touches no order without a cert, so every
                                                 existing fixture there, none of which uses
                                                 certRequired/certScope, is unaffected)
tests/certs.test.ts                 35 passed (unchanged)
tests/ship-ledger.test.ts           15 passed (unchanged, from round 1's fixture fix)
tests/order-ship-invariants.test.ts 7 passed  (was 6; +1 pluralization test)

npm test         → 87 files, 1230 tests passed
npx tsc --noEmit → clean
npx eslint src tests → clean
```

### Concerns

None. The Important finding's fix is provably correct by the claim-coverage argument in
`voidShipper`'s corrected doc comment, and the regression test demonstrates it was a real,
reachable gap (RED without the fix, at the exact assertion the review's repro predicts) rather than
a defensive comment change with nothing behind it.

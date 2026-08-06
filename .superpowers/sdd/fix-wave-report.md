# Fix-Wave Report — Phase 4 whole-branch review (2026-08-06)

Executed against BASE b785d1f on `phase-4-certs-shipping`. Five items (three Important + two
riding minors), five commits, nothing from the backlog touched.

| # | Item | Commit |
|---|------|--------|
| 1 | Voided-guard row locks + discriminating races + house rule | `c52710f` |
| 2 | shippedTotals cents summation + test | `aff4107` |
| 4 | shipper-documents route test symmetry | `88715a7` |
| 5 | Tooltip fall-throughs (§5.16) | `9d840b6` |
| 3 | Notes-clobber trio — one shape, three pages, one commit | `ad025e9` |

(Executed in that order; item 3 last because its browser verification needed the dev server.)

---

## Item 1 — Voided-state guard rides the row lock, not SSI (Important #1)

**Fix.**
- `src/server/order-locks.ts:122-136` — `claimCertsOrder` now takes
  `SELECT "id" FROM "Cert" WHERE "id" = $1 FOR UPDATE` (one statement) **after** `claimOrder`.
  Covers every consumer's post-claim re-read: `updateCert` (certs.ts:403), `voidCert`
  (certs.ts:632), `printCert` (certs.ts:600-602), `replaceReadings` (cert-results.ts:220-221).
- `src/server/shippers.ts:637-645` — new `claimShipperRow` (one-statement `FOR UPDATE` on the
  Shipper row); `src/server/shippers.ts:647-673` — `claimLiveShipper` restructured to the one
  fixed sequence: unlocked stub (404 on missing, exists only to learn the order set) →
  `claimOrdersInOrder` over current orders plus `extraOrderIds` (addOrderToShipper's incoming
  order rides the SAME single ordered statement, so no sequential-claim ABBA reopens) →
  `claimShipperRow` → fresh liveness re-read under the lock. All seven mutator call sites
  (updateShipper, addOrderToShipper, removeOrderFromShipper, the three replaces, voidShipper)
  now destructure `{ shipper, orderIds, claimed }` from it and dropped their own separate
  `shipperOrderIds` + `claimOrdersInOrder` calls.
- `src/server/shippers.ts:1324` (printShippingTickets) and `:1433` (printBol) — the review's
  genuinely unprotected paths — take `claimShipperRow` after their order claims, before the
  `assertPrintable` re-read. (These deliberately keep their own shape rather than
  `claimLiveShipper`: a void must answer with the shared 400, not a 404.)
- Lock order is globally fixed — Order rows (one ordered statement) → Shipper row → Cert row —
  and `claimCertsOrder` (Order → Cert) and `voidShipper`'s cert cascade (Orders → Shipper →
  Cert writes) are both consistent with it, so no new ABBA window exists anywhere.
- House rule added to `src/server/order-locks.ts:20-30` (file header): **"the guarded state must
  live on, or be locked with, the claimed row"** — with the full argument and a pointer for
  Phase 5's reversing shipments.

**Discriminating tests (the ledger's T5 technique — competing voider scripted at DEFAULT/Read
Committed isolation so SSI is off the table; real happens-before edge: the holder signals only
after its `FOR UPDATE` is awaited, never a sleep; a 200 ms timeout-probe confirms the claimant is
genuinely blocked before the void is released).**
- `tests/certs.test.ts:541-611` — `replaceReadings` racing voidCert on the same cert.
- `tests/shipping-ticket.test.ts:283-330` — `printShippingTickets` racing voidShipper (the
  "if cheap" extra — it was).

**RED evidence, verbatim, against pre-fix code** (tests written and run before any lock change —
no stash needed):

```
FAIL tests/certs.test.ts > voided-state guard rides the Cert row lock, not SSI (fix-wave
Important #1) > replaceReadings racing a Read-Committed voidCert never writes readings through
a void that committed while it was blocked
AssertionError: promise resolved "{ …(21) }" instead of rejecting
```
— and the assertion diff showed the resolved CertDetail carrying the written reading
(`"value": 42` under the requirement) on the voided cert: the write went through the void.

```
FAIL tests/shipping-ticket.test.ts > printShippingTickets > racing a Read-Committed
voidShipper, a void committed while the print blocked on the order claims archives NOTHING
(fix-wave Important #1)
AssertionError: promise resolved "{ …(4) }" instead of rejecting
```
— the print resolved and archived a StoredDocument against the voided shipment, exactly the
§5.6 violation the review predicted.

**GREEN post-fix:** both tests pass — the Serializable competitor's `FOR UPDATE` on the
concurrently-updated row raises 40001 (P2010-wrapped, already mapped by
`isRawSerializationFailure`, db-errors.ts:32-36) → `withDbErrors`' honest 409; zero readings
written, zero documents archived. Both assertions pinned (`status: 409` + count checks).

## Item 2 — shippedTotals cents summation (Important #2)

**Fix.** `src/server/ship-ledger.ts:40-58` — weight accumulates as
`Math.round(weight.toNumber() * 100)` per row and divides by 100 once at the end (the
`toShipperRow` idiom the review cites); qty is an int and is untouched. Exactly the review's
named scope — no other site changed.

**Test.** `tests/order-ship-invariants.test.ts:124-155` — a 0.30-weight rider line shipped
0.10 + 0.20 across two real `createShipper` shipments: `updateLine` to exactly `0.3` succeeds
(no §5.5 refusal), and `overshipWarnings(getShipper(...))` is `[]`. **Verified RED pre-fix** with
the review's exact artifact in the refusal:
`"cannot reduce weight below 0.30000000000000004 lbs already shipped"`. GREEN post-fix.

## Item 3 — Notes-clobber trio: ONE shape, THREE pages, ONE commit (Important #3)

**The one mechanism: per-field dirty-since-focus preservation** — `src/lib/use-edit-guard.ts`
(new, client-safe). It grows the focus-snapshot blur no-op guard all three pages already shared
into three pieces: `onFocusField(key)` (the old snapshot, plus WHICH top-level property of the
page's detail object is under the cursor — one slot suffices, only one field can hold focus),
`onBlurSave` (the old no-op guard, unchanged semantics, `trim` supported, clears the slot), and
`merge(cur, incoming)` (every set-state-from-server-detail routes through it: the incoming detail
lands wholesale UNLESS the focused field changed since focus, in which case that ONE property
keeps the user's in-flight text; a focused-but-untouched field takes the server value and
re-snapshots the guard so a later blur never "saves" a change nobody typed).

**Why each page's variant is the same shape (the sibling-split rule):** all three bind text
inputs as controlled values straight to one fetched entity object, save per-field on blur, and
apply arriving server details over that object wholesale — so the identical clobber (a sibling's
save response or §5.13's rollback `load()` resetting the field being typed in) gets the identical
cure: same hook, same three entry points, differing only in which object and which apply sites.
- `src/app/certs/[id]/CertDetail.tsx` — object `cert`; apply sites `load` (:172) and
  `applyMutation` (:187) now merge; `freeform`/`internalNotes` textareas register their keys
  (:474, :487). Covers the review's named `patchNotes` clobber (success response AND failure
  rollback).
- `src/app/shipping/[id]/ShipmentDetail.tsx` — object `shipper`; apply sites `load` (:214) and
  `applyMutation` (:225) merge; the eight header text fields (route, comments, freightAmount,
  freightClass, freightDescription, packageCount, proNumber, scacCode) register keys. Covers the
  named `patchHeader` clobber.
- `src/app/customers/[id]/page.tsx` — object `c`; apply site `load` (:133, the ONLY place `c` is
  set from the server — `save()` success applies no detail, so the failure-path `load()` the
  review named, plus `saveParent`/`call`'s reloads, are all covered by this one site); the nine
  `c`-bound text fields register keys via `noteFocusC`; address/contact grid cells keep the plain
  no-op guard (they bind to the separate row arrays, not `c` — see Concerns). The
  `requestDaysOverride` non-integer rollback now uses the guard's own `atFocus` snapshot
  (commit's second argument) instead of the removed `focusedValue` ref.

**Browser verification (honest account).** No component-test harness exists, so all three pages
were exercised against `npm run dev` (dev DB, admin/admin) with Playwright, using a deliberate
slow save: `window.fetch` monkey-patched in-page to delay PATCH/PUT **responses** by 2500 ms.
Fixture (customer FXW1 + orderable part with an inspection + order → auto ORDER-scope cert +
one shipment) was seeded through the app's own services and removed afterwards.
1. **CertDetail:** typed into Freeform → blurred into Internal notes (PATCH dispatched, delayed)
   → typed into Internal notes while the response was in flight. After the response applied:
   `freeform: "Freeform note saved on blur"`, `internalNotes: "Internal text typed while the
   freeform PATCH is still in flight"`, focus retained. Blurred internal notes, hard-reloaded the
   page: **both values persisted** — the typed text survived AND saved.
2. **Customers (failure path):** blanked the customer code → blurred into "At shipping" notes
   (PUT dispatched, delayed; server 400) → typed during the rollback. Result: error banner
   `"code: Too small: expected string to have >=1 characters"`, code rolled back to server truth
   `FXW1`, and `shippingNotes: "Shipping note typed during the failed code save's rollback"`
   intact and focused — rollback everywhere except under the cursor, exactly §5.13 minus the
   eaten keystrokes.
3. **ShipmentDetail:** typed Route → blurred into Comments (PATCH delayed) → typed during
   flight. Result: `route: "North dock"` (saved), comments text intact; after blur + reload both
   persisted.

## Item 4 — Shipper-documents route test symmetry

`tests/shipper-routes.test.ts:449-458` — added `expect("fileData" in docs[0]).toBe(false)` and
the 404-unknown-shipper case, mirroring `tests/cert-routes.test.ts:276-287`. (The route behavior
already existed — `listDocumentsForShipper` 404s at documents.ts:175-177 — this is coverage
symmetry only; both new assertions pass.)

## Item 5 — Tooltip fall-throughs (§5.16)

- `src/app/shipping/[id]/ShipmentDetail.tsx:684-691` and
  `src/app/shipping/[id]/ShipmentOrderPanel.tsx:275-283` (both components render the checkbox):
  the "Also print certification(s)" label's title is now `certsGate.title ?? printGate.title` —
  on a voided shipment with certs.view held it says "Shipment is voided — stored prints stay
  available" instead of nothing.
- `src/app/certs/[id]/CertDetail.tsx:429-436`: the print button while `printing` carries
  `"A print is already in progress — wait for it to finish"`; otherwise `printGate.title` as
  before.

---

## Gates (all run from erp/, after the final commit)

```
npm test            Test Files 97 passed (97) | Tests 1360 passed (1360)   [116s]
npx tsc --noEmit    clean (exit 0)
npx eslint src tests  clean (exit 0)
npm run build       clean — standalone build produced, all routes compiled
npm run test:e2e    All 15 flows passed:
  PASS template-build-and-load / typed-fields / revision-cut / blocked-code-delete /
       permission-gating / processes-list / order-entry-full / board-search-scan /
       loads-after-print / void-order / ship-partial-then-complete / multi-order-shipment /
       cert-results-print / void-shipment / credit-hold-block-and-override
```

(1360 vs the review's 1357: +3 new tests — the two discriminating races and the cents test;
item 4's additions extend an existing test case.)

## Concerns

1. **Residual float artifact in `saveNewShipper`'s §5.7 warning (shippers.ts:591-598, out of
   scope, cosmetic only).** The at-save warning computes `remainingWeight = ordered − prior` as a
   float subtraction, so 0.3 − 0.1 can still *display* `0.19999999999999998 lbs` in the warning
   text and warn spuriously on an exact-remainder save. The review's item 2 fix is scoped to
   `shippedTotals` (which I followed exactly); this residual site never blocks anything (§5.7
   warns, never blocks) and the review's own prescribed test does not reach it — but it is the
   same cents idiom one line deep if the re-review wants it swept. Backlog-shaped.
2. **Item 3 scope: address/contact grid cells on the customers page** still bind to the separate
   `addresses`/`contacts` row arrays, which `load()` replaces wholesale — a rollback landing while
   typing in an address cell can still reset that cell. The review named the trio's entity-object
   fields (the notes pair et al.), and extending the guard to keyed row arrays is a different
   (per-row) shape; deliberately not gold-plated into this wave.
3. **`merge` protects exactly one field — the focused one.** Text typed into field A, *not
   blurred*, then focus moved to field B and typed: A was committed on blur by definition of the
   flow (focus change = blur = save), so no second slot is needed; but a programmatic
   value-holding-without-focus pattern (none exists on these pages today) would not be protected.
   Named so the re-review can judge the boundary.
4. **Dev-DB browser fixture:** seeded and fully removed (hard-deleted, the e2e harness's own
   dev-DB cleanup precedent); dev DB left as found. The E2E run happened with the fixture present
   and all 15 flows passed anyway.
5. `claimLiveShipper` still learns the order set from an unlocked pre-claim read (unavoidable —
   the first lock lives on the orders; documented in its comment). A concurrent order-set change
   between stub and claim serializes through the Shipper row lock all mutators now share, and
   Serializable + the new lock turns the residue into the standard 409.

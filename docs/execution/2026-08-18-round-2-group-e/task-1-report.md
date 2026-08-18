# Task 1 — #139 + #140: the shipper pair guards · implementer report

**Commit:** `fc93b11` on `group-e-close-gl`. **No schema migration** — everything rides
`reversesShipperId` and `coveredOrderIds`, as the brief requires.

## What was built

### #139 — freeze the pair (`erp/src/server/shippers.ts`)

One guard inside `claimLiveShipper`, immediately after its post-claim liveness re-read — the
chokepoint the brief's recon verified is called by exactly the six edit doors (`updateShipper`,
`addOrderToShipper`, `removeOrderFromShipper`, `replaceShipperLines`, `replaceShipperContainers`,
`replaceShipperSerials`) and nothing else, so `reverseShipperInTx` (step 6b's flag clear),
`voidShipper`'s restore, and both print paths (including `printBol`'s lazy first-print `bolNumber`
write) stay exempt by construction. Two checks, in the brief's order:

1. **Target IS a reversal** (`reversesShipperId !== null`): refuse ALWAYS, regardless of the
   original's liveness (the safe direction for corrupt pre-#65 data), naming the original's
   packing-list number via one `findFirst` by id — *"This is a reversal of Packing List \<n\> — a
   reversal is machine-generated mirror paper; void it and re-reverse instead of editing it"*.
2. **A live reversal points AT the target**: the exact `findFirst` shape `voidShipper`'s blocker
   and `reverseShipperInTx`'s 3b refusal already use (`orderBy: { shipperNumber: "asc" }`) —
   *"This shipment has been reversed by Packing List \<n\> — void the reversal first, then edit,
   then re-reverse"*.

The code comment states the lock argument verbatim from the brief: every writer that changes
pair-liveness claims the target's own Shipper row (`reverseShipperInTx` claims the original before
creating; `voidShipper` claims both rows via `claimShipperRows`), so the post-claim reads are
serialized against creation and void at any isolation — **no pair claim was added**, and the
comment says not to add one. The stale "incidental protection" remarks were updated in both places
that carried them (`voidShipper`'s discovery-union comment and the prose note at the
shipper-void test — both now say the freeze is explicit and the discovery-union survives for
pre-freeze data).

### #140 — coverage-precise removal guard (`erp/src/server/shippers.ts`)

`removeOrderFromShipper`'s printed-paper predicate is now the exact branch
`listDocumentsForOrder` uses (`documents.ts:219`):

```ts
OR: [{ orderId: target.orderId }, { orderId: null, coveredOrderIds: { has: target.orderId } }]
```

Refusal message unchanged (it already names the covering document). The function's doc comment and
the inline comment now state the coverage rule and the pre-#52 over-coverage direction.

### UI affordance (`erp/src/app/shipping/[id]/ShipmentDetail.tsx` + one detail field)

- `ShipperDetail` (server) gained `reversesShipperNumber: number | null` via a
  `reverses: { select: { shipperNumber: true } }` entry in `DETAIL_INCLUDE` — deliberately NOT
  live-filtered (the reversal side freezes regardless of the original's liveness), the comment
  says so. Needed so the reversal side's banner/titles can name the pair; the brief's "server's
  sentence as title" is otherwise unbuildable from the reversal's own page.
- `pairLocked(gate, freeze)` beside the existing `voidLocked` (§5.16 disabled-says-why), applied
  inside `voidLocked` so a voided document still reads "Shipment is voided". `pairFreeze` is
  worded exactly as the two server refusals. `editGate` carries it; `extendGate` inherits (it is
  built from `editGate`), which covers header save, add order, remove order, and all three grid
  editors + their save buttons. `voidGate` and `printGate` are untouched — voiding the reversal is
  the blessed undo, and prints must keep working.
- One amber banner naming the pair, after the voided banner, hidden when voided.

## RED table (every failure watched before implementing)

| Test | Watched RED reason |
|---|---|
| `shipper-void` › refuses every edit door on the ORIGINAL of a live pair | `promise resolved "{ …(26) }" instead of rejecting` (first door, `updateShipper`) |
| `shipper-void` › refuses every edit door on the REVERSAL | `promise resolved "{ …(26) }" instead of rejecting` — a reversal was freely editable |
| `shipper-void` › correction flow (reverse → refused → void → edit → re-reverse) | first edit `resolved instead of rejecting` |
| `shipper-void` › a reversal stays frozen even when its original is voided | `resolved instead of rejecting` |
| `shipper-void` › printBol on a reversed original still succeeds | **passed pre-change** — a deliberate pin of the exemption the chokepoint placement buys; watched green in the RED run |
| `shipper-void` › the detail carries the pair's numbers from both sides | `expected undefined to be 1000` — `reversesShipperNumber` did not exist |
| `shipper-children` › order added after a whole-set print removes freely (#140) | rejected with `Shipment paper covering this order has already printed (Packing List 1000)` — `orderId: null` treated as covering everything |
| `shipper-children` › whole-set print blocks exactly the orders its coverage names (#140) | the un-named sibling's removal `rejected … instead of resolving` |
| `shipper-children` › #139 freeze fires before the printed-paper guard | message was the printed-paper sentence, expected `This shipment has been reversed by Packing List 1001 — void the reversal first, then edit, then re-reverse` |

## Existing-test adjustments

**None behavioral.** No existing test edited a live pair through a mutator (verified by grep:
`reverseShipper` appears only in `shipper-reverse.test.ts` and `shipper-void.test.ts`, neither of
which calls an edit door on a pair; the #65 membership-shrink test uses raw deletes, exactly as
its comment now explains). Two prose-only comment updates, both required by the brief:

- `tests/shipper-void.test.ts` (old lines 330–337): the "refused only INCIDENTALLY" note now
  references the explicit `claimLiveShipper` freeze; the raw-delete technique's justification is
  now "the state data written before the freeze could already hold".
- The matching sentence inside `voidShipper`'s discovery-union comment in `shippers.ts`.

No #65 test was weakened; all 25 `shipper-void` tests (including the seven #65 ones and the
pair-claim blocking test) pass unmodified in behavior.

## Gate results

| Gate | Result |
|---|---|
| `npx vitest run tests/shipper-void.test.ts tests/shipper-children.test.ts` | 83/83 pass |
| `npx vitest run tests/shipper-reverse.test.ts tests/shippers.test.ts tests/shipper-routes.test.ts tests/invoice-guards.test.ts tests/shipping-ticket.test.ts tests/bol-templates.test.ts` | 141/141 pass |
| `npm test` (full suite) | **184 files, 3175 tests, all pass** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run test:e2e` | **not run here** — the group brief schedules E2E "in background near the end" of the group (UI touched: ShipmentDetail, BatchDetail, Close.tsx across tasks); flagged for the group-end run |

## For the reviewer to scrutinize

1. **Guard order inside the edit doors.** The freeze fires before `refuseIfInvoiced` (it lives in
   `claimLiveShipper`, which every door calls first). The void path deliberately has the OPPOSITE
   precedence (invoice first — pinned by the #65 test "an invoiced pair is refused on both sides
   with refuseIfInvoiced's message"). The brief specifies the freeze's placement inside
   `claimLiveShipper` and the interplay assertion (#139 before #140) but never demands
   invoice-first for the edit doors; on an invoiced pair an edit refusal now names the reversal
   rather than the invoice. Both sentences point at server-refused-anyway actions in that corner
   case (`void the reversal` is ALSO refused on an invoiced pair). If the owner wants
   invoice-precedence on the edit doors too, it is a two-line reorder — but it would move the
   guard out of the chokepoint or thread invoice state into it, which the brief's design argues
   against.
2. **`reversesShipperNumber`** is a small widening of `ShipperDetail` not literally listed in the
   brief's key facts (which name only `reversesShipperId`/`reversedByShipperNumber`). Without it
   the reversal-side UI cannot name the pair ("the server's sentence as title"). It rides the
   existing `DETAIL_INCLUDE` join; no route or schema change.
3. The `?? "?"` fallback in the check-1 message is unreachable in production (soft deletes only;
   the FK row always exists) — it exists because `findFirst` types nullable, matching the
   `order?.orderNumber ?? "?"` idiom already in the file.

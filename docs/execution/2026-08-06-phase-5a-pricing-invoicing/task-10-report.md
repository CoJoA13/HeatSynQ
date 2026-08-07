# Task 10 report — `invoice-guards.ts` + the new order and shipment invariants

**Commit:** `cfc904c feat: invoice guards — charges freeze, order void and shipment edits refuse once invoiced`
**Branch:** `phase-5a-pricing-invoicing`

---

## 0. A mismatch in the launch instruction, resolved before starting

The dispatch prose described Task 10 as *"the layer that feeds the pricing engine real data — reads
an order's shipped totals, its part price rows, the surcharge definitions and customer overrides,
and the plant billing config, assembles the engine's inputs, and calls it"*, and asked me to report
on how I keep a zero-net-shipped line away from `priceOrder`.

That is **Task 11** (`invoices.ts` — candidates and creation), not Task 10. Both binding sources
agree with each other and disagree with the prose:

- `docs/execution/2026-08-06-phase-5a-pricing-invoicing/task-10-brief.md` line 1 — *"Task 10:
  `invoice-guards.ts` + the new order and shipment invariants"*;
- `docs/superpowers/plans/2026-08-06-phase-5a-pricing-invoicing.md` line 1510 — the identical
  heading and body, byte-for-byte the same task.

I implemented the **brief and the plan** (invoice-guards), since the plan is binding and the brief I
was explicitly told to read first is its verbatim copy. **The zero-net-shipped question does not
arise in this task** — nothing here calls `priceOrder`, reads `shippedTotals`, or constructs an
engine input. It is a real and important question for whoever takes Task 11; the seam is untouched
by this commit.

---

## 1. What was implemented

### `src/server/invoice-guards.ts` (new, 87 lines) — a leaf

Exactly the brief's three exports, plus one internal deviation noted in §4:

| Export | Behaviour |
| --- | --- |
| `finalizedInvoiceFor(tx, orderId)` | The live, FINALIZED, `kind: "INVOICE"` row for one order, or `null`. |
| `finalizedInvoicesFor(tx, orderIds)` | Batched form, one query; `[]` short-circuits without a round trip. |
| `invoiceBlockMessage(inv, action)` | `"<action> — Invoice <orderNumber> is finalized; unlock it or raise a credit (see /invoicing/<id>)"` |

The three filter clauses are hoisted into one `FROZEN` constant so the two readers cannot drift
apart on what "frozen" means. The module imports **only** `import type { Prisma }` from the
generated client — no `HttpError`, no service. Each caller raises its own `HttpError(400, …)`, which
is what keeps the file importable from anywhere. A test pins the import shape (§3).

### The five invariants wired

Each sits inside the mutator's existing claimed, Serializable transaction, **after** the claim and
**before** any write.

| File | Function | Guard | Message action |
| --- | --- | --- | --- |
| `orders.ts` | `replaceCharges` | `finalizedInvoiceFor(tx, orderId)` | `"Charges cannot be changed"` |
| `orders.ts` | `voidOrder` | `finalizedInvoiceFor(tx, id)` | `"This order cannot be voided"` |
| `shippers.ts` | `voidShipper` | `refuseIfInvoiced(tx, orderIds, …)` | `"This shipment cannot be voided"` |
| `shippers.ts` | `replaceShipperLines` | `refuseIfInvoiced(tx, orderIds, …)` | `"This shipment cannot be changed"` |
| `shippers.ts` | `addOrderToShipper` | `refuseIfInvoiced(tx, allOrderIds, …)` | `"This shipment cannot be changed"` |

`refuseIfInvoiced` is a small private helper in `shippers.ts` (not a fourth export from the leaf) —
three call sites, one sentence of policy, and it keeps the leaf free of `HttpError`.

---

## 2. TDD evidence

### RED — `npx vitest run tests/invoice-guards.test.ts`, tests written, module absent

```
 RUN  v3.2.7 /home/cjones/Desktop/HeatSynQ/erp

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/invoice-guards.test.ts [ tests/invoice-guards.test.ts ]
Error: Cannot find module '@/server/invoice-guards' imported from
'/home/cjones/Desktop/HeatSynQ/erp/tests/invoice-guards.test.ts'.
 ❯ tests/invoice-guards.test.ts:10:1

 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN — after `invoice-guards.ts` + the five call sites

```
 ✓ tests/invoice-guards.test.ts (17 tests) 1001ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

### No regression in the neighbours (brief Step 5)

```
$ npx vitest run tests/invoice-guards.test.ts tests/orders.test.ts tests/shippers.test.ts \
      tests/shipper-void.test.ts tests/shipper-children.test.ts

 ✓ tests/orders.test.ts (127 tests) 6279ms
 ✓ tests/shipper-children.test.ts (55 tests) 4001ms
 ✓ tests/shippers.test.ts (26 tests) 1521ms
 ✓ tests/invoice-guards.test.ts (17 tests) 1087ms
 ✓ tests/shipper-void.test.ts (7 tests) 674ms

 Test Files  5 passed (5)
      Tests  232 passed (232)
```

`shipper-children.test.ts` was added to the brief's list on purpose — it is where
`addOrderToShipper` and `replaceShipperLines` are actually covered, and the brief's list omitted it.

---

## 3. Mutation testing — would each test fail if the behaviour regressed?

This is the whole review for a money guard, so I ran it rather than asserting it. Each mutation was
applied to the real source, the focused suite run, then the source restored (script:
`scratchpad/mutate.sh`). **All twelve were caught.**

| # | Mutation | Result |
| --- | --- | --- |
| M1 | drop `kind: "INVOICE"` from `FROZEN` | 2 failed / 15 passed |
| M2 | drop `status: "FINALIZED"` | 4 failed / 13 passed |
| M3 | drop `deletedAt: null` | 1 failed / 16 passed |
| M4 | drop `orderBy` from `finalizedInvoicesFor` | 1 failed / 16 passed |
| M5 | remove the `replaceCharges` guard | 1 failed / 16 passed |
| M6 | remove the `voidOrder` guard | 2 failed / 15 passed |
| M7 | remove the `voidShipper` guard | 1 failed / 16 passed |
| M8 | narrow `replaceShipperLines` to the edited order only | 1 failed / 16 passed |
| M9 | narrow `addOrderToShipper` to the existing orders only | 1 failed / 16 passed |
| M10 | remove the `addOrderToShipper` guard | 2 failed / 15 passed |
| M11 | remove the `replaceShipperLines` guard | 2 failed / 15 passed |
| M12 | move the `voidOrder` guard AFTER `shipmentBlockers` | 1 failed / 16 passed |
| — | restored | **17 passed** |

Two of these needed the test to be *made* discriminating rather than merely present:

- **M4** originally passed. The batched test created `a`'s invoice before `c`'s, so insertion order
  already matched the expected ascending-order-number output and the `orderBy` was doing no
  observable work. I inverted the fixture (invoice `c` first, `a` second) so the expectation now
  holds **only** because of the explicit `orderBy`. It fails without it.
- **M12** is the one that pins a placement decision rather than a line of code — see §4.

The 17 tests: 3 on `finalizedInvoiceFor` (draft/finalized/discarded lifecycle; a finalized CREDIT
ignored; scoping to the asked-about order), 2 on `finalizedInvoicesFor` (empty list; the
filter-and-sort contract), 1 on `invoiceBlockMessage`, 4 order-side, 6 shipment-side, 1 import shape.
Negative controls are deliberate throughout: a **draft** invoice blocks neither charges nor shipment
edits, which is what forces the guard to read `status` rather than merely "an invoice row exists".

---

## 4. Judgment calls, disclosed

**(a) `voidOrder`'s guard runs BEFORE `shipmentBlockers`, not after.** The brief said "after the
claim and before any write", which both orders satisfy; I chose invoice-first. An invoiced order has
necessarily shipped (you bill what shipped), so shipment-first would fire for essentially every real
case and tell the user to void the shipment — which `voidShipper`'s own new guard then refuses for
the same reason. Only the invoice message names a fix that works. Test:
*"names the invoice, not the shipment, when the order has both"* (M12).

**(b) `finalizedInvoicesFor` sorts by order number ascending — an addition to the brief's code.**
The brief's `findMany` had no `orderBy`. A shipment can carry two invoiced orders, and
`refuseIfInvoiced` names `[0]`; without an explicit order the sentence a user sees could change
between identical attempts. One clause, pinned by M4.

**(c) The shipment guards are batched over the WHOLE claimed order set, not the one `ShipperOrder`
being edited.** This is the brief's literal shape ("batched over `orderIds`", "Same guard in
`replaceShipperLines` and `addOrderToShipper`"), and I followed it — but it is a real behavioural
choice, so: on a five-order truck where order A is invoiced, order E's line grid can no longer be
corrected without unlocking A's invoice. I judged over-blocking the right side to err on (it is
undone by unlocking; under-blocking silently rewrites billed paper), and design §5.6 makes freight a
`Shipper`-level amount shared across the document, which supports the batched reading. **Flagged for
the owner in §6 in case the precise-per-order reading was intended.** Pinned by M8/M9.

**(d) `addOrderToShipper` guards over `allOrderIds` (current orders + the incoming one).** Both
directions are real hazards, and both are tested: adding any order to a shipment that already
carries an invoiced one, and adding an already-invoiced order onto a clean shipment. Placed after
the exists/voided/same-customer checks so a bogus or foreign `orderId` still gets its own truer
message, and before the duplicate check and every write.

**(e) The message prints the bare order number, not `invoice_number_prefix` + order number.** The
prefix is a setting; reading it would mean importing `settings.ts` and the module would stop being a
leaf. Documented in the source.

No other deviations. Nothing was added beyond the brief.

---

## 5. Gates

| Gate | Command | Result |
| --- | --- | --- |
| Unit/integration | `npm test` | **1584 passed**, 105 files (was 1567 / 104) |
| Types | `npx tsc --noEmit` | clean, exit 0 |
| Lint | `npx eslint src tests` | clean, exit 0 |
| Build | `npm run build` | succeeded |
| E2E | `npm run test:e2e` | **not run — deliberately** |

**Why E2E was skipped.** This task touches no page, no component and no route handler — only two
service modules and one new leaf. Every added refusal fires *only* when a FINALIZED `Invoice` row
exists, and nothing reachable from the browser can create one yet: `invoices.ts` is Task 11, the
`/invoicing` pages are Tasks 17–18, and the routes are Task 16. The tests here write the fixture
with the raw client for exactly that reason. A Playwright run would exercise the unchanged paths at
a cost of several minutes for zero signal.

---

## 6. Concerns for the coordinator

**Four shipment mutators are still unguarded, and the brief did not list them.** I implemented
exactly the three it named rather than inventing scope, but two of the four look like genuine holes
in the same invariant and should be ruled on before the whole-branch review:

1. **`removeOrderFromShipper` (`shippers.ts:974`) — the most pointed one.** It is the exact mirror
   of `addOrderToShipper`, which *is* now guarded, and it hard-deletes a `ShipperOrder` and its
   children, i.e. it *removes* shipped quantity from an order that may have a finalized invoice.
   A reviewer will notice the asymmetry immediately.
2. **`updateShipper` (`shippers.ts:785`) — money.** Its patch includes `freightAmount` and
   `billFreight`, which feed the invoice's freight line. Editing them after finalize changes what
   was billed, which is precisely what design §5.7 forbids.
3. **`replaceShipperContainers` (`:1239`)** and **`replaceShipperSerials` (`:1304`)** — lower risk:
   containers and serials do not price (pricing is per operation on line qty/weight), but they do
   change the ticket/BOL the customer holds.

Each is a one-line `await refuseIfInvoiced(tx, orderIds, "This shipment cannot be changed");` after
the existing `claimLiveShipper`, plus a test apiece — cheap to add in a fix wave. **I did not add
them because the brief and the plan both enumerate exactly three, and an undisclosed scope
expansion is its own failure mode in this process.** Please rule.

**Also worth confirming:** §4(c), the batched-vs-precise reading of the shipment guard.

**A contract Task 13 must honour.** `finalizedInvoiceFor` is safe only because every writer of
`Invoice.status` claims the invoice's Order row before writing — the order-locks house rule read
from the other side. Finalize and unlock must open with `claimOrder(tx, orderId)`. This is stated in
the function's doc comment so the obligation is discoverable from the guard, but it is an obligation
on a task that does not exist yet.

**Docs.** Per this phase's convention (every implementer commit is code-only; `docs:` commits are
the coordinator's), I made no change to `docs/HANDOFF.md`, the spec, or `CLAUDE.md`. Candidates for
the coordinator's next docs commit: `invoice-guards.ts` as the **third** leaf module alongside
`errors.ts` and `order-locks.ts` (CLAUDE.md's architecture section names the first two), and the
Task 13 claim obligation above.

---

## 7. Files changed

| File | Change |
| --- | --- |
| `erp/src/server/invoice-guards.ts` | **new** — the leaf: two readers, one message builder |
| `erp/src/server/orders.ts` | import + guards in `replaceCharges` and `voidOrder` |
| `erp/src/server/shippers.ts` | import + `refuseIfInvoiced` helper + 3 call sites |
| `erp/tests/invoice-guards.test.ts` | **new** — 17 tests |

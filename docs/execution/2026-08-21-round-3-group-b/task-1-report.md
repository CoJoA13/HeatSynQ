# Task 1 — #161: the Reverse control — implementer report

**Branch:** `round-3-group-b`. **Files:** `erp/src/app/shipping/[id]/ShipmentDetail.tsx`,
`erp/tests/shipment-reverse-control.test.tsx` (new), `erp/e2e/flows/reverse-shipment.mjs` (new),
`erp/e2e/run.mjs` (registration only). Nothing under `src/app/api/certs/`,
`src/app/orders/[id]/CertificationsSection.tsx` or `src/server/certs.ts` was touched — Task 2 owns
that surface.

---

## 1. What changed

### `src/app/shipping/[id]/ShipmentDetail.tsx`

| Line | Change |
|---|---|
| 15 | `import { useRouter } from "next/navigation"` |
| 181–196 | **`reverseGate(perms, shipper)`** — exported pure gate, the four-rung ladder below |
| 198–210 | **`ReverseShipmentButton({ gate, busy, onClick })`** — exported presentational control |
| 264 | `const router = useRouter()` |
| 367–370 | `reverseControlGate` (null-shipper guard for the pre-load render) + `reversing` state |
| 664–692 | `reverseAction()` — prompt → `POST /api/shippers/[id]/reverse` → navigate to the reversal |
| 710–718 | The two header buttons wrapped in one flex row; Reverse renders **beside** Void |

Three shape decisions worth a reviewer's attention:

1. **`reverseAction` is not `applyMutation`.** Every other mutation on this page folds the response
   back into `shipper` state, because every other mutation returns *this* document. Reverse returns
   a **different** one — the newly created reversal — so folding it in would render the reversal's
   detail under the original's URL. It navigates instead (`router.push`, the `NewShipment` shape),
   and `page.tsx`'s `key={id}` remounts. Nothing is lost by navigating: `GET /api/shippers/[id]` is
   wrapped through `shipperResponse` too (`src/app/api/shippers/response.ts:17`), so the reversal's
   own load recomputes the identical §5.7 warning array the POST returned.
2. **`setReversing(false)` runs only in the catch.** On success the button stays in its
   "Reversing…" disabled state until the navigate remounts the page — which is also the double-submit
   guard for the window between the POST resolving and the route changing.
3. **The empty-reason refusal is the server's own sentence** (`"A reason is required to reverse a
   shipment"`, `shippers.ts:2111`), so the client-side short-circuit and the 400 cannot drift.

### `e2e/run.mjs`

One `FLOWS` entry, `reverse-shipment`, as **admin**, placed directly after `invoice-shipped-order`
and well before `close-month-end`, with a comment explaining the placement (below, §4).

---

## 2. The Reverse gate's rungs — and why `invoiceVoidBlock` is not one of them

`reverseGate` (`ShipmentDetail.tsx:181`) is a four-rung ladder in **`reverseShipperInTx`'s own guard
order**:

| # | Rung | Title | Enforced server-side at |
|---|---|---|---|
| 1 | `deletedAt !== null` | `Shipment is voided` | `src/server/shippers.ts:1946` — the post-claim re-read 404s `"Shipment not found"` on a soft-deleted original. Step 3's comment gives the reason it is not merely a 404 of convenience: a voided shipment already contributes 0 to the ledger, so its negatives would net a *different* live shipment down. |
| 2 | `reversesShipperId !== null` | `This shipment is itself a reversal of Packing List N — reverse the original shipment instead` | `src/server/shippers.ts:1947-1948` (`"That shipment is itself a reversal — reverse the original shipment instead"`) |
| 3 | `reversedByShipperNumber !== null` | `This shipment has already been reversed by Packing List N — void that reversal first` | `src/server/shippers.ts:1958-1966` — step 3b, the at-most-one-live-reversal guard (Codex PR #141 round 2). **Verbatim.** |
| 4 | otherwise | `gateDo(perms, "void_shipper")` → `Requires void_shipper` | `src/app/api/shippers/[id]/reverse/route.ts:12` — `mustDo(requireUser(), "void_shipper")`. The same special action Void uses; no `shipping.*` CRUD grant substitutes. |

Rung 2's title is the server's operative clause with the original's packing-list number spliced in
(§5.14's name-the-blocker habit — the server has no reason to name it, since its caller already
knows which id it posted to; a tooltip does). Rung 3 is word-for-word.

**Two server refusals are deliberately NOT rungs**, because no client can evaluate them honestly:

- a **voided order** on the shipment (`shippers.ts:1967-1972`) — order-level `deletedAt` is not on
  `ShipperDetail` at all;
- the **below-zero ledger guard** (`shippers.ts:1974-1994`) — it needs `shippedTotals` read *under
  the claim*, and a client-side approximation would be a second opinion that can disagree with the
  authoritative one.

Both stay the server's to report through the page's error banner. A guessed-at disabled title would
be worse than a truthful 400.

### Why `invoiceVoidBlock` is absent — argued from the service, not from the button beside it

`voidGate` (`ShipmentDetail.tsx:352-364`) puts `invoiceVoidBlock` second, because `voidShipper`
calls `refuseIfInvoiced(tx, orderIds, "This shipment cannot be voided")` **first**
(`shippers.ts:1778`), before its own reversal blocker. That is Void's contract, and the UI mirrors
it.

`reverseShipper`/`reverseShipperInTx` (`shippers.ts:1917-2121`) contains **no call to
`refuseIfInvoiced`, no call to `finalizedInvoiceFor`, and no reference to `Invoice` as a refusal at
all.** Its only guards are the ones tabled above plus the empty-reason check. The single place it
reads invoice state is `finalizedInvoicesFor(tx, orderIds)` at step 7 (`shippers.ts:2086`) — and it
reads it to decide **which orders get `status = REOPENED`**, i.e. the finalized invoice is an
*input to the happy path*, not a blocker on it. `tests/shipper-reverse.test.ts:134-139`
(`"sets REOPENED when the order has a finalized invoice"`) finalizes an invoice and then reverses
successfully; `:380` walks invoiced → reverse → unlock.

So a cloned ladder would have disabled the control in precisely the state the feature exists for,
and — as the brief predicted — would have read as correct in review because it matched its
neighbour. `tests/shipment-reverse-control.test.tsx` pins this twice: the rendered button stays
enabled with `invoiceVoidBlock` set, **and** the two gate objects (with and without the block) are
asserted deep-equal, so the field is proven absent from the *decision*, not merely from the title.
The E2E flow asserts the same thing against a real finalized invoice, with the Void beside it
disabled and naming that invoice in the same breath.

---

## 3. Ruling point 4 — the "void the reversal, edit, re-reverse" refusals

Five refusal sites instruct a correction whose last step is a reversal. Each was read and checked
against what a screen can now actually do:

| # | Where | Sentence | Verdict |
|---|---|---|---|
| 1 | `src/server/shippers.ts:831-833` (`claimLiveShipper`, the six edit doors) | *"This is a reversal of Packing List N — a reversal is machine-generated mirror paper; **void it and re-reverse** instead of editing it"* | **Now true.** Void: the reversal's own Void button (`reversedByShipperNumber` is always null on a reversal, so it stays on its own gate). Re-reverse: the original's Reverse button, which rung 3 re-enables the moment the reversal is voided. Both walked in the flow (steps 9 → 11). |
| 2 | `src/server/shippers.ts:842-844` (same function, original side) | *"This shipment has been reversed by Packing List N — **void the reversal first, then edit, then re-reverse**"* | **Now true**, with one caveat below. Also the page's `pairFreeze` banner (`ShipmentDetail.tsx:337`), verbatim. |
| 3 | `src/server/shippers.ts:1790-1792` (`voidShipper`'s #65 blocker) | *"This shipment has been reversed by Packing List N — **void the reversal first**"* | **True and unchanged in meaning** — it names an existing button. Mirrored on the Void title (`ShipmentDetail.tsx:363`) and asserted in the flow (step 8). |
| 4 | `src/server/shippers.ts:1963-1965` (reverse step 3b) | *"This shipment has already been reversed by Packing List N — **void that reversal first**"* | **Now true, and newly reachable** — before this task nothing could produce a second reversal attempt from a screen. It is now rung 3's title, so the operator meets it *before* clicking rather than as a 400. |
| 5 | `src/server/invoice-guards.ts:90-93` via `shippers.ts:388` | *"This shipment cannot be voided — Invoice N is finalized; **unlock it or raise a credit** (see /invoicing/N)"* | **True** — `/invoicing/<id>`'s Unlock button, walked in step 7 of the flow. Not a reversal instruction, but it is the step that stands between #2 and the operator. |

**The caveat, reported rather than silently fixed.** Sentence #2 says "void the reversal first". On a
pair whose order still carries a **finalized** invoice, `voidShipper` refuses *both* documents
(`refuseIfInvoiced` runs over the same order union and precedes the #65 blocker), so that first step
is itself refused — with sentence #5, which names its own way out. The full chain is therefore
*unlock the invoice → void the reversal → edit → re-reverse*, and every one of those four steps now
has a button. The **Void control** already gets this right: `voidGate` shows #5 before #3, which is
exactly why that precedence was built (Codex PR #141). The **`pairFreeze` banner** does not — it
prints #2 unconditionally, so on an invoiced pair the banner's first instruction is one step short.

I did not change it, for three reasons: it is worded identically to `claimLiveShipper`'s own refusal
and the two are deliberately kept in step (`ShipmentDetail.tsx:334-339`); reworking it means
reworking the server sentence too, which is a §5.16 wording change on a message that is not this
issue's; and the operator is never stranded — clicking Void produces #5, which names the unlock. The
flow pins the current behaviour at step 6 (banner #2 present, Void title still #5) and at step 8
(after unlock, Void title becomes #3), so a future decision either way starts from a test that
states what happens today. **Flagging it for the whole-branch reviewer as a possible small follow-up
issue, not a defect I left broken.**

---

## 4. The new E2E flow — `e2e/flows/reverse-shipment.mjs`

Registered at `e2e/run.mjs:94` as **admin** (needs `void_shipper`, held via `ALL_PERMISSIONS`),
directly after `invoice-shipped-order`.

**Why there.** It must run before `close-month-end`, which leaves the current month CLOSED —
`finalizeInvoice` is a posting mutation and `assertPeriodOpen` would refuse it. And like
`invoice-shipped-order` it deliberately ends with its invoice **unlocked**: a DRAFT has no
`finalizedAt`, so it can never enter the close's readiness or export scope, which means neither its
step codes nor the plant-wide surcharge become somebody else's fixture to backfill (the trap
`close-month-end.mjs`'s own header documents about `receivables-apply-age-statement`'s invoice).

**What it drives**, in order:

1. keys an order (invoicing fixture customer/part, qty 10) and ships it complete;
2. asserts Reverse is **enabled** with no title — the gate's base case;
3. invoices it through `/invoicing` and **finalizes**; board shows `· Invoiced`;
4. **the load-bearing assertion**: on the shipment, Void is disabled and its title matches
   `/^This shipment cannot be voided — Invoice .* is finalized; unlock it or raise a credit/`,
   while Reverse is **enabled with no title**;
5. clicks Reverse; asserts the prompt names `Reverse shipment (Packing List N)?` and
   `Reason for reversing (recorded in the audit history):`; lands on the reversal;
6. on the reversal: the #139 banner naming the original, the negated line
   (`Line 1 ship-now quantity` == `-10`), the header `Route` field `readOnly`, and Reverse disabled
   with rung 2's exact title;
7. **`OrderStatus.REOPENED`** — the board row reads `· Reopened`; ticking the board's own
   **Reopened** status filter still matches the row (the filter matches something for the first
   time), and — so the assertion cannot be vacuous — narrowing to **Open** instead produces
   `No orders match these filters.`;
8. back on the original: the pair-freeze banner (#2 above, exact text), Reverse disabled with
   rung 3's exact title, and Void **still** naming the invoice (the §5.7-before-#65 precedence);
9. unlocks the invoice; the board settles on `· Partially shipped` — never `Shipped`, because the
   reversal cleared the completion (the browser version of `shipper-reverse.test.ts:380`);
10. the original's Void title now becomes the **reversal** sentence (#3) — #65's own rung, only
    reachable once the invoice rung has cleared;
11. voids the reversal (the blessed undo) and sweeps **every** `main input, main select, main
    textarea, main button` on it, asserting the unlocked set is empty — the `void-shipment.mjs`
    assertion, run against the one document type only this flow can produce, plus a direct check
    that Reverse's title there is `Shipment is voided`;
12. the original is free again: Reverse and Void both enabled, banner gone, board back to
    `· Shipped` (the restore put the line-complete flag back);
13. **re-reverses**, asserting the new packing-list number is higher — the voided reversal's is
    never reused. Steps 11–13 are refusal sentence #2 walked with real buttons.

Two local helpers, both with the reasoning in their doc comments:

- **`armPromptOnce`** — `ui.mjs`'s `armPrompt` registers a *persistent* `page.on("dialog")`
  listener. This flow arms four dialogs on one page, and a lingering earlier listener would try to
  accept a later dialog twice ("Cannot accept dialog which is already handled!"). `page.once`
  self-removes; the `close-month-end.mjs` `armConfirmOnce` precedent, for prompts.
- **`waitForEnabled`** — the shipment page runs two independent fetches and the heading
  `waitForShipmentPage` waits on is gated only on the shipment detail; `usePermissions` lands
  separately, and `permission-ui.ts` reads an in-flight `undefined` as "no grants" (deliberately, so
  a control never flashes open then locks). So every **enabled** assertion polls. The **disabled**
  assertions need no equivalent: every rung this flow reads a title from sits *above* the permission
  rung in its ladder, so its verdict is identical either way.
- **`waitForReversalPage`** — never `waitForShipmentPage` alone after the navigate: the page being
  left also carries a `Packing List N` heading, so that wait can be satisfied by the old page. It
  waits on the reversal-only #139 banner first (the same reasoning `waitForShipmentPage`'s own
  comment gives for not using `waitForURL`).

---

## 5. Tests added, and which were RED-verified

`tests/shipment-reverse-control.test.tsx` — **10 cases**, `renderToStaticMarkup` on the real
`ReverseShipmentButton` fed by the real `reverseGate`. `isDisabled` matches `/\sdisabled=""/`, never
`toContain("disabled")` — the Tailwind classes contain the word, so the substring form passes with
the feature deleted.

RED-verified by mutating the implementation and re-running (each mutation reverted immediately):

| Mutation | Result |
|---|---|
| Clone `voidGate`'s `invoiceVoidBlock` rung into `reverseGate` | **1 failed** — "stays ENABLED when a finalized invoice blocks the VOID beside it". This is the exact defect the brief predicted, and the suite catches it. |
| Delete the `deletedAt` rung | **2 failed** — "is DISABLED on a voided shipment" and "puts the voided rung FIRST on a voided reversal" (the `void-shipment.mjs` sweep's two guards) |
| Drop `disabled={g.disabled \|\| busy}` from the button, keeping the `disabled:*` classes | **7 failed** — which is the proof that `isDisabled` is not vacuous; a `toContain("disabled")` assertion would have stayed green through this. |

The E2E flow is new in full, so all of it is "RED before the change" by construction — none of its
assertions can even be reached without the control (step 2 clicks a button that did not exist).

---

## 6. Gate results

```
npx tsc --noEmit                                 PASS
npx eslint src tests                             PASS
node --check e2e/flows/reverse-shipment.mjs      PASS
node --check e2e/run.mjs                         PASS
DATABASE_URL_TEST=…/erp_test_b1 npx vitest run   PASS — 206 files, 3518 tests, 430.92s
npm run test:e2e                                 23 of 24 PASS — NOT clean; see below
```

### `npm run test:e2e` in full

The DEV database was **pristine** before the run (`ps aux | grep next` showed no stale dev server)
and the harness reported `cleanup ok` afterwards, so it is pristine again.

```
PASS  template-build-and-load          PASS  invoice-shipped-order
PASS  typed-fields                     PASS  reverse-shipment          <- new
PASS  revision-cut                     PASS  receivables-apply-age-statement
PASS  blocked-code-delete              PASS  close-month-end
PASS  permission-gating                PASS  quotes
PASS  processes-list                   PASS  templates-admin
PASS  order-entry-full                 PASS  reports
PASS  board-search-scan                PASS  setup-checklist
PASS  loads-after-print                PASS  backups
PASS  void-order
PASS  ship-partial-then-complete
FAIL  multi-order-shipment             <- see below
PASS  cert-results-print
PASS  void-shipment                    <- the lock-every-control sweep, green
PASS  credit-hold-block-and-override

1 of 24 flow(s) failed.
```

**Both flows this task could plausibly have broken passed**: the new `reverse-shipment` (all 12
steps, no failure screenshot) and `void-shipment`, whose sweep asserts every `main button` on a
voided shipment is locked — the hazard the sizing note called out.

**The one failure, and why it is not this change.** `multi-order-shipment` timed out at
`multi-order-shipment.mjs:141` waiting for the missing-cert print warning. Its failure screenshot
(`e2e-artifacts/multi-order-shipment/10-failure.png`) shows why: the page rendered correctly — the
new Reverse control among it, enabled — but the print bar reads **`Failed to fetch`** and the
history panel below reads **`History could not be loaded.`**. Two unrelated requests failing at the
same instant is a network-level failure, not an assertion about the DOM; `Failed to fetch` is what
`printDoc`'s `fetch` rejects with when the connection dies, and nothing this task added can produce
it (the diff is a client-side button and one pure gate function — no server code at all).

**Confirmed twice.** (a) Re-running that flow **in isolation, with the change still in place:
PASS**. (b) A second full run reached 19 of the 24 flows — `multi-order-shipment` among them, this
time **passing** — with **no failure screenshot anywhere** before it was killed by a command
timeout during the tail of the list. It also sits at position 12 in `FLOWS` while `reverse-shipment`
is at 17, so the new flow cannot influence it even in principle. Recorded as an environmental flake
on the heaviest PDF-rendering route under `next dev`, not a regression — but recorded, not waved
away.

**So the honest statement is: one complete full run, 23/24, with the single failure reproduced as a
pass twice over. I do not have a clean 24/24 to point at.** The confirming run did not finish.

**Dev-DB hygiene after the killed run.** Being killed mid-flight, that run's `teardown()` never
completed, and it left fixtures behind (8 `E2E*` customers, the 4 `e2e_*` users, 21 sessions, 2
reversal shippers, and — the one that would have bitten the next run — a `ClosePeriod`, whose
existence makes `close-month-end.mjs`'s pre-flight guard refuse to run at all). Reaped by hand: the
`ClosePeriod` and its `GlExportBatch`/`GlPosting`/audit children first (mirroring
`db-fixtures.ts`'s own `deleteClosePeriodFixture`, scoped to periods closed by an `e2e_` user —
`reapLeftovers` deliberately does not sweep those, and the period's FK would otherwise block
deleting the fixture admin), then the harness's own `create()` self-heal followed by a full
`cleanup()`. **Verified empty afterwards**: 0 `E2E*` customers, 0 `e2e_*` users, 0 close periods, 0
sessions, 0 orders, 0 shippers, 0 invoices. The DEV database is as it was found.

---

## 7. What I could not verify mechanically

- **The click, the prompt and the navigate** are Playwright's alone — `vitest.config.ts` is
  `environment: "node"`, so there is no DOM, no events and no effects. The render test covers
  props-in/markup-out only; everything after `onClick` is covered by the E2E flow or not at all.
- **`reverseAction`'s error branch** (a 400 from the below-zero guard or a voided order) has no
  driver: the product cannot reach either state through the UI — at-most-one-live-reversal keeps the
  ledger non-negative by construction (`shipper-reverse.test.ts:235-263` builds the below-zero case
  from a *raw fixture* precisely because no product path reaches it). It is a plain
  `setError((e as Error).message)`, the same shape as `voidAction`'s.
- **The reversal's own PDF/print behaviour** was not exercised beyond what already existed.
- **Concurrency** — nothing new: the service was already `retryAllocation`-wrapped and claim-guarded,
  and this task added no server code at all.

## 8. Adjacent things noticed and not fixed

1. **The `pairFreeze` banner's instruction on an invoiced pair** — §3's caveat above. Reported, not
   changed; a candidate follow-up issue.
2. **Documentation is Task 3's**, per the brief's own split (`docs/manual/04-shipping.md` now
   describes a reversal story whose control exists; `docs/manual/walkthrough.md:39` and its
   "About #161" section at `:61` carry rows that this task makes stale; `docs/HANDOFF.md` needs the
   group entry). I deliberately left all of it alone so the two task diffs stay separate, as the
   owner asked — flagging it here so it is not lost.
3. **`e2e/lib/db-fixtures.ts` needed no change.** `Shipper.reversesShipperId` is
   `ON DELETE SET NULL` (`prisma/migrations/20260806221500_pricing_and_invoicing/migration.sql:263`),
   so the existing single `shipper.deleteMany` over the customer-scoped id set reaps a reversal pair
   without an ordering problem. Worth stating because this is the first flow ever to create one.

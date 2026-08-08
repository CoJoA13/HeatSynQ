# Task 12 report — `invoices.ts`: draft edits, recalculate, discard

## Status: DONE

## What I implemented

Four new exports on `src/server/invoices.ts`, all sharing one bracket
(`withDbErrors` → Serializable `$transaction` → `claimLiveInvoice` → `audited*` → writes on `tx`):

- **`updateInvoice(id, input)`** — header-only draft edit. Strict partial patch over the correctable
  header snapshots (`poNumber`, `invoiceDate`, `termsName`, `billTo`, `shipTo`). Customer/order
  identity, the line-derived totals, and the lifecycle columns are off-limits. Each field is an
  independent scalar, so the partial patch persists exactly what the caller sent and leaves no stale
  interdependent state (the Task 6 defect does not apply); one `auditedUpdate`.
- **`replaceInvoiceLines(id, input)`** — whole-array replace (the `replaceCharges` /
  `replaceShipperLines` precedent): delete every line, recreate at positions 1..n, re-wire
  `parentLineId` in a second pass from caller-supplied `key`/`parentKey`, recompute the six totals +
  grand total from the rounded line amounts, one `auditedUpdate`. `assertRefExists` on every
  registered FK the payload writes.
- **`recalculateInvoice(id)`** — re-runs Task 11's whole build against current state and replaces
  every derived line (`priceSource ≠ MANUAL`), keeping manual lines at the end. Recomputes totals
  from the full final set and refreshes `taxRate` (inseparable from the regenerated TAX line);
  descriptive header snapshots are left untouched.
- **`discardInvoice(id, reason)`** — soft-deletes a DRAFT via `auditedSoftDelete`. Reason required and
  trimmed in the service (§5.17); refuses if any `StoredDocument` names the invoice (already printed).

### Anti-drift: recalculate cannot fork the create path

The single most important correctness property. I extracted the create path's engine→line mapping
into shared helpers that **both** create and recalculate call, so there is no second pricing path to
drift:

- `mapComputedLines(computed, otherChargeGl)` — the engine's computed lines → `InvoiceLine` write
  rows, with **seam #1** (CHARGE-line GL assignment) inside it. Create and recalc both use it.
- `assertLineRefs(tx, lines, extraStepCodeIds)` — the `assertRefExists` loop over
  `glAccountId`/`processStepCodeId`/`surchargeId` (+ the cert charge's step code). Used by create,
  replace and recalc.
- `wireComputedParents(tx, invoiceId, computed.lines)` — the OPERATION→PART second pass, keyed off
  the engine's stable `key`/`parentKey`. Used by create and recalc.
- `totalsFromLines(lines)` — the six buckets + total, summed in integer cents from already-rounded
  line amounts (the engine's own rule). Used by replace and recalc.

`createInvoiceInTx` was refactored to call these — a pure extraction, no behavior change (its 20
existing tests still pass unchanged).

`recalculateInvoice` reuses `buildPricingInput` + `priceOrder` + `mapComputedLines` +
`assertLineRefs` + `wireComputedParents` verbatim, so its derived output is byte-for-byte what a
fresh `createInvoice` produces for the same order in its current state.

### The shared claim (`claimLiveInvoice`)

Factored like `claimLiveShipper` (shippers.ts:709): unlocked stub read for the order → `claimOrder`
→ `SELECT … FROM "Invoice" … FOR UPDATE` (after the order claim, one fixed order, no ABBA window) →
liveness re-read → refuse a discarded (404) or FINALIZED (400, naming the state) invoice. Every
mutator claims through it, so a draft edit and a concurrent finalize/unlock/discard serialize
through the invoice row lock.

## TDD evidence

**RED** (`npx vitest run tests/invoices.test.ts -t "updateInvoice|replaceInvoiceLines|recalculateInvoice|discardInvoice"`),
before implementation — the four exports did not exist:

```
TypeError: (0 , discardInvoice) is not a function
 ...
 Test Files  1 failed (1)
      Tests  8 failed | 20 skipped (28)
```

**GREEN**, after implementation:

```
 ✓ tests/invoices.test.ts (28 tests) 2447ms
 Test Files  1 passed (1)
      Tests  28 passed (28)
```

### Tests added (8)

1. `updateInvoice > refuses every draft edit on a finalized invoice, naming the state` — update /
   replace / recalc / **discard** all reject `/finalized/i`.
2. `updateInvoice > edits header fields on a draft and audits the before/after diff` — persists PO /
   terms / date, and asserts audit **content** (`before.poNumber === ""`, `after.poNumber === "PO-99"`).
3. `replaceInvoiceLines > recomputes the totals after a line edit` — OPERATION → $100 ⇒ subtotal/total 100.
4. `replaceInvoiceLines > refuses a replaced line that references a soft-deleted GL account` — proves
   the `assertRefExists` guard fires on the replace path.
5. `recalculateInvoice > recalculates from the order and preserves manual lines` — ship 6 more ⇒
   PART qty 150, "Hand-typed" manual line preserved and last.
6. `recalculateInvoice > produces the same derived lines as a fresh create for the same order (no
   drift)` — recalc, then discard + re-create as the baseline; `derived(recalced)` deep-equals
   `derived(fresh)` (kind/qty/amount/description/GL) and `subtotal` matches. This is the anti-drift
   proof: if recalc used stale shipped totals or a forked mapping, the amounts/GL would diverge.
7. `discardInvoice > discards a draft with a reason and frees the order to be invoiced again` — audit
   `reason` recorded; a new `createInvoice` on the same order succeeds with a different id (the
   live-rows-only unique sees the discarded row as gone).
8. `discardInvoice > refuses to discard a draft that has printed` — a `StoredDocument` on the invoice
   ⇒ `/has already printed/i`.

## Draft-only refusals

`claimLiveInvoice` refuses a FINALIZED invoice with
`Invoice #<orderNumber> is finalized and locked — unlock it before editing` (names the state), and a
discarded one with `Invoice not found`. All four mutators go through it, so all four refuse a
finalized invoice (test 1 covers all four). Discard additionally refuses a printed draft with a
message naming the block.

## Files changed

- `src/server/invoices.ts` — extracted 4 shared helpers + `claimLiveInvoice`; refactored
  `createInvoiceInTx` to use them; added `updateInvoice`, `replaceInvoiceLines`,
  `recalculateInvoice`, `discardInvoice` and their schemas.
- `tests/invoices.test.ts` — 4 fixtures (`draftFixture`, `finalizedFixture`, `shipMore`,
  `toLineInput`) + 8 tests.

## Self-review

- **Completeness** — all four brief exports; brief's five example tests plus three more.
- **Anti-drift** — proven by test 6; the shared mapping/guard/wiring helpers make a fork impossible
  without also changing create. Create's own 20 tests confirm the extraction is behavior-preserving.
- **Row locks, not isolation** — `claimLiveInvoice` claims the Order row then the Invoice row (fixed
  order); Serializable pairs with `assertRefExists`, never presented as the lock.
- **Normalize-on-write** — `replaceInvoiceLines` persists a whole row per line via `lineColumns`
  (every column defaulted like the schema); recalc rewrites the whole line set + totals.
- **Positions deterministic** — replace/recalc assign positions 1..n by array order; manual lines
  ride k+1..n. `SNAPSHOT_INCLUDE.invoice.lines` is `orderBy: position`, so history diffs stay clean.
- **Zero-net filter / seam #1 / seam #2 / seam #3** — all inherited from `buildPricingInput` +
  `mapComputedLines`, unchanged.
- **Discard frees the order** — soft-delete only; verified by test 7.
- **Audit content** — tests 2 and 7 assert real before/after and the recorded reason, not mere
  existence.
- **Would each test fail on regression?** — yes: stale-shipped recalc (test 5/6), missing FK guard
  (test 4), un-recomputed totals (test 3), missing finalized refusal (test 1), missing print guard
  (test 8), missing reason (test 7).

## Concerns

- **Header edit surface** — the spec (§5.5) does not enumerate editable header fields; I chose the
  correctable header snapshots the invoice page lists (`poNumber`, `invoiceDate`, `termsName`,
  `billTo`, `shipTo`), excluding customer/order identity, totals, lifecycle, and the lead-part
  display snapshots (`materialName`/`processNames`, which recalculate would otherwise own). If the
  owner wants a narrower or wider set, it is a one-line schema change.
- **`recalculateInvoice` refreshes `taxRate`** (header column) to match the regenerated TAX line, but
  deliberately does **not** refresh the descriptive header snapshots — so a user's edited PO/terms
  survives a recalculate. This matches "replaces every derived line" (§5.5) rather than
  re-snapshotting the whole header.
- Permission gates (`invoicing.edit` / `change_prices` / `invoicing.delete`) are the routes' job
  (Tasks 16–18), per the service-layer convention; not in scope here.

## Gates

| Gate | Result |
| --- | --- |
| `npx vitest run` | 1616 passed (106 files) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | success |

E2E not run — service-layer only, no UI/flow touched.

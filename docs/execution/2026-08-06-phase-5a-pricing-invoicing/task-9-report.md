# Task 9 report — `pricing.ts`, the pure resolution engine

**Status:** DONE_WITH_CONCERNS (two interface/doc gaps for the plan owner, listed in §7 — neither
blocks this task, both affect Task 11.)
**Commit:** `67b6a59` — `feat: pure pricing engine — per-operation math, breaks, minimums, surcharges, tax`
**Files:** `erp/src/server/pricing.ts` (new, 293 lines), `erp/tests/pricing.test.ts` (new, 63 tests)

---

## 1. What was implemented

`priceOrder(input)` turns plain data into `ComputedLine[]` plus the six bucket totals and the grand
total, exactly to the brief's exported shape. `roundCents` and `selectBreak` are exported alongside
it. Composition order is the brief's: for each order line a `PART` line then its `OPERATION`
lines, then `SURCHARGE`, `FREIGHT`, `CHARGE`, `CERT`, `TAX`.

The module is **pure**: its only imports are two `import type` statements from `../lib/`
(`part-constants`, `invoice-constants`). No Prisma, no `./db`, no other `src/server/` module, no
side effects at import. `tests/pricing.test.ts` imports nothing but `vitest`, `node:fs`,
`node:path` and the module itself — there is no `truncateAll`, no `prisma`, no fixture, and the
file runs with the database stopped. The last test re-reads the source and asserts every `import`
path starts with `../lib/`, so a future edit that reaches for Prisma fails here rather than in
production.

Everything computes in **integer cents**, with prices scaled to ten-thousandths and rates to
millionths (matching `Decimal(12,2)` money, `Decimal(12,4)` unit/break prices, `Decimal(9,6)`
rates — each checked against `prisma/schema.prisma`, not assumed). Dollars appear only at the
boundary, via `fromCents`.

## 2. TDD evidence

### RED — tests first, module absent

```
$ npx vitest run tests/pricing.test.ts
 FAIL  tests/pricing.test.ts [ tests/pricing.test.ts ]
Error: Cannot find module '@/server/pricing' imported from '/home/cjones/Desktop/HeatSynQ/erp/tests/pricing.test.ts'.
 ❯ tests/pricing.test.ts:4:1
 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN — after `src/server/pricing.ts`

```
$ npx vitest run tests/pricing.test.ts
 ✓ tests/pricing.test.ts (63 tests) 6ms
 Test Files  1 passed (1)
      Tests  63 passed (63)
```

### Gates

```
$ npm test          → Test Files 104 passed (104) · Tests 1566 passed (1566)   (1503 before; +63)
$ npx tsc --noEmit  → exit 0
$ npx eslint src tests → exit 0
$ npm run build     → compiled, route table printed, no errors
```

E2E deliberately not run: pure module, no UI, no route touched (parent's instruction).

### The tests were proved to discriminate, not just to pass

A passing arithmetic test proves nothing unless a wrong answer fails it. Eleven mutations were
applied to `pricing.ts`, run, and reverted (source diffed byte-identical against a backup
afterwards, then re-run green):

| # | Mutation | Result |
|---|---|---|
| 1 | Round the unit price to cents *before* multiplying | **3 failed** (`4-decimal price × qty`, `half a cent lands up`, `floors one cent under…`) |
| 2 | Banker's rounding instead of half-away-from-zero | **7 failed** |
| 3 | Totals re-round a float sum of already-rounded lines | 63 passed — *semantically equivalent, see below* |
| 3b | Round once at the END instead of once per line | **1 failed** (`never re-rounds the sum`) |
| 4 | Surcharges compound onto prior surcharge lines | **1 failed** (`…they never compound`) |
| 5 | Break basis divided for `PER_100`/`PER_1000` (the §5 pseudocode reading) | **3 failed** |
| 6 | `minimumApplied` claims a tie (`>=`) | **2 failed** |
| 7 | Tax base includes freight | **2 failed** |
| 8 | Break must be strictly exceeded, not reached (`>=`) | **5 failed** |
| 9 | Setup folded inside the minimum (`max(extended+setup, minimum)`) | **3 failed** |
| 10 | Surcharge emitted although nothing qualified | **2 failed** |
| 11 | `needsPrice` zeroes the line's amount | **1 failed** |

Mutation 3 is recorded because it is the honest result: re-rounding a sum of already-rounded
*dollar* amounts is arithmetically the same number as summing their cents, so no test could tell
them apart. The defect that mutation was reaching for is 3b — rounding once at the end rather than
once per line — and that one **is** caught, by the three-operations-at-$0.125 case (0.39, not 0.38).

## 3. The money decisions, and why

**Rounding order — once per line, at the extension.** The unit price keeps all four decimals
through the multiplication; only the product is divided back to cents, once, half away from zero
(`divideRound`). Rounding a per-unit price first and multiplying is a different number at quantity
(7 × $0.3333 is $2.33, not 7 × $0.33 = $2.31 — pinned as a test). Bucket totals then sum **integer
cents of already-rounded lines**, which is exact and never re-rounded; `total` sums the buckets.
Half-away-from-zero, not banker's, matches the sample invoice ($37.4976 → $37.50) and is pinned at
four separate half-cent boundaries.

**Half-cent float error.** `toCents` lifts by `1 + Number.EPSILON` before `Math.round`, because a
value that is a hair *below* a half-cent purely through float representation must still round up
(`1.005 * 100 === 100.49999999999999`; `2.675` is really `2.67499999999999982`). Both are pinned.

**Break selection.** Highest threshold at or below the basis; **at** the threshold selects it
(`>`, not `>=`, in the skip test). Below the lowest break and an empty break list both fall back to
`unitPrice`. Ties are impossible (live partial unique on `(partPriceId, threshold)`).

**Stale-basis breaks (carry-in 2) — the row's current `pricePer` is the sole authority.** A stored
threshold is read in the unit the row carries *now*: pounds on an `LB` row, pieces on every other
unit. The engine never converts a threshold and never remembers the unit it was entered under.
This is made visible as a named `breakBasis()` function with the ruling cited, a numbered decision
block in the module header, and a dedicated `describe` that moves one row's basis and asserts the
same thresholds are re-read (`selectBreak` **and** the resulting `unitPrice`, so the choice is
pinned in the arithmetic too, not only in the selector).

Sharpening worth recording: because the basis is a two-way split (pounds vs pieces), moving a row
among `EACH` / `PER_100` / `PER_1000` does **not** reinterpret a threshold — all three count
pieces. The only unit change that changes what a stored threshold means is one crossing the `LB`
boundary. `LOT` cannot be involved: `part-prices.ts` refuses breaks on a LOT row in both directions
(Serializable on both sides).

**`PER_100` thresholds are pieces — a spec-vs-brief discrepancy, resolved by the owner ruling.**
The P5A spec §5 pseudocode reads `basis = PER_100 → qty/100 … price = the break with the highest
threshold <= basis`, which would compare a `PER_100` row's thresholds against hundreds. The brief's
`breakBasis` compares against pieces. The 2C-2 spec §3.1 **owner ruling** settles it: "A per-lb
part's break thresholds are pounds; a per-each / per-100 / per-1000 part's are pieces." The brief
is right and the §5 pseudocode is loose — it conflates the *extension* basis with the *break
comparison* basis. Implemented per the ruling, cited in the code, pinned by three tests, and
mutation-5 confirms the other reading fails them. **§5's pseudocode is worth a one-line
clarification** so the next reader does not re-derive the wrong rule.

**Minimum and setup.** `amount = max(extended, minimum) + setup` (ruling 13), unconditionally.
`minimumApplied` is `minimum > extended` — strictly greater, so an exact tie does *not* claim the
floor won (pinned; a `>=` implementation fails). At zero shipped quantity the formula bills the
minimum plus setup; Task 11 only feeds lines with a non-zero net shipped total, so this is the
stated formula rather than a carve-out, and it is pinned so nobody has to guess later.

**`needsPrice` is a flag, not a suppression.** The brief flags a row with `unitPrice == null &&
minimumCharge == null`; it does not say to zero it. A row like that carrying a **setup charge**
therefore still bills the setup, and the flag says so out loud. Rationale: dropping money the
operator already entered is precisely the silent failure §7.5's "never silently priced, never
silently dropped" exists to prevent, and a setup-only operation is a real configuration. The
alternative reading (§7.5's tier 3, "zero and flagged") is what governs the *other* case — a line
with **no price rows at all** — which is billed at zero with every price field null, as the brief
specifies. Both are pinned; mutation 11 confirms the zeroing variant fails.

**Percent surcharges never compound.** Every surcharge computes on the sum of qualifying
`OPERATION` cents alone — not on freight, charges, cert, tax, or on another surcharge. Two 10%
surcharges over $100 of work are $10 and $10, never $10 and $11 (pinned; mutation 4 fails it). The
base is the operation amount **as billed**, so a minimum floor and a setup charge are inside it
(10% of $675, not of $65.10 — pinned). `minimumAmount` floors the computed result, for both
`PERCENT` and `FLAT`.

**Surcharge emission is by qualification, not by a non-zero base** — the brief's "if no operation
line qualifies, emit no line at all". An operation line with no step code (a line with no price
rows) can never be *listed*, so `INCLUDE` never matches it and `EXCLUDE`/`ALL` always do. The
consequence, pinned so it is a decision rather than a surprise: an `ALL` surcharge with a
`minimumAmount` over an order whose only operation is unpriced **does** emit its minimum, while an
`INCLUDE` surcharge emits nothing at all.

**Tax** is last, over operations + surcharges + charges + cert in cents, freight excluded, its own
half-cent rounded away from zero ($100.24 × 6.25% = $6.265 → $6.27), rate snapshotted.

**Ordering (carry-in 1).** The engine consumes every array in the order handed to it and re-sorts
nothing; `listPartPrices` / `listSurcharges` already apply `position asc, id asc`, and a second
ordering rule here would compete with the first. The `position` fields on the input types are
therefore snapshot data the engine does not read — stated in the header comment and pinned by a
test that hands in descending positions and asserts the array order survives. No date-window
selection exists anywhere in the module.

**Other snapshot choices** (brief silent, all pinned by tests): `description` is the step **name**
on an operation (matching Task 11's warning text `"… — Austemper needs a price"`), the surcharge
name, the charge/cert description, `"Freight"`, `"Sales tax"`, and `"Needs price"`; `priceSource`
is `PART_PRICE` **only** on an operation sourced from a price row and `null` everywhere else — so
Task 12's "replace every line whose `priceSource` is not `MANUAL`" treats all of them as derived;
quantities live on the `PART` line only, with operations carrying `qty/weight/eachWeight` null and
hanging off their part by `parentKey`; the `PART` line carries `orderLineId` and part identity but
no GL account and no money.

## 4. Self-review findings (fixed before reporting)

1. **The first totals mutation did not discriminate.** Caught during mutation testing, not by
   reading: my "never re-rounds the sum" test needed a case where per-line rounding and end
   rounding actually differ. Three $0.125 operations (0.39 vs 0.38) is that case, and mutation 3b
   confirms it fails the right way.
2. **`expect(roundCents(-0.004)).toBe(-0)`** was pinning a `Object.is` quirk (`-0 !== 0`) rather
   than behaviour, and would have failed a correct implementation written with `Math.sign`.
   Replaced with `expect(Math.abs(...)).toBe(0)`.
3. **The brief's own tax test passes `surcharges: []`** while its name claims surcharges are taxed.
   Added a case that actually puts a surcharge in the tax base (10% of $110.00 = $11.00).
4. Added the boundary cases the brief's table leaves out: a tie against the minimum, one cent
   either side of it, an empty break list, a single break exactly on and one below, `PER_100` /
   `PER_1000` break thresholds, a million pieces (double-precision headroom), and a fractional
   per-lb weight.

## 5. What is deliberately not here (YAGNI)

No effective dating, no re-sorting, no LOT-with-breaks defence (refused at entry on both sides, and
a defensive branch here would be untestable through the real write path), no currency handling, no
credit negation (Task 13 owns it), no clamping or validation of inputs — the services that build
the input validate through zod at entry, and a second half-validation here would be a competing
rule with no error channel to report through.

## 6. Files changed

| File | Change |
|---|---|
| `erp/src/server/pricing.ts` | New. The engine: `roundCents`, `selectBreak`, `priceOrder`, and the exported input/output types. |
| `erp/tests/pricing.test.ts` | New. 63 tests: the plan's, plus rounding-order, boundary, compounding, snapshot, ordering and purity coverage. |

Nothing under `docs/execution/` or `.superpowers/` is committed (this report is written, not
committed, per instruction).

## 7. Concerns to hand back

1. **`ChargeInput` carries no GL account, and `BillingConfig.otherChargeGlAccountId` exists for
   exactly that purpose.** The plan's type is `{ orderChargeId, position, description, amount }`
   while `freight`, `cert` and `tax` all carry a `GlRef`. I implemented the interface exactly as
   specified, so every `CHARGE` line comes out with `glAccountId: null, glAccountName: ""` (pinned
   by a test, with the gap named in the assertion). **Task 11 must assign the other-charge GL
   itself, or the plan should add `GlRef` to `ChargeInput`.** Left un-decided on purpose: it is a
   plan interface, not a task-9 call. Nothing about it affects an amount.
2. **P5A spec §5's `basis` pseudocode conflicts with the owner ruling on break thresholds**
   (§3 above). Implemented per the ruling (2C-2 §3.1) and the brief. A one-line spec clarification
   would stop the next reader from re-deriving `qty/100`.
3. **`SurchargeRow.glAccountName` is `string | null`** in `surcharges.ts`, while `SurchargeInput`
   here requires `string`. A `?? ""` at the Task 11 seam, not a change here — noted so it is not a
   surprise when the types meet.
4. Precision headroom is finite, as with any double-based cents arithmetic: `extendedCents`
   multiplies scaled integers, so a per-lb line would need roughly a billion pounds against a
   four-decimal price before crossing `2^53`. Far outside any real order (a million pieces at $6.51
   is pinned exact), and integer cents is the house pattern (`load-split.ts`). Recorded, not
   guarded.
## Fix wave 1

Three fixes applied to `src/server/pricing.ts` per the plan owner's review of Task 9.

### Fix 1 — `needsPrice` now reads the resolved price, not the row's raw list price

`needsPrice: row.unitPrice === null && row.minimumCharge === null` was changed to
`needsPrice: price === null && row.minimumCharge === null` (`pricing.ts:243`), where `price` is
the already-resolved value at `pricing.ts:227` (`chosen?.price ?? row.unitPrice`). A break-only
row — `unitPrice: null`, a live break the shipped quantity clears — now correctly reports
`needsPrice: false` while still snapshotting the break's price and threshold. Previously such a
row priced and billed correctly but was flagged as needing a price anyway, which (per the P5A
spec) would have refused finalize on a fully-priced invoice.

**Discriminating test added** (`tests/pricing.test.ts`, `pricing — needs price` describe block):
"does not flag a row with no list price when a break resolves the price" — a row with
`unitPrice: null, minimumCharge: null` and one break `{ threshold: 100, price: 6 }`, at the
default `shippedQty: 144` (clears the break), asserting `needsPrice === false`,
`unitPrice === 6`, `breakThreshold === 100`, and `amount === 864`.

Proved the test discriminates by reverting the fix, running only that test, and restoring:

RED (old condition `row.unitPrice === null && row.minimumCharge === null` restored):
```
FAIL  tests/pricing.test.ts > pricing — needs price > does not flag a row with no list price when a break resolves the price
AssertionError: expected true to be false
 ❯ tests/pricing.test.ts:157:26
Tests  1 failed | 63 skipped (64)
```

GREEN (fix restored):
```
✓ tests/pricing.test.ts (64 tests | 63 skipped) 3ms
Tests  1 passed | 63 skipped (64)
```

The complementary case — a row with no price and no breaks at all still reports
`needsPrice: true` — was already covered by the pre-existing test "flags a priced row carrying
neither a unit price nor a minimum" (`tests/pricing.test.ts`), which was left unchanged.

### Fix 2 — purity test now also rejects `require(`/dynamic `import(`

`tests/pricing.test.ts`, `pricing — the module is pure` describe block: added
`expect(/\brequire\s*\(/.test(src)).toBe(false)` and `expect(/\bimport\s*\(/.test(src)).toBe(false)`
alongside the existing static-`import`-path assertion, so a `require("./db")`, a dynamic
`import("./db")`, or a bare side-effect `import "./db"` (which the static-import regex's
`from\s+"..."` capture would also have missed) all fail the test, matching what the test's name
already claims.

### Fix 3 — `roundCents` doc comment states its assumed input precision

Comment-only change at `pricing.ts` (`roundCents`), no arithmetic touched. The doc now states
that the function assumes its input already carries at most 2 decimal places of real precision,
names the failure mode (`roundCents(12.344999999999999)` returns 12.35, not the mathematically
correct 12.34, because the `1 + Number.EPSILON` lift in `toCents` is tuned for genuine
half-cent-boundary float error, not an arbitrary nearby float), and notes that every value this
module itself feeds `toCents` is a 2- or 4-decimal `Decimal` and never lands that close to a
boundary, so a caller passing a computed float should round to cents itself first.

### Verification

```
$ npx vitest run tests/pricing.test.ts
 ✓ tests/pricing.test.ts (64 tests) 9ms
 Test Files  1 passed (1)
      Tests  64 passed (64)

$ npx tsc --noEmit          → exit 0, no output
$ npx eslint src tests      → exit 0, no output
$ npm run build             → compiled, route table printed, no errors
$ npm test                  → Test Files 104 passed (104) · Tests 1567 passed (1567)   (1566 before; +1 net)
```

E2E not run per instruction (pure module, no UI, no route touched).

### Scope discipline

No arithmetic in `priceOrder`/`extendedCents`/`divideRound`/`applyRate`/`selectBreak` was
touched. `ChargeInput`'s missing `GlRef`, the `glAccountName` `string | null` → `string`
normalization, the stale-basis decision, and zero-quantity billing (minimum + setup) were left
exactly as Task 9 shipped them, per the plan owner's explicit out-of-scope list.

# Task 2 report — Pure utilities: serial ranges, business days, load split

## Implementation notes

Three pure, client-safe modules in `erp/src/lib/`, zero imports in any of them (no server, no
React, no Next) — plain functions operating on strings/numbers/`Date`. All throw plain `Error`
with a message already fit to show a user; none import `HttpError`.

**`serial-range.ts` — `expandSerialRange(input: string): string[]`**
Single anchored regex `^([^{}]*)\{([^{}]*)\}([^{}]*)$` does double duty: it captures
prefix/body/suffix in the valid case, and — because the prefix/suffix groups are "zero or more
*non*-brace characters" — it structurally *fails to match* nested (`{{...}}`) or multiple
(`{a}{b}`) brace groups, so those fall straight into the same "not a valid range" error as any
other malformed shape. Padding width is taken from the first bound's string length (`"001"` → 3),
applied via `padStart` to every generated number — the VS-rule equivalence
(`{001-25}` ≡ `{001-025}`). The `start > end` check runs *before* the expansion-count check
deliberately: with a reversed range the naive `end - start + 1` count is negative, which would
otherwise slip past a `count > 10_000` test and silently return `[]` from a `for` loop whose
condition is false on the first iteration — a genuine bug caught by reasoning through the `{9-1}`
case, not by any tool. The 10,000-row cap message hardcodes "10,000" as a literal (not derived
from the `MAX_EXPANSION` constant via `toLocaleString()`) — deliberate: locale-dependent
formatting would make the message non-deterministic across environments, and the brief pins the
exact digit grouping as a requirement, so a literal is the safer, testable choice at the cost of
one duplicated number.

**`business-days.ts` — `parseDateOnly` / `formatDateOnly` / `todayDateOnly` / `addBusinessDays`**
`parseDateOnly`'s rollover guard is a direct line-for-line mirror of `part-process-steps.ts`'s
`validateStepValue` DATE case, as the brief specified: round-trip the parsed y/m/d through
`Date.UTC` and compare what comes back out, because `Date.UTC` silently normalizes
`2025-02-29` into March 1 instead of erroring. `addBusinessDays` walks one calendar day at a time
in raw UTC epoch-millisecond arithmetic (`result += DAY_MS`, never `setDate`/`setUTCDate`),
counting a step only when `getUTCDay()` lands on Mon–Fri. Epoch-ms arithmetic rather than a
date-object setter was a deliberate choice: it can't be affected by the host's local time zone
(confirmed the dev box runs `America/Chicago`, not UTC) since every operation stays in UTC space
throughout, with no local-time method ever called.

**`load-split.ts` — `splitLoads`**
Implements the brief's formula verbatim: `perLoadQty = min(loadQty ?? ∞, loadWeight ?
max(1, floor(loadWeight / (totalWeight/totalQty))) : ∞)`, both-null short-circuits to one load.
The one deliberate deviation from a literal reading of "per-load weight = round2(...), last =
total − Σ(others)" is *how* that subtraction is computed: doing it in floating pounds
(`totalWeight - (699.4 + 699.4 + 699.4)`) produces `501.8000000000002` for at least one of the
brief's own matrix numbers — the sum still cancels back to the total exactly, but the individual
last-load value is visibly not pristine. Empirically verified (scratch Node scripts, see below)
before writing any test file. The implementation instead accumulates in **integer cents**
throughout (`Math.round(totalWeight * 100)`, integer arithmetic per load, single division back to
pounds at the end), which keeps every individual value clean *and* keeps the cents summing to the
total exactly by construction. Also empirically confirmed (and important to flag): summing the
resulting pound-valued `.weight` fields with plain `+` is **not** a general guarantee of exactness
for arbitrary decimal totals — it happens to hold for every one of the brief's matrix cases (all
verified below) but I found a counter-example with an invented total (`999.99` over 7 pieces,
`loadQty: 2`) where the cents sum exactly but the naive float re-sum of the rounded pound values
is `999.9899999999999`. This is an inherent IEEE-754 addition property, not a bug reachable from
the brief's requirements — I deliberately did not add that invented case to the test file (see
Concerns).

## TDD evidence

**RED** — implementation files moved aside, ran the three new test files against the
still-missing modules:

```
$ npx vitest run tests/serial-range.test.ts tests/business-days.test.ts tests/load-split.test.ts
 FAIL  tests/business-days.test.ts [ tests/business-days.test.ts ]
Error: Cannot find module '@/lib/business-days' imported from '.../tests/business-days.test.ts'.
 FAIL  tests/load-split.test.ts [ tests/load-split.test.ts ]
Error: Cannot find module '@/lib/load-split' imported from '.../tests/load-split.test.ts'.
 FAIL  tests/serial-range.test.ts [ tests/serial-range.test.ts ]
Error: Cannot find module '@/lib/serial-range' imported from '.../tests/serial-range.test.ts'.

 Test Files  3 failed (3)
      Tests  no tests
```

(Test *values* in each matrix — e.g. the exact load-split numbers — were derived and verified in
scratch `node -e` scripts before being written into the test files, since hand-deriving expected
floating-point sums is error-prone and the brief specifically warns about this; the scratch
scripts are not part of the deliverable.)

**GREEN** — implementation files restored, same three files:

```
$ npx vitest run tests/serial-range.test.ts tests/business-days.test.ts tests/load-split.test.ts
 ✓ tests/business-days.test.ts (13 tests) 6ms
 ✓ tests/load-split.test.ts (8 tests) 4ms
 ✓ tests/serial-range.test.ts (10 tests) 6ms

 Test Files  3 passed (3)
      Tests  31 passed (31)
```

(11/8/13 after the post-self-review addition of the serial-range 10,000/10,001 boundary test —
see Self-review below — bringing the three-file total to 32.)

**Full gates, final run:**

```
$ npm test
 Test Files  62 passed (62)
      Tests  620 passed (620)          # 588 baseline + 32 new

$ npx tsc --noEmit
(clean, exit 0)

$ npx eslint src tests
(clean, exit 0)
```

Baseline before this task (confirmed by running the suite untouched first): 59 files / 588 tests,
matching the task brief's stated starting point.

## Files changed

- `erp/src/lib/serial-range.ts` (new)
- `erp/src/lib/business-days.ts` (new)
- `erp/src/lib/load-split.ts` (new)
- `erp/tests/serial-range.test.ts` (new, 11 tests)
- `erp/tests/business-days.test.ts` (new, 13 tests)
- `erp/tests/load-split.test.ts` (new, 8 tests)

## Self-review

**Completeness** — every bullet in the brief's §12 matrix is present, matched line-for-line
against the brief text:
- serial-range: plain passthrough, 25-row padded expansion, `{001-25}`≡`{001-025}` equivalence,
  suffix form, nested-brace reject, two-group reject, `{01-}` reject, `{9-1}` reject,
  `{1-99999}` reject naming 10,000, whitespace trim — all present.
- business-days: Thu+5=Thu, Fri+1=Mon, Mon+0=Mon, `2025-02-29` reject, `2025-13-01` reject,
  format round-trip — all present.
- load-split: 1000/300→300/300/300/100, weight-only 269/load, both-caps 269-not-300, heavy-piece
  1/load, exact-multiple no-tail, no-caps single load, exact-sum assertion in every case — all
  present.

Two gaps found and closed during self-review (both before the initial commit, not after): (1) the
10,000-row cap only had a "huge blowout" test (99999), which would not catch an off-by-one at the
actual threshold — added a dedicated boundary test asserting exactly 10,000 succeeds and 10,001
throws. (2) no test exercised the brief's implicit "non-numeric bounds" throw category beyond the
matrix's `{01-}` (arguably "missing" rather than "non-numeric") — added `{abc-def}` alongside it
in the same test.

**Quality** — Re-read all three files fresh after writing. Every spec cross-reference in the
comments (§3.2, §3.4, §5.4, §6, §12.6) was checked against the actual design doc section numbers,
not assumed. The `start > end` check's ordering *before* the expansion-count check is
load-bearing, not stylistic (see Implementation notes) and is covered by the `{9-1}` test, which
would fail (return `[]` without throwing) if the checks were reordered or the guard removed.
`addBusinessDays` and `parseDateOnly` both throw on invalid input with a function-prefixed message
(`addBusinessDays: n must be...`), matching the existing `picklists.ts` precedent for that style.

**Discipline (YAGNI)** — exactly the three files the brief names, nothing else added to
`src/lib/`. One considered-and-rejected addition: a defensive throw in `splitLoads` for a
non-positive `perLoadQty` (reachable only if a caller passes `loadQty: 0` explicitly, which would
otherwise infinite-loop). Rejected because, unlike the other two modules, the brief's interface
comment for `splitLoads` names no throw conditions at all — a deliberate contrast I read as "this
one trusts already-validated input" (the service layer's `z.number().int().min(1)` per the global
constraints). Adding validation not asked for would be exactly the kind of assumption the owner's
prime directive rules out; noted under Concerns instead of silently added.

**Testing** — every assertion checks a concrete value (exact arrays, exact numbers), not just
"did it throw." The load-split matrix's expected numbers were computed by a reference
implementation run in scratch Node scripts before being hardcoded into the test file, specifically
*because* hand-arithmetic on repeated 2-dp rounding is exactly the kind of thing that's easy to
get subtly wrong (see the `999.9899999999999` finding above). No `.only`/`.skip`/`console.*`
left in any of the six files.

## Concerns

1. **`splitLoads` has no input validation** (see Discipline above) — a future caller passing
   `loadQty: 0` (rather than `null`) would hang in an infinite loop (`Math.min(0, remainingQty)`
   never advances `remainingQty` toward 0). I read the brief's silence on throw conditions for
   this function (in contrast to the other two, which enumerate them explicitly) as intentional,
   but flagging it explicitly in case that reading is wrong — a one-line guard is cheap to add if
   the service layer (Task 4+) can't fully guarantee `loadQty >= 1` before calling in.
2. **Floating-point sum exactness is verified for the brief's matrix, not universal.** The
   `splitLoads` "sums exactly" property holds for every case in the brief and every case in the
   test file (all individually confirmed via scratch scripts), but is not a property that holds
   for arbitrary `totalWeight`/`totalQty` combinations when the results are re-summed with plain
   `+` — that's an inherent floating-point-addition limitation, not something fixable without
   arbitrary-precision decimal arithmetic (a scope increase I did not think this task warranted).
   Downstream, actual persistence goes through Prisma's `Decimal(12,2)` columns (exact decimal,
   not float), so this is very unlikely to surface as a real bug — but it's worth the next task
   that consumes `splitLoads` output being aware the guarantee is "the brief's cases," not "all
   inputs."
3. Node version: this environment's default shell `node` is v22.23.1 (system), not the `>=26`
   `package.json` pins; all commands in this report were run after `nvm use 26` (v26.5.1). Every
   `npm`/`npx` invocation needs that explicit `nvm use 26` first in this environment — flagging in
   case it's not already known, not something I changed.

No other deviations from the brief's exact signatures/rules.

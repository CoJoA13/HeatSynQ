# Task 3 (#163) — implementer report

**Commit:** `8995faf` — `fix(receivables): a batch proved against nothing no longer renders as balanced (#163)`
**Branch:** `round-3-group-a` (base `17a7e1c`, Task 2's report commit).
**Gates:** `npx tsc --noEmit` clean · `npx eslint src tests` clean ·
`DATABASE_URL_TEST=…/erp_test_a3 npx vitest run tests/receipts.test.ts tests/receivables-routes.test.ts`
— **86 tests, all passing** (42 + 44). The full suite and `npm run test:e2e` are the group lead's at
close, per the task instruction.

---

## 1. What changed, and why

`balance` was `(controlTotal ?? enteredTotal) − enteredTotal`. With no control total that is
`enteredTotal − enteredTotal` = **0** — so a batch proved against **nothing** rendered identically to
a batch that foots **to the cent**, on the screen whose entire purpose is proving money. The fix
makes the server type carry the distinction (`balance: number | null`) so it cannot be lost again in
the API or in a future consumer, then renders the null case distinctly at both display sites.

### 1.1 The server — `erp/src/server/receipts.ts`

| Location | What |
|---|---|
| `receipts.ts:15-29` | file-header contract rewritten: `controlTotal − enteredTotal`, or NULL when there is no control total. Records the old definition and why it lied, and says **never `?? 0` it back** |
| `receipts.ts:65-71` | `BatchDetail.balance: number \| null`, with the reason on the type |
| `receipts.ts:131-135` | `toBatchDetail` — `controlTotal === null ? null : (cents(controlTotal) − enteredCents) / 100`. The `controlCents = … ?? enteredCents` fallback that produced the false zero is gone, not merely re-branched |
| `receipts.ts:177-182` | `BatchListRow.balance: number \| null`, cross-referencing the detail contract |
| `receipts.ts:194-199` | `toBatchListRow` — the identical arithmetic, with a comment saying it is verbatim on purpose |
| `receipts.ts:452-460` | the `postBatch` comment that cited *"balance is defined 0 (file header)"* — the old definition, now corrected in place. **The posting rule itself is untouched** |

Both read shapes were fixed because both carried their own copy of the arithmetic; fixing one is a
half-migration that leaves the other screen still lying.

**`postBatch` is behaviourally unchanged.** `receipts.ts:452` still branches on
`batch.controlTotal !== null` (the DB column, never the derived figure), so a batch with no control
total still posts freely — the owner's Q18 answer, explicitly out of scope. Two tests pin that it
still posts *and* that its balance is now null.

**Bonus finding:** `prisma/schema.prisma:1471` has documented `Live balance = controlTotal − Σ
payments` since the model was written. The schema comment was right all along; the service was the
liar. No schema or migration change was needed — the code now agrees with the comment it always had.

### 1.2 The batch page tile — `BatchDetail.tsx:52-58`, `:631-651`

Type mirror widened to `number | null`, and the tile now has **three** branches (the design decision
is §2 below).

### 1.3 The worklist column — `ReceivablesList.tsx:21-26`, `:166-175`

Type mirror widened; the cell renders `Not proved` instead of `b.balance.toFixed(2)`.

---

## 2. The design decision the brief left to me

### 2.1 The batch page tile (`BatchDetail.tsx:631-651`)

```
null  →  "Not proved — no control total"   bg-blue-50 text-blue-800
0     →  "0.00"                            bg-slate-50            (unchanged)
other →  "200.00"                          bg-amber-50 …          (unchanged)
```

**Why it cannot be misread as a proved zero.** It is not a number at all. There is no `0`, no
decimal point, and no currency-shaped token in the cell — the operator's eye cannot land on it and
read "checked, and it agrees". The word chosen is the issue's own: *"this deposit has not been
proved against anything"*. `—` was rejected on the brief's own reasoning: a dash in a **Balance**
column reads "nothing to report", when the true message is "nothing was checked".

**Why the third colour, and why blue specifically.** Slate is this tile's "proved, and it agrees"
state; letting null land there is the exact defect in a new place. Amber was the other candidate and
I rejected it deliberately: on this screen amber means *"the control total and what you keyed
disagree — work this number down before posting"* (the manual teaches it that way,
`docs/manual/07-receivables.md:34`). An unproved batch has no discrepancy and **posts freely** by
ruling, so amber would invent a blocker that does not exist and would train operators to ignore
amber on the one screen where amber has to mean something. Blue is already this app's informational
note colour (`orders/new/page.tsx:779`, `QuoteDetail.tsx:637`, `ShipmentDetail.tsx:648`) — it is
visibly not slate, visibly not amber, and it claims a *fact*, not an error.

Note the pre-existing code would **not** have fallen through to slate anyway: `null === 0` is false
in JS, so a null would have landed in the amber branch and then crashed on `.toFixed(2)`. Both
branches are now explicit, null first, so neither accident is reachable.

**Colour is a redundant cue, never the signal.** The wording carries the whole meaning, so the state
survives a colour-blind reader, a greyscale print and a screenshot in the manual.

### 2.2 The worklist column (`ReceivablesList.tsx:166-175`)

Renders `Not proved` — the same lead phrase as the tile, so the two screens teach one term rather
than two.

**No colour there, deliberately.** That column carries no colour semantics today at all: an
out-of-balance batch prints plain black in the list exactly like a footing one. Colouring one state
of three would invent a hierarchy the rest of the column does not have (and would say
"unproved is worse than out-of-balance", which is false). Among a column of right-shaped figures the
word already stands out at a glance, which is the brief's actual requirement.

The tile carries the longer form (`— no control total`) because it has the room and it is the screen
where the operator decides; the list carries the short form because it is a scan surface.

---

## 3. Tests

All five RED-verified assertions were written first and watched fail against the unfixed code, in one
run: `Tests 5 failed | 81 passed`, every failure reading `expected +0 to be null`.

| Test | What it catches | RED-verified |
|---|---|---|
| `receipts.test.ts:113` — *"balance is null when no control total was set — nothing has been proved"* (was `toBe(0)`, the defect written down as an expectation) | the detail read handing back a reassuring 0 | ✅ |
| `receipts.test.ts:765` — the `listBatches` row assertion (was `toBe(0)` with the comment *"balance foots against enteredTotal itself"*) | the list read handing back a reassuring 0 | ✅ |
| `receipts.test.ts:771-794` — **new**, *"distinguishes a footed 0 from an unproved null — both read shapes"* (`it` at `:780`) | the brief's explicit ask: a batch whose control total **foots** still reports a real `0` while a batch with none reports `null`, asserted on **both** `listBatches` and `getBatch` in one test. A `?? 0` reintroduced on either side reds this; so does fixing only one of the two read shapes | ✅ (two of the five) |
| `receipts.test.ts:342` — *"posts freely with no control total — balance is null, nothing to prove against"* (was *"balance is defined 0"*) | someone "fixing" #163 by making `postBatch` refuse an unproved batch — the out-of-scope rule stays pinned, alongside the new null | partially (the added `balance` assertions were RED; the posting assertion was already green and must stay so) |
| `receivables-routes.test.ts:141` — **new**, *"answers balance: null — a present null"* | the distinction surviving **JSON**, not just the service boundary. `Object.hasOwn(body, "balance")` is the load-bearing half: a `balance?: number` shape would serialize `undefined` away entirely and a client could not tell "nothing was proved" from "the field moved" | ✅ |

Unchanged and still green, because they are the *proved* cases and must not move:
`receipts.test.ts:67` (500 against an empty batch), `:89` (200), `:104` (a real footed 0), `:349`
(footed 0 before a void), `:616` (500 after a void), `:757` (500), and
`receivables-routes.test.ts:263` (200 through the route).

Comment/prose corrections in the same files, so the record does not keep the old definition:
`receipts.test.ts:10-14` (suite header), `:286-290` (#80 block header).

---

## 4. What I could NOT verify mechanically

**There is no DOM test environment in this repo.** The two `.tsx` changes — the three-state tile and
the worklist cell — have **no unit-test coverage and cannot have any**. `npx tsc --noEmit` proves the
narrowing is sound (no `.toFixed()` survives on a possibly-null value) and `npx eslint src tests`
proves the JSX parses; **neither proves anything renders**. I did not start a dev server: `npm run
dev` shares `erp/.next` with whatever `npm run test:e2e` another agent may be running in this same
checkout, and the group lead runs E2E at close.

So: the wording, the colour, the wrapping of `Not proved — no control total` inside a
`grid-cols-2 md:grid-cols-4` tile, and the list cell are **unverified by any automated check in this
commit**. Playwright is the only mechanised check available, and I did not add one — see §5.1, which
is the single most valuable follow-up on this report.

---

## 5. Recommendations I deliberately did NOT act on (out of my file scope)

### 5.1 Free E2E coverage exists, in two flows, and I was scoped out of those files

Both A/R flows create their batch by filling **only** the deposit date —
`receivables-apply-age-statement.mjs:125-127` and `close-month-end.mjs:300-302` leave **Control total
blank** — then land straight on the batch page. Both therefore sit in the unproved state already, for
free, and both take a screenshot right there (`shot("batch-created")`).

One assertion in each, immediately after that shot, would be the only mechanised check this task can
have:

```js
// #163: no control total was entered, so the Balance tile must SAY so rather than print 0.00.
await page.getByText("Not proved — no control total", { exact: true })
  .waitFor({ state: "visible", timeout: 15000 });
```

I did not add it: those two files are Task 1's (#155 edits `receivables-apply-age-statement.mjs:184`
and `close-month-end.mjs:338`), my task instruction scoped me to five files, and I cannot run
`test:e2e` here to verify a selector I would be handing to someone else's gate run. **Please add it
at group close or hand it to Task 1's implementer** — the fixtures already produce the state, so it
costs one line each and nothing else.

### 5.2 One manual sentence is now incomplete (Task 4's commit)

`docs/manual/07-receivables.md:34-36`: *"**Balance** turns amber whenever it is not zero"*. That is
still true of a batch **with** a control total, but the chapter now describes only two of three
states. A sentence naming the third belongs beside it, e.g. *"With no control total there is nothing
to balance against, and Balance reads **Not proved** instead of a figure."* The worklist column list
at `:26-27` may want the same note.

**No figure goes stale and `manual:build` needs no rerun for my change**: every batch in
`prisma/manual-seed.ts` (`:1641`, `:1729`, `:1743`) and in `prisma/demo-seed.ts:282` carries a
control total, so no screenshot in `docs/manual/` shows the unproved state. I left the chapter alone
because `docs/manual/**` is Task 4's, committed in one pass after the three code tasks.

### 5.3 Adjacent defect noticed and NOT fixed

`ReceivablesList.tsx:167-169` renders the empty-worklist row as `<td colSpan={6}>`, which matches the
six `<th>`s today — correct, but it is a hand-counted constant beside a hand-written header row, the
class of thing that silently goes wrong the next time a column is added. Not a correctness defect
now, not in this issue's scope, and not worth churning a file two other tasks touch. Recorded here
rather than filed.

---

## 6. Consumers of `balance` from these two read shapes — the full sweep

Grepped `src`, `tests`, `e2e`, `scripts` for `balance`, `BatchDetail` and `BatchListRow`:

| Consumer | Handled |
|---|---|
| `src/app/receivables/batches/[id]/BatchDetail.tsx:54` (type mirror) + `:632` (render) | widened + three-state render |
| `src/app/receivables/ReceivablesList.tsx:23` (type mirror) + `:164` (render) | widened + word render |
| `tests/receipts.test.ts` — `:67`, `:89`, `:104`, `:115`, `:349`, `:616`, `:754`, `:757` | two flipped to `toBeNull()`, six are proved cases and unchanged |
| `tests/receivables-routes.test.ts:263` | control total 500 / entered 300 → still `200`, unchanged; new null case added above it |
| **`e2e/**`** | **no flow reads the batch Balance figure at all.** The only `Balance` matches in `e2e/` are `receivables-apply-age-statement.mjs:258-304`'s *"Net balance:"*, which is the customer A/R panel (`ReceivablesSection.tsx:146`) and an entirely different figure. `close-month-end.mjs:178` and `:439` visit the batch page but assert only the heading, the status badge and per-payment rows. Nothing to update, nothing that breaks |
| `e2e/manual-capture.mjs:279`, `:919` | ready-check is `^Batch #\d+` (the heading), not the tile. Unaffected |
| `src/server/**` elsewhere (reports, GL export, aging, statements, close) | **none.** No other module reads a batch balance; every A/R figure elsewhere derives from `ar-balances`/`aging`, which are untouched |
| `prisma/schema.prisma:1471` | already documented the new definition (§1.1). No change |

Nothing else consumes either shape, so nothing is left half-migrated.

# Task 2 (#157) — implementer report

**Commit:** `62e11f1` — `fix(receivables): bound write-off retention by the write-off's own period (#157)`
**Branch:** `round-3-group-a` (base `79b2e47`).
**Gates:** `npx tsc --noEmit` clean · `npx eslint src tests` clean · `npx vitest run` — **204 files,
3474 tests, all passing**, one process.

---

## 1. What changed, and why

### 1.1 The lock-free period read — `erp/src/server/period-locks.ts`

| Location | What |
|---|---|
| `period-locks.ts:34-42` | `keyOf(year, month)` extracted, `monthKey(glDate)` exported |
| `period-locks.ts:84-88` | `periodLabel({year, month})` extracted from `assertPeriodOpen`'s message |
| `period-locks.ts:90-124` | `closedMonthsForDisplay(db, glDates)` — the new read |
| `period-locks.ts:18-22` | header note that one function here deliberately does not lock |

`assertPeriodOpen`'s refusal string is byte-identical to before — `periodLabel` is a straight
extraction so the guard's `2026-07` and the new hint's `2026-07` cannot drift.

### 1.2 The retention branch — `erp/src/server/applications.ts`

- `applications.ts:10` — imports `closedMonthsForDisplay, monthKey` alongside the existing
  `assertPeriodOpen`.
- `applications.ts:377-381` — `isStandaloneWriteOff`, the `type === "WRITE_OFF" && paymentId === null`
  predicate, hoisted to a named constant. It is now consulted twice (once to gather candidate dates,
  once inside the loop) and a second inline copy is exactly how the retention decision and the
  `writeOffs` it exposes would drift apart.
- `applications.ts:426-439` — the batched, live close read, ahead of the loop.
- `applications.ts:446-460` — `stillVoidable` replaces `writeOffs.length === 0` in the drop test.
- `applications.ts:331-338` — the header block gains the bound.

### 1.3 The conditional hint — `erp/src/server/invoice-guards.ts`

- `invoice-guards.ts:12-17` — the one non-type import, with the cycle argument at the import.
- `invoice-guards.ts:116-117` — `WRITE_OFF_VOID_ROUTE` / `WRITE_OFF_VOID_HINT`, now **module-private**.
- `invoice-guards.ts:147-167` — `writeOffVoidHintFor(tx, scope)`, the shared body.
- `invoice-guards.ts:169-182` — `writeOffVoidHint(tx, invoiceId)` and
  `writeOffVoidHintForOrder(tx, orderId)`, the two scopes.

Call sites: `invoices.ts:1481` (discard), `invoices.ts:1646` (unlock), `orders.ts:1361` (void
order). `hasReceivableActivity` / `hasReceivableActivityForOrder` are
untouched — their docblock contract ("a boolean and nothing else") still holds.

### 1.4 Documentation that the change falsified

- `erp/src/app/customers/[id]/ReceivablesSection.tsx:23-34` — the file header claimed the retention
  was unconditional. **Comment only; no rendering change, no props change, no fetch change.**
- `docs/manual/07-receivables.md:172-182` — "A fully written-off invoice stays on the list. It does
  not disappear at zero." was about to become false. Reworded, plus a paragraph on why nothing is
  lost when it drops. `npm run manual:build` re-run (`docs/manual/manual.html`).

I did **not** touch `docs/HANDOFF.md`: the brief assigns the group's HANDOFF entry to Task 4's single
documentation commit, and two tasks writing that file in one checkout is the crossed-index hazard the
brief opens with. Flagging it so it is a decision, not an omission.

---

## 2. The design decisions the brief left to me

### 2.1 Name and docblock of the lock-free read

**`closedMonthsForDisplay(db, glDates): Promise<Map<number, ClosePeriodRef>>`**
(`period-locks.ts:113`).

Name: `ForDisplay` says *what it is allowed to answer* rather than *how it is implemented*. I
considered `closedMonthsUnlocked` and rejected it — "unlocked" describes the mechanism, and someone
reaching for a period check before a write does not care about the mechanism, so the name has to
refuse the use case, not describe the code. Both of its callers are answering "what do we tell the
operator": whether to keep a row on a screen, and how to word a refusal. Neither permits anything.

Docblock (`period-locks.ts:90-112`) leads with **"a DISPLAY read, and NEVER A GUARD"**, then gives
four paragraphs: (a) `closedPeriodFor`/`assertPeriodOpen` are the only sanctioned pre-write path and
why a lock-free read in front of a write breaks the standing invariant silently; (b) it is lock-free
**on purpose** — its callers are page reads and locking there would serialize every customer-page
render against a running close; (c) one query for the distinct months, and it reads on the caller's
`db` (#83/#60); (d) REOPENED is not CLOSED, matching `closedPeriodFor`.

The module header (`period-locks.ts:18-22`) also flags it, so a reader who never scrolls to the
function still learns that one function here does not lock.

**Return shape.** A `Map` keyed on `monthKey`, valued with the same `ClosePeriodRef` `closedPeriodFor`
returns. A `Set<number>` would have been enough for retention but not for the hint, which has to name
the month; returning the ref means one type for both callers and `periodLabel` shared with the guard's
own refusal.

### 2.2 How the batched query is keyed

`year * 100 + month`, this module's existing idiom, now factored into `keyOf` so `lockMonth` and the
new read cannot disagree about what identifies a month (`period-locks.ts:34-42`).

The query itself is keyed on the **distinct `(year, month)` pairs**, not on the key integer — the
`ClosePeriod` table stores year and month as separate columns, so the `OR` list is
`[{year, month}, …]` deduplicated through a `Map` (`period-locks.ts:116-121`). One statement,
however many dates. The integer key exists for the *lookup* side: callers ask
`closed.has(monthKey(d))` without re-deriving UTC year/month themselves.

**Dedup happens before the query, not after**, which is what makes "one query per row" impossible
rather than merely unlikely — and the empty case returns without a query at all
(`period-locks.ts:118`), pinned with a client that throws on any property access.

At the retention call site I hand in the `appliedDate` of **every** standalone write-off on every
invoice in the read, not only those on invoices that are already settled
(`applications.ts:436-439`). Filtering first would mean computing `invoiceOpenBalance` twice or
restructuring the loop into two passes; since the query collapses to distinct months, the extra dates
cost literally nothing, and the one-pass shape keeps the balance math in exactly one place.

### 2.3 Direction of the leaf-to-leaf import edge, and the cycle check

**`invoice-guards.ts` → `period-locks.ts`.** One direction only.

- `period-locks.ts` imports `type Prisma` and `./errors` (`HttpError`). It does **not** import
  `invoice-guards.ts`, nor any service. Verified by reading the file and by
  `tests/period-locks.test.ts:50` ("stays a dependency-free leaf").
- `errors.ts` is the original leaf and imports nothing of ours.
- So the closure is `invoice-guards → period-locks → errors`, a chain with no back edge. **No cycle.**

I tightened `tests/invoice-guards.test.ts:560-565` from "does not contain these three names" to a
**full allowlist** — the import list must equal exactly
`["../../prisma/generated/prisma/client", "./period-locks"]`. Before #157 the file was type-only, so
the three-name denylist was cheap insurance; now that it has a real runtime dependency, the next
import needs to be a decision rather than a convenience, and only an allowlist forces that.

### 2.4 Exact shape of the conditional hint

The constant became **module-private** (`invoice-guards.ts:117`). This is the one place I went past
the literal brief, deliberately: leaving `WRITE_OFF_VOID_HINT` exported leaves two ways to spell the
tail, one of which is unconditional and wrong in exactly the case this task exists for. Un-exporting
makes the wrong one un-typeable rather than merely discouraged. It is stated in the docblock so a
reviewer can reverse it in one line if they disagree.

Output, exactly:

| Case | String |
|---|---|
| no standalone write-off in scope | ` (a bad-debt write-off is voided from the customer's Receivables section)` |
| all still voidable | *identical to the above, byte for byte* |
| one closed month | ` (… Receivables section, but period 2026-01 is closed — reopen it first)` |
| several closed months | ` (… Receivables section, but periods 2026-01, 2026-02 are closed — reopen them first)` |

Four decisions inside that:

1. **Vacuous case keeps today's sentence.** When a payment or credit is what blocked and there is no
   standalone write-off at all, "every one of them is still voidable" holds vacuously and the sentence
   does not change — matching the brief's "keep today's sentence unchanged", and keeping every
   existing message and test in the three services untouched.
2. **Scoped to standalone (null-payment) write-offs** (`LIVE_STANDALONE_WRITE_OFF`,
   `invoice-guards.ts:121`). A residual write-off is voided from its receipt batch, so a closed month
   behind one says nothing about the route this sentence names. Pinned by a test.
3. **All closed months, ascending, never just the first.** The `finalizedInvoicesFor` rule — a
   refusal must not change wording between identical attempts, so scan order cannot be allowed to
   decide which month the operator hears about. And naming one of two leaves them to find the second
   the hard way.
4. **Singular/plural inflected** (`period`/`periods`, `is`/`are`, `it`/`them`). One extra ternary
   trio for a sentence an operator actually reads.

The order scope reaches write-offs through `invoice: { orderId }`
(`invoice-guards.ts:181`) — mirroring `hasReceivableActivityForOrder`'s first arm. The credit arm
contributes nothing: a write-off never carries a `creditInvoiceId`, so there is no second arm to add.

### 2.5 Point-in-time vs. live — decided, and written down

**Live, ignoring `asOfDate`.** Stated with its reason at `applications.ts:431-435`: `ClosePeriod`
records no history from which "was August closed as of June" could be reconstructed, and the question
retention answers — *can I still undo this?* — is a now question. A back-dated read would offer an
undo that `voidApplication` refuses this instant, which is the same class of lie as the row this task
removes. The comment says explicitly that this is the one asymmetry in a function whose every other
filter is cut at `asOfDate`, so it does not read as an oversight.

### 2.6 The `writeOffs` array on a retained row is NOT filtered

A retained row still lists closed-month write-offs alongside the voidable one
(`applications.ts:455-459`, and asserted in the multi-month test). They are part of why the row reads
the way it does, and their **Void** refuses with `assertPeriodOpen`'s own message, which names the
month to reopen — a true route, not a dead end. Filtering them out would leave an amber "Written off"
badge over a partial list of write-offs, which is a fresh version of the defect this group is about.
Commented at the branch.

---

## 3. Tests

### 3.1 `erp/tests/write-offs.test.ts` — the retention bound (`:445-589`)

| Test | Catches | RED? |
|---|---|---|
| `hides the row and refuses the void together, once the write-off's month closes` | the coupling the owner asked for — row present + close + row gone + `voidApplication` 409 on the **same application id**, plus "refused, not half-applied" | **RED-verified** |
| `covers the partial-write-off-then-settled-in-cash shape identically` | ruling point 2 — the second retention shape reaches `open <= 0` by a different route and must obey the same rule | **RED-verified** |
| `keys on the write-off's month, not the invoice's` | a "simplification" to `inv.invoiceDate`/`finalizedAt`: the INVOICE's month is closed, the write-off's is not, row must stay | green both ways by design (discriminating negative) |
| `retains while ANY standalone write-off is still voidable, across several months` | the `[0]` simplification the branch comment warns about; also asserts both write-offs still render | **RED-verified** |
| `cannot move the balance — the rows sum to the net before and after the close (#83)` | ruling point 4 — sum-to-net asserted on **both** sides of the close, net unmoved at 250 | **RED-verified** (the post-close half) |
| `does not evict a PARTIALLY written-off invoice that still has a live balance` | over-eviction: an open invoice is an open item on its own merits | green both ways (discriminating negative) |
| `brings the row back when the month is REOPENED` | that the correction route the ruling assumes really works | **RED-verified** |

### 3.2 `erp/tests/write-offs.test.ts` — the conditional hint (`:591-673`)

| Test | Catches | RED? |
|---|---|---|
| `unlock: keeps today's sentence exactly while the write-off's month is open` | a widening of the common case; asserts the exact string **and** absence of `/reopen/` | green both ways (that is the point) |
| `unlock: names the closed period and the reopen once the write-off's month is closed` | the reachable §5.14 failure, end to end, at the site where it bites | **RED-verified** |
| `void-order: the ORDER scope reaches the same write-off, and names every closed month` | the second call site, plus the ascending multi-month wording | **RED-verified** |
| `void-order: keeps today's sentence when the closed month holds no write-off of this order's` | a scope leak — a closed month with nothing of this order's in it must not widen the sentence | green both ways (discriminating negative) |
| `ignores a payment-sourced residual write-off in a closed month` | the standalone/residual scoping | green both ways (discriminating negative) |

### 3.3 `erp/tests/period-locks.test.ts` — the new read (`:110-208`)

| Test | Catches | RED? |
|---|---|---|
| `returns only CLOSED months among the dates asked about, keyed by monthKey` | REOPENED treated as closed; a closed month nobody asked about being volunteered | new function, no unfixed version |
| `answers an empty date list without touching the database` | the early return being merely fast rather than real — the client throws on any access | new function |
| `issues ONE query for the DISTINCT months, however many dates it is handed` | the per-row query shape, via a call recorder; also asserts the exact deduplicated `OR` list | new function |
| `labels a month the way the refusal does` | `periodLabel` drift | new function |
| **`takes NO month lock, while assertPeriodOpen still does`** | **the load-bearing safety property** | **RED-verified BOTH ways** |

That last one holds a real advisory lock on 2026-07 in one transaction and asserts, in one test, that
`closedMonthsForDisplay` answers anyway while `assertPeriodOpen` blocks until the holder commits.
RED-verified in both directions, with the probes run and the failures observed:

- adding `await lockMonth(db, …)` to `closedMonthsForDisplay` → *Test timed out in 5000ms* (the
  display read hangs behind the held lock);
- routing `assertPeriodOpen` through `closedMonthsForDisplay` instead of `closedPeriodFor` →
  `expect(guardBlockedWhileHeld).toBe(true)` fails with `- true / + false`.

The probes were applied to a copy-restored file, not committed.

### 3.4 `erp/tests/invoice-guards.test.ts` — the hint's scoping (`:279-355`) and the leaf pin (`:565`)

Four tests on the two hint functions directly — the vacuous/open case, the closed case at both
scopes, a **voided** write-off (soft-deleted rows are not a route out of anything, and this is the one
place `deletedAt: null` in `LIVE_STANDALONE_WRITE_OFF` is pinned), and per-invoice / per-order
scoping. Plus the import allowlist described in §2.3.

### 3.5 The whole-suite RED run

`git stash push` of the four service files, full `tests/write-offs.test.ts` run against the unfixed
code: **7 failed, 35 passed** — the seven marked RED-verified above, with the five discriminating
negatives correctly passing on both sides. Restored with `git stash pop` and re-verified green.

---

## 4. Fixture notes a reviewer will ask about

Three of the retention tests close today's month with a **raw `ClosePeriod.create`**
(`closeMonthRaw`, `write-offs.test.ts:424-430`) rather than the real `closePeriod`, and both places
say why at the call site:

- the partial-then-cash test — `payInvoice` builds its receipt batch raw and never posts it, so
  `computeRollForward` refuses on a 600 variance that is not this test's subject;
- the multi-month test — with 2026-01 closed, a real close of today's month refuses on the
  prior-month chain rule.

The **coupled** test and the **sum-to-net** test both use the real `closePeriod`, which is where it
matters: those two are the ruling's own points 3 and 4. `assertPeriodOpen` and the retention read
both look for the same CLOSED row, so a raw row is a faithful stand-in where the roll-forward is
noise.

A write-off dated anywhere but today can only be built with the raw client — `writeOffInvoice` stamps
`todayDateOnly()` on purpose. `writeOffDated` (`write-offs.test.ts:432-441`) does that, with the
reason stated in the block comment above it.

---

## 5. What I could NOT verify mechanically

- **There is no DOM test environment in this repo.** The only `.tsx` change is a file-header comment
  in `ReceivablesSection.tsx` — no JSX, no props, no fetch, no state — so there is nothing to render
  differently and nothing a component test could have caught. The behavioural change is entirely
  server-side: the row simply stops arriving in `openItems`.
- **I did not run `npm run test:e2e`** (the orchestrator runs it for the group). My reading of the two
  flows that touch write-offs says neither is affected: `receivables-apply-age-statement.mjs` does its
  standalone write-off and its undo inside an **open** month — if that month were closed the write-off
  could not have been created in the first place, so the retention bound cannot fire there — and
  `close-month-end.mjs` uses a **residual** (payment-sourced) write-off voided from `BatchDetail`,
  which this surface never retained. **No `.mjs` file was edited**, so the `node --check` caveat does
  not apply. I state this as reasoning, not as a run.
- **Whether the multi-closed-month hint wording is the one the owner wants.** It is my call
  (§2.4 items 3–4); the singular form is pinned by test at two call sites, the plural at one.
- **The un-exporting of `WRITE_OFF_VOID_HINT`** (§2.4) is one step past the literal brief. Green
  everywhere, but it is a deliberate decision open to challenge.

---

## 6. Adjacent defects noticed and deliberately NOT fixed

1. **The `writeOffs` array is not period-aware on a still-OPEN invoice.** A partially written-off
   invoice with a live balance renders a **Void** control for a write-off in a closed month; clicking
   it 409s. The message is true and names the month to reopen, so it is not the "screen states
   something the system does not mean" class this group is about — but §5.16's visible-and-disabled
   convention would say the control should be disabled with the reason, the way the *Write off*
   button already is (`ReceivablesSection.tsx:381-395`). Doing it needs a per-write-off `voidable`
   flag on `OpenItemWriteOff` and a client change, which is past this brief. Worth filing.
2. **`discardInvoice`'s hint is unreachable in practice.** `hasReceivableActivity` there is
   documented defense-in-depth — a DRAFT can never carry an application through the services — so the
   third call site's conditional hint is untestable through the service layer. I wired it (all three
   sites had to move together) but tested the shared body directly in `invoice-guards.test.ts`
   instead. Not a defect; noting it so a reviewer does not read the missing service-level test as a
   gap.
3. **`manual:build` reports 14.60 MB against a 16 MB ceiling** and points at #169. Already filed;
   flagged only because my rebuild surfaced the warning.

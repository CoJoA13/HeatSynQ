# Task 1 (#173) — implementer report

**Commits:**

- `c482187` — `refactor(invoice-guards): name the void hint after what it is about (#173)` (rename only,
  no behaviour change)
- `3b78dc8` — `fix(invoice-guards): the closed-period clause covers every application, not only
  write-offs (#173)`

**Branch:** `round-3-group-a-residue` (base `614f97f`).

**Gates:** `npx tsc --noEmit` clean · `npx eslint src tests` clean · the brief's five-file run
(`write-offs`, `invoice-guards`, `period-locks`, `invoices`, `orders`) **311 passing** · and, because
this task edits the body of a guard 40-odd call sites away from its tests, the **whole suite**:
**204 files, 3493 tests, all passing**, one process. `npm run test:e2e` not run (orchestrator runs it
at group close).

---

## 1. What changed, and why

### 1.1 The rename — `c482187`

`writeOffVoidHint` named the clause the sentence *opens with*, not the question it answers: the three
refusals it is appended to fire for any live application, and after this task its period read covers
every kind. Renamed to **`applicationVoidHint` / `applicationVoidHintForOrder`** (shared body
`applicationVoidHintFor`), which is what `voidApplication` calls the thing being voided.

Separate commit deliberately, so the behaviour diff below reads as behaviour. Five files, mechanical:
`invoice-guards.ts`, the three call sites' import + call lines (`invoices.ts:10,1481,1646`,
`orders.ts:17,1361`), `tests/invoice-guards.test.ts`. Gates green between the two commits.

This is the one place I went past the literal brief (it lists the call sites as "only if genuinely
required"). The justification: I was editing the comment directly above each call anyway — all three
said "only when a standalone write-off in scope sits in a closed month", which this task makes false
— so the rename cost one token per site on lines I was already touching. Reversible in one `sed`.

### 1.2 The scope — `src/server/invoice-guards.ts:120-137, 186-216`

| Location | What |
|---|---|
| `invoice-guards.ts:132-133` | `liveActivityForInvoice(invoiceId)` — `hasReceivableActivity`'s own `where`, hoisted |
| `invoice-guards.ts:137-138` | `liveActivityForOrder(orderId)` — `hasReceivableActivityForOrder`'s own `where`, hoisted |
| `invoice-guards.ts:210` | `applicationVoidHint` reads `liveActivityForInvoice` |
| `invoice-guards.ts:216` | `applicationVoidHintForOrder` reads `liveActivityForOrder` |
| `invoice-guards.ts:248, 275` | the two guards now read the same two constants |
| `invoice-guards.ts` (deleted) | `LIVE_STANDALONE_WRITE_OFF` — the write-off filter that was the defect |

The brief asks that the per-order hint scope "stay a subset of `hasReceivableActivityForOrder`'s
arms". I made it **identical rather than a subset**, by construction: subset-but-not-equal is exactly
the failure #173 is — a sentence that goes silent about a row that really did block you. One
predicate per scope, consumed by the guard and by the sentence, so they cannot drift in either
direction.

This does **not** widen `hasReceivableActivity`. Its signature, return type and docblock contract
("a boolean and nothing else") are untouched; only the literal in its `where` moved four lines up,
and the docblock now says out loud that the sentence is the sibling's job
(`invoice-guards.ts:241-242`). The two arms' rationale stays documented where it always was, on the
guard.

**The `creditInvoiceId` arm is the part the old scope could not reach at all.** A row whose
`creditInvoiceId` is this invoice is a CREDIT applied against some (possibly other) order's invoice;
it makes `hasReceivableActivity` true, so it blocks the refusal, and `voidApplicationInTx` guards its
`appliedDate` like everything else. The old write-off filter (`paymentId: null, type: "WRITE_OFF"`)
could never match one. Pinned by a new test.

### 1.3 The sentence — `invoice-guards.ts:186-205`

Query shape unchanged in kind: one `application.findMany` for the `appliedDate`s in scope, then the
lock-free `closedMonthsForDisplay` for the distinct months. `closedPeriodFor` is still not used and
`period-locks.ts`'s caller allowlist (`tests/period-locks.test.ts:250`) needed **no change** — no new
caller was added.

One simplification: the old `if (rows.length === 0) return …` early return is gone
(`invoice-guards.ts:191-194`). It is redundant now that the scope is the guard's own predicate (if
the guard fired, the set is non-empty), and `closedMonthsForDisplay` already answers an empty date
list without a query — pinned by its own "without touching the database" test. `closed.size === 0` is
the single un-widened branch.

### 1.4 Call-site comments — `invoices.ts:1477-1479, 1638-1645`, `orders.ts:1356-1358`

All three claimed the standalone-write-off scoping. Rewritten; each now also states that the hint is
computed inside the `if`.

---

## 2. The exact sentence, clause by clause

### 2.1 The two clauses, and what each is asserted of

**Clause 1, the ROUTE clause** — `a bad-debt write-off is voided from the customer's Receivables
section`.

True of **standalone (null-payment) write-offs only**, and it is phrased as a standing fact about
that one kind rather than as an instruction about the rows in scope. It is asserted of *nothing* in
the set — which is why it can ride on a payment-only refusal, as it already did before this task
(`tests/invoices.test.ts:1396` pins that byte-exact, payment-only message and still passes
untouched). Kept unconditional; §2.3 argues why.

**Clause 2, the PERIOD clause** — `what is applied in period 2026-01 cannot be voided until that
period is reopened`.

True of **every kind in scope**, because the guard it restates — `voidApplicationInTx`'s
`assertPeriodOpen(live.appliedDate)` at `applications.ts:896` — has no `type` and no `paymentId`
predicate. Its subject is "what is applied in <month>", not the Receivables section, and it names no
destination at all. The months come only from rows in scope, so each named month provably contains at
least one blocking row.

### 2.2 The join is the load-bearing bit

The clauses are separated by a **semicolon and share no subject**. #157's join was
`", but period 2026-01 is closed — reopen it first"`, which grammatically hangs the obstacle off the
route just named: it reads as *the Receivables section is what 2026-01 blocks*. That is true when the
closed-month row is a standalone write-off and **false the moment it is a payment** — i.e. false in
exactly the case this task exists to add. Widening the month scope under the old join would have
produced a bigger version of the defect, not a fix.

### 2.3 Every case, exactly

| Case | String |
|---|---|
| nothing in scope in a closed month (any kind, incl. none) | ` (a bad-debt write-off is voided from the customer's Receivables section)` — **byte-identical to today's** |
| one closed month | ` (a bad-debt write-off is voided from the customer's Receivables section; what is applied in period 2026-01 cannot be voided until that period is reopened)` |
| several | ` (… Receivables section; what is applied in periods 2026-01, 2026-02 cannot be voided until those periods are reopened)` |

Singular/plural inflected on `period`/`periods` and `that period is`/`those periods are`. Months
ascending and **all** of them, unchanged from #157 (`finalizedInvoicesFor`'s rule that a refusal must
not change wording between identical attempts, and naming one of two leaves the operator to find the
second the hard way).

### 2.4 The mixed-set example the brief asked for

Fixture (`tests/write-offs.test.ts:745`): one invoice, a **PAYMENT** of 400 dated **2026-01-20** and a
**standalone write-off** of 600 dated **2026-02-10**; both months closed. `unlockInvoice` renders, in
full:

> Invoice #520047 has payments, credits or write-offs applied — void them before unlocking (a
> bad-debt write-off is voided from the customer's Receivables section; what is applied in periods
> 2026-01, 2026-02 cannot be voided until those periods are reopened)

Clause by clause, against **this** set:

| Clause | True of | Asserted of the payment? |
|---|---|---|
| "a bad-debt write-off is voided from the customer's Receivables section" | the 2026-02 write-off | **no** — it names a kind, and the payment is not that kind |
| "what is applied in periods 2026-01, 2026-02 cannot be voided until those periods are reopened" | **both** rows | yes, and truly |

The operator learns both months in one read, and is never told the Receivables section is where the
payment goes. Asserted as the **whole message**, `toBe` not `toContain`, so a future clause cannot be
smuggled in beside it.

---

## 3. The destination clause: kept as a special case

**Kept, unconditional, unaltered — not made write-off-conditional, and not extended per kind.**

Three reasons, in order of weight:

1. **Per-kind destinations are ruled out and rightly.** The mixed set above would become "…voided
   from the customer's Receivables section, and a payment or residual write-off from its receipt
   batch, but 2026-01 and 2026-02…" — a sentence an operator skips. The brief says so; I agree after
   drafting it.
2. **Conditional-on-a-write-off-existing is not obviously better and breaks a pin.** Suppressing the
   clause when no standalone write-off is in scope would be *more* targeted, but
   `tests/invoices.test.ts:1396` pins the byte-exact payment-only message **including** this clause,
   and the brief requires the unchanged sentence when everything in scope is voidable. More to the
   point, the clause is navigation, not an instruction about the blocking row — it answers "where do
   write-offs get voided", which is a fair thing for an A/R refusal to volunteer.
3. **Once the join is a semicolon, the failure mode is gone.** The defect was never the clause; it
   was the clause being *chained to* a month it does not own.

I did not find a phrasing that does more without becoming unreadable, so nothing is shipped
unflagged.

---

## 4. That the hint is still on the refusal path only

**Verified two ways.**

1. **By reading all three sites** (quoted in §1.4's refs): at `invoices.ts:1479-1482`,
   `invoices.ts:1646-1648` and `orders.ts:1359-1361` the `await applicationVoidHint…(tx, id)` sits
   inside the template literal of the `throw new HttpError(…)` **inside** the
   `if (await hasReceivableActivity…)` block. There is no other reference to either function in
   `src/` — `grep -rn "applicationVoidHint" src` returns the definitions plus exactly those three
   calls and two imports.
2. **Mechanically, at the unlock site** —
   `tests/write-offs.test.ts:784` *"costs nothing on a successful unlock — the hint never runs off the
   refusal path"*. A successful `unlockInvoice` (no applications at all) is run with
   `prisma.application.findMany` swapped for a counting wrapper (plain property save/restore in a
   `finally`, never `vi.spyOn` — CLAUDE.md), and the count must be **0**. `application.findMany` is
   the hint's first statement and nothing else on the unlock path uses that delegate, so a hoist
   above the `if` turns the test red. Counting `closePeriod.findMany` instead would **not** have
   discriminated: on a success path the scope is empty and `closedMonthsForDisplay` short-circuits
   without a query even if hoisted. This test passes on both sides of the fix by design — it is a
   regression pin on a property #157 already had, not a proof of this change.

The equivalent counter for `discardInvoice` and `voidOrder` is **not** written; §7 says why.

---

## 5. Tests

### 5.1 `tests/write-offs.test.ts`

| Test | Line | Catches | RED? |
|---|---|---|---|
| `unlock: names the closed period when a PAYMENT is what sits in it` | `:705` | the headline defect, end to end, with **no write-off in scope at all**; also asserts the route clause was not re-pointed at the payment (`not.toMatch(/payment is voided\|batch/i)`) | **RED-verified** |
| `void-order: the ORDER scope reaches the payment too` | `:726` | the second call site, order scope | **RED-verified** |
| `names both months when a payment and a write-off sit in different closed ones` | `:745` | the mixed set of §2.4, as a **whole-message `toBe`** | **RED-verified** |
| `keeps today's sentence when the payment's own month is open` | `:763` | over-widening: cash in an open month must not start widening the common sentence now that the scope sees it | green both ways (discriminating negative) |
| `costs nothing on a successful unlock …` | `:784` | a hoist of the hint out of the `if` | green both ways (regression pin, §4) |
| `counts a payment-sourced residual write-off — the period guard is kind-blind` | `:673` | **the assertion this task reverses** — it previously asserted the closed month behind a residual write-off was *ignored* | **RED-verified** |
| `unlock: names the closed period and the reopen once the write-off's month is closed` | `:623` | #157's own case, re-pinned on the new wording | **RED-verified** (new string) |
| `void-order: … names every closed month` | `:640` | #157's plural case, re-pinned | **RED-verified** (new string) |
| `unlock: keeps today's sentence exactly while the write-off's month is open` | `:613` | the byte-identity requirement | unchanged, green both ways |
| `void-order: keeps today's sentence when the closed month holds no write-off of this order's` | `:657` | scope leak | unchanged, green both ways |

Fixture change: `payInvoice(inv, amount, dateStr = TODAY)` (`:97-121`) takes an optional date. The
default keeps every pre-existing caller byte-identical. The docblock states why the payment is built
raw — `applyPayment` stamps the receipt's own date, and the state #173 is about is reached by
**closing the month the payment already sits in**, not by backdating a receipt.

### 5.2 `tests/invoice-guards.test.ts` — the scoping

| Test | Line | Catches | RED? |
|---|---|---|---|
| `names the closed period for a PAYMENT, with no write-off in scope at all` | `:340` | the widened scope at the function boundary, both forms | **RED-verified** |
| `reaches the creditInvoiceId arm, on both scopes` | `:369` | the guard arm the old filter could **never** match — a credit applied cross-order, asked about from the credit, from the credit's order, from the target invoice and from the target's order | **RED-verified** |
| `names the closed period once the write-off's own month is closed` | `:326` | #157's case on the new wording | **RED-verified** (new string) |
| `is today's sentence with no application at all, and with one in an open month` | `:315` | byte-identity | unchanged, green both ways |
| `ignores a VOIDED application …` | `:395` | `deletedAt: null` in the shared predicate — a soft-deleted row is not a route out of anything | unchanged, green both ways |
| `scopes to the invoice / the order asked about` | `:404` | cross-invoice / cross-order leakage | unchanged, green both ways |

The import allowlist (`tests/invoice-guards.test.ts:565`) is untouched and still passes: the import
set is unchanged at `["../../prisma/generated/prisma/client", "./period-locks"]`.

### 5.3 The RED run

New and changed assertions run against the **renamed-but-unwidened** code (`c482187`, i.e. after the
mechanical rename so the failures are behavioural rather than import errors):
**8 failed, 64 passed** across the two files — the 8 marked RED-verified above, with the four
discriminating negatives correctly passing on both sides. Transcript summary:

```
× unlock: names the closed period and the reopen once the write-off's month is closed
× void-order: the ORDER scope reaches the same write-off, and names every closed month
× counts a payment-sourced residual write-off — the period guard is kind-blind
× unlock: names the closed period when a PAYMENT is what sits in it
× void-order: the ORDER scope reaches the payment too
× names both months when a payment and a write-off sit in different closed ones
× names the closed period once the write-off's own month is closed
× names the closed period for a PAYMENT, with no write-off in scope at all
× reaches the creditInvoiceId arm, on both scopes
```

(Nine lines, eight test cases — `reaches the creditInvoiceId arm` and
`names the closed period for a PAYMENT` are two of them; the wording-only re-pins account for the
rest.) All green after the fix, then the whole 3493-test suite green.

---

## 6. What I could NOT verify mechanically

- **That the wording is the one the owner wants.** §2.3's phrasing is my call. The semicolon join and
  "what is applied in period X cannot be voided until that period is reopened" are argued in §2.2 and
  in the docblock at `invoice-guards.ts:140-184`; both are one-line reversals if the owner prefers
  another sentence. The singular form is pinned at four sites, the plural at two.
- **The rename** (§1.1) is one step past the literal brief. Green everywhere, deliberate, open to
  challenge.
- **No DOM test environment**, and no `.tsx` was touched — but note that this hint is server text only:
  it reaches the operator through the API error body, so there is no client half to cover here at all.
- **`npm run test:e2e` not run** (orchestrator's, at group close). No `.mjs` was edited, so the
  `node --check` caveat does not apply. Reading the flows: no e2e flow asserts on any of the three
  refusal messages (`grep -rn "void them\|write-offs applied\|Receivables section" erp/e2e/` is
  empty), and `receivables-apply-age-statement.mjs` does its write-off and undo inside an open month.
  I state this as reasoning, not as a run.
- **The `discardInvoice` refusal remains untestable through the service layer** — `hasReceivableActivity`
  there is documented defense-in-depth and a DRAFT can never carry an application through the
  services. It is covered by the direct-call tests in `invoice-guards.test.ts`, as #157 did. Not a
  gap; noting it so the two-of-three call-site coverage reads as deliberate.

---

## 7. Adjacent defects noticed and NOT fixed

1. **`docs/manual/06-invoicing.md:153` quotes the unlock refusal, truncated before the parenthetical**
   — so nothing there is falsified by this change, and I left the manual alone rather than force a
   `manual:build` that Task 4 will redo. But the closed-period clause is **new operator-visible
   text**, and that chapter's "two things stop it" list plus `07-receivables.md`'s reopen paragraph
   (`:202`, `:218-226`) are where a sentence about it would go. **Flagging for Task 4**, not filing.
2. **The period clause names months but not which row is in which month.** With two closed months and
   four applications, the operator learns both months and must open the batch/Receivables screens to
   see which row is where. That is the deliberate stopping point (the brief's "do not name a
   destination per kind"), but it is where the next complaint will come from if one comes.
3. **`voidApplicationInTx` re-reads `stub.invoiceId` with `findFirst` and no `deletedAt` filter**
   (`applications.ts:881`) before claiming — intentional (it needs the row's order even when the
   application is already voided, and re-reads live under the claim at `:891`). Not a defect; noted
   because it looks like one on a first read and I checked it.

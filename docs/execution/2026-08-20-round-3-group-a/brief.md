# Round 3 Group A — "the A/R screens tell the truth"

**Branch:** `round-3-group-a` off `main` at `814a025`.
**Closes:** #155 (arm 2 only), #157, #163.
**Plan:** `docs/2026-08-20-backlog-round-3.md` § "Group A". **Rulings:** the owner's comments on #155,
#157 and #159, quoted inline below — read them on the issues too, they are the contract.

Three tasks, **run STRICTLY IN SEQUENCE**. They are not parallelizable: Tasks 1 and 2 both edit
`src/server/applications.ts`, and Tasks 1 and 3 both edit
`src/app/receivables/batches/[id]/BatchDetail.tsx`. There are no worktrees here — two agents editing
one file in one checkout clobber each other. Order is **2 → 1 → 3**, biggest first.

Implementers **commit with explicit pathspecs, never `git add -A`** (Group D's crossed-index incident
is why).

## Standing constraints for all three tasks

- TDD: failing test → implement → pass → commit. Conventional commits, **no attribution trailer**.
- `npm run test:e2e` is **mandatory** (owner instruction) even where it verifies nothing new. It needs
  the dev server and the **DEV** database (`erp`, not `erp_test`).
- **`npx eslint src tests` does not cover `e2e/`** — it exits 0 on an unparseable flow file. Run
  `node --check` on any edited `.mjs`. (Group I's standing lesson, still not automated.)
- **There is no DOM test environment in this repo.** Component render behaviour cannot be unit-tested;
  the only mechanised check on a `.tsx` change is Playwright. Where a task changes rendering, say so
  in the report and cover it in E2E rather than claiming a unit test that cannot exist.
- Updating `docs/HANDOFF.md` is part of the work, not a follow-up.
- **No task here needs a migration, an audit-registry edit, a new allocating entry point, or a new
  Serializable mutation.** Verified across the whole round-3 backlog. If you find yourself reaching for
  one, stop and report rather than improvising.

## The one rule that spans this whole group

Every defect here is the same shape: **a screen states something the system does not mean.** A batch
nobody proved renders as proved. A discount the operator could earn renders as nothing at all. A
write-off row advertises an undo that a closed month has already killed. Fixes are judged on whether
the screen now says a true thing, not on whether the number changed.

---

## Task 2 (FIRST) — #157: bounded write-off retention, and a hint that names a route that exists

**Owner ruling (2026-08-19), option (b): retain a written-off row only while the write-off's own
period is open.** Once that month closes, voiding the write-off needs an unlock anyway, so the row has
stopped being a route out of itself and keeping it is clutter without a purpose.

### What is true today (verified during recon)

- `openItemsForCustomer` (`src/server/applications.ts:369`) retains a settled invoice when it carries
  at least one live **standalone** write-off — `type === "WRITE_OFF" && paymentId === null`
  (`:419-424`). The `continue` at `:427` is the retention branch.
- The undo it anchors is `voidApplication`, which guards
  `assertPeriodOpen(tx, live.appliedDate)` at `applications.ts:779`, and `writeOffInvoice` sets
  `appliedDate = todayDateOnly()` at `:1060`. **The retention rule and the void guard therefore key on
  exactly the same date** — the owner already answered point 3 of the ruling on the issue: voiding a
  write-off in a closed month is *already* refused, so dropping the row strands nothing that still
  worked.
- Existing retention tests: `tests/write-offs.test.ts:341-409`, five cases.

### 1. The retention branch

Retain only while the write-off's period is **open**. Both retention shapes the ruling names are the
same rule: the full write-off, and the partial standalone write-off later settled in cash. Key on the
**write-off's** `appliedDate`, never the invoice's date.

Where an invoice carries several standalone write-offs across different months, retain while **any**
of them is still voidable — the row is a route out for that one. Say so in the comment; it is the
kind of thing a later reader will otherwise "simplify" to `[0]`.

### 2. The closed-period read must be LOCK-FREE, and must be impossible to misuse

**Do not reuse `closedPeriodFor`** (`src/server/period-locks.ts:44`). It calls `lockMonth` first, and
a display read taking a per-month advisory lock would serialize **every customer-page view** against a
running close. That is a real availability regression, not a theoretical one.

Add a lock-free read to `period-locks.ts` — it is a deliberate dependency-free leaf and the right
home. Requirements:

- **Batched.** The retention branch runs inside a loop over invoices. One query for the distinct
  `(year, month)` pairs of every candidate write-off, not one query per row. `year * 100 + month` is
  already this module's key idiom (`lockMonth`).
- **Named and documented so that using it as a posting guard is obviously wrong.** This is the
  load-bearing safety property of the task. The existing `closedPeriodFor`/`assertPeriodOpen` pair is
  load-bearing for the period lock's STANDING INVARIANT; a lock-free sibling sitting next to them is a
  foot-gun unless its name and docblock say *display reads only, never a guard*.
- **Pin it with a test** that `assertPeriodOpen` still goes through the locking path. The
  import-shape test in `tests/period-locks.test.ts` is the precedent for pinning a structural property
  of this module.

**Read it on the caller's `db`, not the `prisma` singleton.** `openItemsForCustomer` already takes
`db: Prisma.TransactionClient = prisma` and `customerReceivablesSummary`
(`src/server/customer-receivables.ts:59`) threads its RepeatableRead `tx` in — that is the #83
"figures shown together must be read together" rule, and a read that defaults to the singleton
executes on a different connection and outside the snapshot (CLAUDE.md's #60 rule). Thread the `db`
through.

### 3. Point-in-time vs. live: decide it explicitly and write down which

`openItemsForCustomer` takes an `asOfDate` and every other filter in it is point-in-time. **The close
state is not** — `ClosePeriod` records no history you could reconstruct "was August closed as of
June" from, and the question retention answers ("can I still undo this?") is a *now* question, not an
as-of question. So read the close state live, regardless of `asOfDate`, **and say that in the comment
with the reason.** A reviewer will ask; an unexplained asymmetry next to three carefully-documented
point-in-time cuts reads as an oversight.

### 4. The §5.14 hazard — `WRITE_OFF_VOID_HINT` becomes conditional

This is **pre-existing**, not created by the ruling, and the ruling makes it worse. Recorded on the
issue as my decision, not the owner's, and explicitly open to the reviewer's challenge.

`WRITE_OFF_VOID_HINT` (`src/server/invoice-guards.ts:105`) is one constant appended to three refusals
— `invoices.ts:1479` (discard), `invoices.ts:1640` (unlock), `orders.ts:1358` (void order):

> ` (a bad-debt write-off is voided from the customer's Receivables section)`

**The reachable failure:** `unlockInvoice` guards the invoice's `finalizedAt` while a write-off is
dated at its own creation. A July-finalized invoice with an August write-off, in a closed August — the
unlock is permitted to *try* (July is open), the refusal sends the operator to the Receivables
section, and the void there is refused because August is closed. After this task the row is not even
on the screen.

**Make the sentence conditional on the write-off's own period** rather than widening it
unconditionally. §5.14 asks a block to name the route that *actually exists*; appending "or reopen the
period" to every refusal is cheaper but sends operators toward a heavyweight month reopen in the
common case where they need none — a different §5.14 failure.

Constraints:

- **Keep today's sentence unchanged when every standalone write-off in scope is still voidable.** Do
  not churn the three existing messages or their tests for the common case.
- **Add the closed-period clause when at least one live standalone write-off is in a closed month** —
  that operator *will* hit the wall, so name it, and name the month.
- **Two scopes, not one.** `invoices.ts` asks per-invoice (`hasReceivableActivity`); `orders.ts:1358`
  asks per-order (`hasReceivableActivityForOrder`, which also spans credits raised on the order).
  Both need the hint.
- **Do not change `hasReceivableActivity`'s contract.** Its docblock is explicit that it answers a
  boolean and nothing else — "the guard cares only WHETHER any live row exists". Add a sibling; do not
  widen the existing one.
- **`invoice-guards.ts` stays a leaf** — `type Prisma` only, throws nothing, checks no permission,
  reads on the caller's own claimed `tx`. `tests/invoice-guards.test.ts` pins the import shape. The
  lock-free period read lives in `period-locks.ts`, which is also a leaf importing only `type Prisma`
  and `HttpError`, so a leaf-to-leaf import is fine — **check that it does not create a cycle** and
  say in the report which direction the edge runs.

### 5. Tests

- **Pin both halves of the coupling together in one test** (the owner asked for this explicitly): row
  hidden after the close **and** `voidApplication` refused for that same application. The point is
  that the two are coupled by design rather than by coincidence.
- The partial-then-settled-in-cash shape, per the ruling's point 2.
- **Confirm dropping the row cannot move the balance** (ruling point 4). Retained rows carry
  `open: 0`, so the `#83` sum-to-net property must hold before and after the close.
  `tests/write-offs.test.ts:359-372` is the existing version of that assertion.
- The conditional hint: both branches, and at more than one of the three call sites.

---

## Task 1 (SECOND) — #155 arm 2: the hidden discount offer names no route out

**Owner ruling (2026-08-19): arm 1 is CLOSED, arm 2 proceeds.** Do not touch the eligible basis, do
not change `remainingDiscountFor`, and **leave the test named `applyPayment — DISCOUNT line > leaves
the entitlement cap — not the settlement guard — refusing the two-step discount` exactly as it is** —
it now documents a deliberate narrowness rather than flagging a boundary to revisit.

**Arm 1 also carries one small piece of work:** the owner asked for *"a comment at the arithmetic so
the next reader does not re-derive the empty set and file it again."* Put it where
`remainingDiscountFor` and the settlement feasibility test meet in `discountAvailable`
(`applications.ts:153-205`): `percent × open < open` for any percentage below 100, so the two-step
case is an empty set by construction, and that is intended.

### The defect

`BatchDetail.tsx:320` renders the "Take N" checkbox only when `discountAvailable > 0`, and since #69
that figure is 0 whenever this payment's unapplied cash cannot settle the invoice. With terms of 2/10
and a receipt inside the window, an operator entering a partial payment sees **nothing at all** in the
Discount column — no control, no explanation — and no way to learn that a larger remittance would earn
20.00. Two very different situations (nothing to offer / something you could reach) render identically.

### The scope, per the ruling

1. **The offer read returns WHY the figure is zero.** `discountAvailable`
   (`applications.ts:167-205`) currently returns a bare `number`; the route
   (`src/app/api/receivables/applications/route.ts:37-41`) answers `{ open, discount }`.
2. **Only the operator-fixable case speaks.** `no terms discount` and `window closed` stay **silent** —
   there is genuinely no route out of either, and §5.14 does not ask you to narrate a dead end.
   `would not settle` renders a hint naming the figure that would earn it.
   **There is a fourth case the ruling does not enumerate: the entitlement is spent** (`remaining <= 0`
   after a prior discount, the #81 cap). It has no operator route out either — the discount was already
   taken — so it is **silent too**. Do not invent a fourth message; do note the case in a comment so the
   next reader knows it was considered.
3. **Text-only hint, never a disabled control.** `e2e/flows/receivables-apply-age-statement.mjs:184`
   and `e2e/flows/close-month-end.mjs:338` both assert a row-scoped checkbox count of **0** on their
   partial applies. A text hint keeps them green; a disabled checkbox with a tooltip fails them,
   correctly, and forces a flow rewrite. Take the cheaper shape.

### The wording constraint — this is the part that is easy to get subtly wrong

The natural sentence is the issue's own: *"entering 980.00 instead of 500.00 would earn 20.00."* But
the quantity the server actually tests is **this receipt's unapplied cash**
(`paymentOnAccount`), not the payment's face amount:

```
cashCents >= openCents - cents(eligible)
```

If the receipt has already spent some of its cash on another invoice, "remit 980.00" is **false** as a
statement about the payment amount. The hint must name the cash that has to reach **this invoice**,
and must stay true when the receipt is partly spent elsewhere. Return the two figures from the server
(the settling amount `open − eligible`, and the discount `eligible`) and let the sentence be built
from them; do not have the client re-derive either.

Arm 1's ruling makes the wording **stable**: since a discount is only ever takeable in the settling
call, there is exactly one figure that earns it, always.

### E2E — free coverage, take it

Both flows named above sit on **exactly** this scenario: a check too small to settle a 1,000.00
invoice, inside the discount window, with terms that do offer one. Today they assert the absence of a
checkbox. Have them **also assert the hint text is present**. That turns two flows that currently only
pin #69's negative into positive coverage of arm 2 — and it is the only mechanised check this task can
have, since there is no DOM test environment.

Both flows carry comments claiming the checkbox is *"the ONLY thing rendered in the Discount cell"*
(`receivables-apply-age-statement.mjs:179`, `close-month-end.mjs:334`). Those become false. Update
them — a stale comment that asserts a property the code no longer has is exactly the class this
repo keeps re-filing.

### Also

- Narrow the issue title when picking it up (the owner asked): it is arm 2 only.
- `tests/applications.test.ts:300-440` and `:770-890` are the existing `discountAvailable` suites —
  around twenty call sites assert a bare number. Whatever return shape you choose, those either keep
  compiling or get updated deliberately; do not leave the two styles half-migrated.

---

## Task 3 (THIRD) — #163: a batch nobody proved renders as proved

`balance` is `(controlTotal ?? enteredTotal) − enteredTotal` (`src/server/receipts.ts:130-132`, and
again at `:186-188` for the list row). With no control total that collapses to
`enteredTotal − enteredTotal` = **0.00** — so a batch **checked against nothing** displays exactly
like a batch that **balances perfectly**. The one state that should stand out is rendered as the
reassuring one, on the screen where money is proved.

### The fix

**Make the server type tell the truth**: `balance: number | null`, null meaning *no control total, so
nothing has been proved*. Doing it in the client instead leaves the misleading zero in the API and in
every future consumer. Both read shapes carry it — `BatchDetail` (`receipts.ts:59-62`) and the list
row (`:171-172`).

Then both display sites render the null case **distinctly**:

- `src/app/receivables/batches/[id]/BatchDetail.tsx:629-633` (the header tile)
- `src/app/receivables/ReceivablesList.tsx:164` (the list column)

Constraints on the rendering:

- It must **not** be a numeric `0.00`, and must be distinguishable at a glance from a proved zero.
  The Control total column already renders `—` for null (`ReceivablesList.tsx:162`,
  `BatchDetail.tsx:622`), so `—` alone is consistent but weak here — a dash in the *Balance* column
  reads as "nothing to report", which is the wrong message. Prefer wording that says it is unproved.
- The tile's colour currently keys on `batch.balance === 0` → slate, else amber. **Do not let null
  fall through to the reassuring slate branch by accident**; decide the third state deliberately and
  comment it.

### What NOT to change

- **`postBatch`'s foot check.** `receipts.ts:442-462` (#80) already refuses to post a batch whose
  non-null control total does not match, and a batch with **no** control total posts freely — that is
  the owner's answer to Q18 and is out of scope. This is a *display* defect; the posting rule stands.
- The file-header contract at `receipts.ts:16-19` documents the old definition of `balance`. Update it
  in the same change; it is the record of the thing you are changing.

### Tests

`tests/receipts.test.ts` asserts `balance` at `:67`, `:89`, `:104`, `:115`, `:349`, `:616`, `:754`,
`:757`, and `tests/receivables-routes.test.ts:263` asserts it through the route.
**`receipts.test.ts:754` is the one that matters** — it currently reads

> `expect(newerRow.balance).toBe(0); // no controlTotal — balance foots against enteredTotal itself`

which is the defect written down as an expectation. It must become the assertion that the unproved
case is distinguishable. Add a case pinning that a batch **with** a control total that happens to foot
still reports a real `0`, so the two zeros stay distinguishable in the test suite and not only on
screen.

---

## Task 4 — the documentation that rides with this group

Not a code task; do it last, in one commit, after the three above are green.

### #159's rewording (owner ruling 2026-08-19, option (a) — closed)

The ruling: *"the demonstration dataset's $6,750 of frozen on-account cash in closed 2026-07 is
correct data, not a seeding bug"*, and the office procedure is **allocate on-account cash before the
month closes**; when it does outlive the month, reopening is the sanctioned route.

- `docs/manual/dataset.md:336-343` — the section headed "Prior-month on-account cash can never be
  applied" calls it a *"live operational trap"* and says *"#159 (owner decision pending)"*. Reword to
  describe it as an **intentional demonstration of the period lock**, and record the ruling.
- `docs/manual/dataset.md:205` — "the trap in #159" in passing; same treatment.
- `docs/manual/07-receivables.md:181-203` already states the procedure well ("Clear on-account cash…").
  It only needs the framing corrected: it is filed-and-ruled, not filed-and-pending.
- `docs/manual/08-month-end.md` — the ruling asks for the procedure to appear there too, "as procedure,
  not as a trap". Check whether it already does before adding anything.
- The `applyPayment`/`applyCredit` dating asymmetry (`receivedDate` vs `todayDateOnly()`) is
  **deliberate and stays**. The ruling says anyone reading those two functions side by side will ask —
  so put the answer at the code, in both places.

**`npm run manual:build` after any chapter edit.** It is deterministic (same inputs → same bytes), so
a no-op rebuild is a no-op diff; a figure reference that stops resolving is a loud build error.

### The rest

- `docs/HANDOFF.md` — the group's entry, in the existing format.
- **Spec §15** only if something here amends the contract. #157's retention bound and #155's arm-1
  closure are both owner rulings already recorded in the "Amendments after the manual walkthrough"
  block; check before duplicating.
- `CLAUDE.md` gets an edit **only** if the lock-free period read establishes a convention worth
  stating — a display read that must never become a guard is arguably exactly that. Implementer's
  call, reviewer's to challenge.

---

## Review

One independent `task-reviewer` per task, dispatched with this brief, the implementer's report, and a
review-package diff. Then a whole-branch review before the PR. Per the owner's 2026-08-06 ruling, from
round 6 onward findings are triaged to issues **unless** they are correctness, concurrency, or
data-integrity defects — a non-empty late round is not a reason to hold the merge.

The three things most likely to be got wrong, for the reviewers' attention:

1. **The lock-free period read being usable as a posting guard.** The period lock's STANDING INVARIANT
   is that every posting mutation runs Serializable and takes the month lock; a lock-free sibling in
   the same file is one careless import away from silently breaking it.
2. **The discount hint asserting something false about a partly-spent receipt.**
3. **`balance: null` falling through to a branch that renders it as reassuring** — the same defect in a
   new place, which is how #162 nearly got "fixed" by reordering a template section.

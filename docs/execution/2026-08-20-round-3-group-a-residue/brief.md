# Round 3 Group A residue — "the three near-misses Group A left behind"

**Branch:** `round-3-group-a-residue` off `main` at `d7dbdd6`.
**Closes:** #173, #174, #175.
**Predecessor:** `docs/execution/2026-08-20-round-3-group-a/` (brief, three task reports, ledger).
Read that ledger first — all three of these were *filed by Group A's own reviews*, and each is a
near-miss of something Group A fixed.

## Why these three, now, instead of Group B

They are the cheapest work on the board, they are all in code that was rewritten hours ago, and they
share one file (`src/server/applications.ts`). Landing them as one small branch costs one review
cycle instead of three.

**They are also all the same defect class as Group A itself** — §5.14: *a block must name the route
that actually exists.* Group A fixed three screens that stated something the system did not mean;
these are three places where the fix stopped one step short of its own rule:

| # | Group A fixed | What it stopped short of |
|---|---|---|
| #173 | The void hint names a reopen when a **write-off's** month is closed | A **payment** in a closed month still names a route that refuses you |
| #174 | A settled row with a dead undo drops off the screen | A **still-open** row keeps an enabled Void that always 409s |
| #175 | The **offer read** now knows which of four dead ends applies | The **save refusal** three lines away still says the same three words for all four |

Three tasks, **strictly in sequence** — Tasks 2 and 3 both edit `src/server/applications.ts`.

## Standing constraints for all three tasks

- TDD: failing test → implement → pass → commit. Conventional commits, **no attribution trailer**.
- **All commands run from `erp/`.** A root-cwd `vitest`/`tsc` run collects the wrong files and fails
  confusingly.
- `npm run test:e2e` is mandatory at group close (owner instruction). It needs the dev server and the
  **DEV** database, which is currently PRISTINE — keep it that way, or E2E stops being a clean signal.
- **`npx eslint src tests` does not cover `e2e/`.** `node --check` any flow you touch.
- **No DOM test environment.** A `.tsx` change cannot be unit-tested; say so rather than implying
  coverage that cannot exist, and cover it in Playwright if it is coverable at all.
- **No migration, no audit-registry edit, no new allocating entry point, no new Serializable
  mutation.** None of these three needs one. If you reach for one, stop and report.
- **`closedMonthsForDisplay` is a DISPLAY read and NEVER a guard** (`period-locks.ts`). Two of these
  tasks consume it. Its call sites are pinned by an allowlist in `tests/period-locks.test.ts` — if
  you add a caller you must add it there, deliberately, and it must not gate a write.

---

## Task 1 (FIRST) — #173: the closed-period hint covers write-offs only

`writeOffVoidHintFor` (`src/server/invoice-guards.ts`) scopes its period check to
`LIVE_STANDALONE_WRITE_OFF` — `{ deletedAt: null, type: "WRITE_OFF", paymentId: null }`. That was
the right scope for #157, whose subject was the row on the customer's Receivables section.

But all three refusals — `invoices.ts` (discard), `invoices.ts` (unlock), `orders.ts` (void order) —
fire for **any** live application, and `voidApplicationInTx` guards `assertPeriodOpen(appliedDate)`
for **every** kind. So an operator blocked by a payment dated in a closed month is told to void the
payment, follows that to `BatchDetail`, and meets exactly the wall #157 exists to remove.

### The rule to implement

**Every clause of the sentence must be true of the set of applications actually in scope.** That is
the whole specification, and it is stricter than it sounds:

- The closed-period clause must consider **every live application** blocking the refusal, not only
  standalone write-offs. That is the correctness half.
- The destination clause (*"a bad-debt write-off is voided from the customer's Receivables section"*)
  is true **only** of standalone write-offs. It must not be phrased so it appears to name the
  destination for a payment or a residual write-off, which are voided from their receipt batch.
- When nothing in scope is in a closed month, the sentence must stay **byte-identical to today's**
  for the standalone-write-off case — the existing tests pin it, and the common case must not churn.

**Do not try to name a destination per kind in one sentence.** A mixed set (a payment, a residual
write-off and a standalone write-off, in two different closed months) turns that into something
nobody reads. Name the blocked months and the reopen; keep the write-off destination clause as the
special case it already is. If you find a phrasing that does more without becoming unreadable,
propose it in the report rather than shipping it unflagged.

### Constraints

- **`closedPeriodFor` is the wrong read here** — it takes the month advisory lock. This decides
  WORDING, not whether a write may happen, and taking the lock to phrase an error would serialize the
  refusal against a running close for nothing. Keep using `closedMonthsForDisplay`.
- **`invoice-guards.ts` stays a leaf** — `type Prisma` plus the one `period-locks` import. Its
  allowlist test is now exact; if the import set changes, that test must change deliberately.
- **Do not widen `hasReceivableActivity`.** Its docblock is explicit that it answers a boolean and
  nothing else. The hint is a sibling.
- The hint is computed **on the refusal path only** — inside the `if`, never before it. Verify that
  is still true after your change; a period read on every successful discard/unlock/void is waste.
- Both scopes still needed: per-invoice (`writeOffVoidHint`) and per-order
  (`writeOffVoidHintForOrder`). The per-order scope must stay a subset of
  `hasReceivableActivityForOrder`'s arms, or the hint can speak about rows the guard did not consider.

### Tests

Extend `tests/write-offs.test.ts`'s existing both-branches hint suite. At minimum: a **payment** in a
closed month now produces the reopen clause; the unchanged sentence still appears when everything in
scope is voidable; and at least two of the three call sites are covered.

---

## Task 2 (SECOND) — #174: an enabled Void that always 409s

The customer's Receivables section renders a Void per standalone write-off
(`src/app/customers/[id]/ReceivablesSection.tsx`). `voidApplication` refuses when that write-off's
month is closed. After #157 a *settled* row whose write-offs are all dead drops off the screen — but
a row with **`open > 0`** is retained on its own merits and still shows an **enabled** Void that
always 409s.

It fails with a true message naming the month, so nothing is at risk. The defect is that §5.16's
convention throughout this app is **disabled with the reason, never hidden** — an enabled control
that always fails is the one variant the convention rules out, because it teaches the operator that
the screen's affordances are not to be trusted.

### The shape

The server already computes the fact. `openItemsForCustomer` reads `closedMonthsForDisplay` for every
candidate write-off's `appliedDate` to decide retention; the same map answers "is *this* one still
voidable".

1. Add `voidable: boolean` to `OpenItemWriteOff` (`src/server/applications.ts`), derived from the map
   already in hand. **No extra query** — if you find yourself adding one, you have missed that the
   map is right there.
2. `ReceivablesSection.tsx` renders the control disabled-with-reason when it is false, naming the
   month to reopen — the same month `assertPeriodOpen` would name.

### Constraints

- The **client-side mirror** of the row type in that file must move in step. A `"use client"` file
  must not import from `src/server/**`.
- Follow the page's existing gate idiom (`Gate`/`title`) rather than inventing a second disabled
  style — the control is already disabled for a missing permission, so there are now **two** reasons
  it can be disabled and the tooltip must say which applies.
- The retention rule is unchanged. This task adds a flag and a tooltip; it must not alter which rows
  appear.

### Tests

The server flag is testable and must be RED-verified: a write-off in an open month is `voidable`,
one in a closed month is not, on a row that is retained for its own open balance. **The client half
cannot be unit-tested** — no DOM environment. Say so.

---

## Task 3 (THIRD) — #175: four dead ends, three words

`resolveReason`'s DISCOUNT branch (`src/server/applications.ts`) throws a flat
`"no early-pay discount applies"` whenever `remainingDiscountFor` returns zero — which is three
distinct causes: no terms discount, window closed, entitlement spent. The settlement case already has
a good message and keeps it.

`discountOffer` now distinguishes all four (`DiscountBlock`). The same server, one function later,
throws that knowledge away.

### Constraints — these matter more than the wording

1. **Reuse `DiscountBlock`. Do not invent a third "why is this blocked" shape.** Group A landed two
   precedents one module apart, and they are individually right for different reasons: #157 composes
   a sentence server-side because it phrases an `HttpError`; #155 returns a machine-readable block
   because it feeds UI branching. This task sits on the seam — it is a thrown error (so it composes a
   sentence) answering the *same question about the same invoice* that `discountOffer` answers (so it
   must consume the same type).
2. **Do not duplicate the arithmetic.** `termsBlockFor` states the window/no-terms split once;
   `remainingDiscountFor` states the cap. Consume them. A second copy is exactly how the offer and
   the save drift into disagreeing about one invoice — which is what #69 and #81 were both about, and
   the file already carries a comment (`applications.ts`, above `discountFor`) saying they must agree
   per invoice.
3. **The offer and the save must agree.** Pin it: for one invoice and one payment, the block the
   offer reports and the block the save refuses with are the same. That test is the point of the
   task — the messages are a consequence.
4. `resolveReason` runs inside the claimed transaction on the pre-call snapshot. Keep it pure and
   synchronous; do not make it async or give it a query.

### Tests

`tests/applications.test.ts` has the arm-2 blocker fixtures — mirror them on the save side. Each of
the three now-distinct causes gets its own assertion, and the settlement message stays as it is.

---

## Task 4 — documentation

- `docs/manual/07-receivables.md` carries a **"known rough edge"** note that Group A narrowed to
  cover exactly #175. Task 3 closes it; the note comes out, and the chapter should state what the
  refusal now says. `npm run manual:build` afterwards.
- `docs/HANDOFF.md` — the group entry.
- Spec §15 only if a contract is amended. These are three defect fixes against rules already written;
  check before adding a row.
- **`walkthrough.md`** — check whether any row references these three. Group A's whole-branch review
  caught one stale row there; do not repeat it.

---

## Review

One `task-reviewer` per task, then a whole-branch review. The stop-reviewing ruling applies from
round 6.

The three things most likely to be got wrong:

1. **A hint clause that is true of write-offs but asserted about payments** — #173's entire failure
   mode is a sentence that is true of *some* of what it describes.
2. **A second copy of the discount arithmetic** in Task 3, which would let the offer and the save
   disagree about one invoice — the exact class this repo has already fixed twice.
3. **A tooltip that names the wrong reason** in Task 2, now that the control has two ways to be
   disabled.

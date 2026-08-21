# Task 3 (THIRD) — #175: four dead ends, three words

Implementer report. Branch `round-3-group-a-residue`, on top of Task 1 (#173) and Task 2 (#174).
Files touched: `erp/src/server/applications.ts`, `erp/tests/applications.test.ts`. Nothing else.

---

## 1. What changed, and why

`resolveReason`'s DISCOUNT branch asked `remainingDiscountFor` for a number, got `0`, and threw
`"no early-pay discount applies"` — one sentence for three unrelated causes, three lines away from a
function that already tells all four apart. The fix is not the wording; it is that the offer read and
the save refusal now take the eligible figure **and its blocker** from one composition.

### The composition point — `eligibleDiscountFor` (`src/server/applications.ts:266-277`)

```ts
function eligibleDiscountFor(
  invoice: DiscountingInvoice, receivedDate: Date, apps: ApplicationLite[],
): { amount: number; blockedBy: PreSettlementBlock | null }
```

Pure, synchronous, no query — it takes already-read state, which is what lets `resolveReason` call it
inside the claimed transaction on its pre-call snapshot (constraint 4; `resolveReason` is still
`function`, still not `async`, and still issues nothing).

It is the *lifted* version of what `discountOffer` already did inline at its old `:256-263`:
`termsBlockFor` first, then `remainingDiscountFor`, with a zero inside an open window meaning
`entitlement_spent`. Two supporting types beside it: `PreSettlementBlock`
(`Exclude<DiscountBlock, "would_not_settle">`, `:238`) and `DiscountingInvoice` (`:242-245`, the
frozen-terms columns plus `invoiceDate`/`total` — a shape both the offer's own `select` and
`INVOICE_CLAIM_SELECT` already satisfy, so neither read had to widen).

### The message table — `discountBlockMessage` (`:301-326`)

One `switch` over the four `DiscountBlock` values, exhaustive, returning the sentence. The
`invoice-guards.ts:90` `invoiceBlockMessage` precedent: compose beside the rule, not at each throw
site.

### The two consumers

- `discountOffer` (`:348-349`) — thirteen lines became two. Behaviour bit-identical (the seven
  `#155` arm-2 offer tests are untouched and green).
- `resolveReason` (`:940-951`) — `blockedBy !== null` throws `discountBlockMessage(blockedBy,
  settlement)`; the settlement check below it now throws
  `discountBlockMessage("would_not_settle", settlement)` instead of composing its sentence inline.

Docblocks updated where they were about to become wrong: the §4.3 header's "they must agree PER
INVOICE" clause (`:78-84`) now says they must agree about **why** as well as how much, and
`DiscountBlock`'s docblock (`:202-208`) records that screen-silence is not refusal-silence.

---

## 2. How `DiscountBlock` is consumed, and why that is not a third shape

The owner's comment on #175 put this task on the seam between two precedents: #157 composes a
sentence server-side because it phrases an `HttpError`; #155 arm 2 returns a machine-readable block
because it feeds UI branching.

**`DiscountBlock` is the discriminant on both sides; the sentence is a pure function of it.**

- No new union, no new record, no widened `DiscountOffer`, no new field on `HttpError`.
  `eligibleDiscountFor` returns a `PreSettlementBlock`, which is `DiscountBlock` minus one member —
  derived from it with `Exclude`, so adding a fifth blocker cannot leave this behind: the `switch` in
  `discountBlockMessage` stops compiling and the offer's own branch stops compiling with it.
- `blockedOffer(blockedBy)` (the offer) and `discountBlockMessage(blockedBy, settlement)` (the save)
  are two renderings of **the same value**, not two derivations of the same question.
- The one place the two sides genuinely differ — `would_not_settle` — is a difference in the *test*,
  not in the shape, and is documented at `:259-264`: the offer asks whether this receipt's unapplied
  cash **could** settle (feasibility, before anything is typed), the save whether the payload
  **exactly does** (exactness, after). Both name the same blocker. `eligibleDiscountFor` deliberately
  does not decide it, because it holds no cash figure.

The alternative I rejected: threading the block onto `HttpError`. `errors.ts` is a zero-import leaf by
deliberate design and a new field there would ripple through every catch site for one caller's
benefit.

---

## 3. Proof there is no second copy of the arithmetic

One definition and its complete caller list, by grep (`grep -n` over
`src/server/applications.ts`; nothing outside this file references any of them — they are all
module-private except `discountBlockMessage`):

| Decision | Single source | Every caller |
|---|---|---|
| window (`invoiceDate + discountDays` vs `receivedDate`) | `termsBlockFor` `:122-128` | `discountFor:137`, `eligibleDiscountFor:270` |
| no-terms (`discountPercent`/`discountDays` null pair) | `termsBlockFor` `:123` (same arm) | as above |
| the cap (entitlement − consumed, floored to the per-call offer) | `remainingDiscountFor` `:169-181` | `eligibleDiscountFor:272` — **the only one** |
| the frozen #79 pair | `issuedTerms` `:111-115` | `eligibleDiscountFor:269` — **the only one** |
| the composition of all of the above | `eligibleDiscountFor` `:266` | `discountOffer:348`, `resolveReason:940` — the two that must agree |

Supporting greps:

- `addDays(` appears **twice** in the file: `:126` (the deadline, inside `termsBlockFor`) and `:586`
  (an unrelated aging bound). The deadline arithmetic exists once.
- `remainingDiscountFor` and `issuedTerms` each went from two call sites to **one**. The save no
  longer reaches past `eligibleDiscountFor` for either, so the two sides cannot be edited apart.
- The old flat string is gone from `src/`, `tests/` and `e2e/` — the single surviving hit is a test
  comment that names it as the message this branch threw **until** #175
  (`tests/applications.test.ts:717`).

---

## 4. The four messages

| Block | Exact message |
|---|---|
| `no_terms_discount` | `this invoice was issued under terms that carry no early-pay discount` |
| `window_closed` | `this payment is dated after the invoice's early-pay discount window` |
| `entitlement_spent` | `this invoice has no early-pay discount left to take` |
| `would_not_settle` | `an early-pay discount is earned only by a payment that settles the invoice — this covers {covered} of the {open} open` |

**The settlement message is unchanged — byte for byte, em dash included.** It was moved from the
throw site into `discountBlockMessage:323-325` verbatim; the string literal and the template are the
same characters in the same order. Pinned independently at
`tests/applications.test.ts:1176` (see §6, perturbation C, which is the case that proves the
byte-exact test earns its place).

Two wording notes:

- **`entitlement_spent` says "left to take", not "already taken".** `remainingDiscountFor` returns
  zero for two states: the entitlement is spent (#81's cap after a void), and — degenerately — an
  open balance too small for the percentage to round to a cent. "Already taken" would be false in the
  second. Commented at `:273-275`.
- **`window_closed` deliberately names no date.** Naming the deadline would need
  `addDays(invoiceDate, discountDays)` a second time, or a widened `termsBlockFor` return, and it
  would need `discountBlockMessage` to take figures that `DiscountBlock` does not carry — the first
  breaks constraint 2, the second is the start of a third shape. Flagged in §8 because
  `docs/manual/dataset.md:373` explicitly wishes for the figures; it is the reviewer's call, not one
  I should make silently.

---

## 5. The offer-and-save-agree test

`tests/applications.test.ts:1062-1188` — a four-case table, one `it` each, so a failure names the
blocker.

```ts
const offer = await asSystem(() => discountOffer(f.paymentId, f.invoiceId));
expect(offer.blockedBy).toBe(c.block);
...
}))).rejects.toMatchObject({
  status: 400,
  message: discountBlockMessage(offer.blockedBy!, { coveredCents: f.coveredCents, openCents: f.openCents }),
});
```

The load-bearing detail: the expectation is composed from **`offer.blockedBy`**, not from `c.block`.
A save that resolved some other blocker fails even though the sentence it threw is a real one from
the same table. Each case also asserts the live application count is unchanged across the refusal
(the whole call rolls back, in all four).

| Case | Fixture | Forced line |
|---|---|---|
| `no_terms_discount` | terms `(null, null)`, invoice 1000 @ 08-08, receipt 1000 @ 08-08 | DISCOUNT 20 |
| `window_closed` | terms 2/10, invoice @ 08-08, receipt **1000** @ 08-28 — big enough to settle outright, so only the date is wrong | DISCOUNT 20 |
| `entitlement_spent` | terms 2/10; pay 980 + discount 20; **void the payment** — 980 open again with the 20 given away | DISCOUNT 19.6 (2% of 980: the window and the open balance both allow it, so only the spent entitlement refuses) |
| `would_not_settle` | terms 2/10, invoice 1000, receipt **500** | DISCOUNT 20 |

The fourth is included precisely because its two sides are not the same test (feasibility vs
exactness) — agreement there is a claim worth checking rather than a tautology.

---

## 6. Every test added or changed, and which were RED-verified

### Changed — the three assertions that pinned the flat message

Each already sat on the right fixture for one of the three causes, so each became an exact-string
assertion for that cause's new sentence:

| Line | Test | Now pins |
|---|---|---|
| `:440` | `refuses to APPLY a discount the issued terms never offered … (#79)` | `no_terms_discount` (was a loose `/no early-pay discount applies/i`; now `toMatchObject` on the exact string, so it pins the branch as well as the refusal) |
| `:673` | `refuses a DISCOUNT line outside the window` | `window_closed` |
| `:934` | `refuses a SECOND discount request once the entitlement is spent` | `entitlement_spent` |

**RED-verified as a genuine failing-test-first step:** written before the implementation, run,
**3 failed / 67 passed**, each on the message and nothing else.

### Added

| Line | Test | RED-verified |
|---|---|---|
| `:1146` | agreement — `no_terms_discount` | see note below |
| `:1146` | agreement — `window_closed` | **A** |
| `:1146` | agreement — `entitlement_spent` | **A** |
| `:1146` | agreement — `would_not_settle` | **B** |
| `:1176` | `leaves #69's settlement sentence exactly as it was (#175)` | **B**, **C** |

(The four agreement cases are one `it` at `:1146` inside a `for` over the table at `:1082`.)

RED verification is by perturbing the implementation and re-running, since these tests import a
symbol that does not exist before the change. Each perturbation was applied to a byte-for-byte
backup copy, run, and reverted; the suite is green from the restored file.

- **Perturbation A** — `resolveReason`'s blocked throw hard-coded to
  `discountBlockMessage("no_terms_discount", settlement)`, i.e. the save resolves a *different*
  blocker from the offer. **4 failed**: the `window_closed` and `entitlement_spent` agreement cases,
  plus the two cause-specific message tests. The `no_terms_discount` agreement case passes — the
  perturbation happens to be correct for it — which is stated honestly here rather than papered over;
  that case's cover comes from the exact-string test at `:440` failing under any other wording.
- **Perturbation B** — the settlement throw changed to
  `discountBlockMessage("entitlement_spent", settlement)`. **7 failed**: the `would_not_settle`
  agreement case, the byte-exact settlement test, and the five pre-existing `#69` settlement tests.
- **Perturbation C** — the settlement sentence re-worded from `… settles the invoice — this covers`
  to `… settles the invoice, and this covers`. **1 failed: only the byte-exact test.** Every
  pre-existing settlement assertion is a regex on a substring the re-wording preserved, and the
  agreement test composes its expectation from the implementation, so both agreed with each other on
  the wrong string. This is the case that justifies the byte-exact test existing at all, and it is
  the mechanical proof that the settlement sentence is unchanged.

### Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint src tests` | pass |
| `vitest run tests/applications.test.ts tests/applications-routes.test.ts tests/receivables-routes.test.ts tests/write-offs.test.ts` | **199 passed** |
| `vitest run` (full suite, `erp_test_r2`) | **204 files, 3504 passed** |

`npm run test:e2e` not run, per instruction (group owner runs it at close). No migration, no audit
registry edit, no new allocating entry point, no new Serializable mutation, no new query, no new
`closedMonthsForDisplay` caller.

---

## 7. What I could not verify mechanically

- **That the new sentences read well to an operator.** They are true and they discriminate, which is
  testable; whether "this invoice has no early-pay discount left to take" is the clearest phrasing of
  the entitlement case is a judgement call the reviewer or the owner should make.
- **No UI covers this.** The refusal surfaces wherever `POST /api/receivables/applications` errors
  are rendered (`BatchDetail.tsx`), which passes the server's message through untouched — nothing
  there needed changing, and nothing there can be unit-tested (no DOM environment). Unchanged by this
  task either way: the failure mode being fixed was the *string*, not the plumbing.
- **The full suite was run while `invoice-guards.ts` and `write-offs.test.ts` were being edited
  concurrently** by the group owner. It was green, but that green includes whatever those two files
  were at 17:28; it is not a statement about their finished state.

---

## 8. Adjacent things noticed and NOT fixed

1. **Three doc passages are now false, and only two of them are on Task 4's list.** My file scope was
   `applications.ts` + its test, and the brief gives the manual to Task 4 — so I have changed none of
   them, but they must not be missed:
   - `docs/manual/07-receivables.md:161-167` — the **"known rough edge"** blockquote. Task 4 names it.
     It says the refusal "is still the same three words". It should now state that the refusal names
     the cause, and the four sentences are in §4 above.
   - `docs/manual/walkthrough.md:115-117` — rough-edge row 2, `"no early-pay discount applies" covers
     three distinct causes`. Task 4 is told to check `walkthrough.md`; this is the row.
   - `docs/manual/dataset.md:370-374` — the same observation, at more length, **and the brief does not
     mention `dataset.md` at all.** This is the one most likely to be missed. It also proposes the
     richer wording ("payment received 37 days after the invoice date; the discount window is 10
     days") — see §4's second wording note; that is deliberately not what shipped.
   - `docs/manual/manual.html:697` carries the 07-receivables blockquote and regenerates from it via
     `npm run manual:build`.
2. **`discountFor`'s redundant `percent == null` guard** (`:134-137`) is now the only place that
   reaches `termsBlockFor` other than the new composition, and it exists solely to narrow the type
   across a call. Harmless and already commented; noted because a reader chasing "who else asks the
   window question" will land on it.
3. **`resolveReason` recomputes `eligibleDiscountFor` once per DISCOUNT line** for the same invoice,
   as `remainingDiscountFor` did before it — unchanged behaviour, correct (the pre-call snapshot does
   not move within the loop), and the aggregate is carried separately in `discountSoFarCents`. Not a
   defect, but it is now one call instead of two so it is more visible.

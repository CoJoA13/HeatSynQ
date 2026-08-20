# Task 1 (SECOND) — #155 arm 2: the hidden discount offer names its route out

Implementer report. Branch `round-3-group-a`, commit `11c2ca7`, on top of Task 2 (#157), Task 3
(#163) and the #159 doc commit.

---

## 1. What changed, and why

### The offer read returns WHY it is zero

`erp/src/server/applications.ts`

- **`termsBlockFor` (`:120-127`)** — new pure helper returning `"no_terms_discount" |
  "window_closed" | null`. It exists because `discountFor` collapsed both terms-side blockers to a
  bare `0` and the offer now has to tell them apart. `discountFor` (`:130-137`) was rewritten to
  **delegate its two zero-guards to it** rather than keep a second copy of the deadline arithmetic —
  a duplicated `addDays` comparison is exactly how the offer and the save drift. The behaviour is
  bit-identical; the only oddity is the `percent == null` guard at `:135`, which is redundant with
  the helper's own `no_terms_discount` arm and is present solely to narrow the type (TypeScript
  cannot carry a narrowing across a call). Commented as such.
- **`DiscountBlock` / `DiscountOffer` (`:180-223`)** — the four-way blocker union and the record.
  The long docblock at `:180-200` states, per blocker, why three of them are silent.
- **`blockedOffer` (`:225-226`)** — one constructor for the "zero, and here is why" shape, so a new
  blocker cannot accidentally ship with a stray figure attached.
- **`discountOffer` (`:228-285`)**, replacing `discountAvailable`:
  - `:256-257` — terms blockers first, before any balance arithmetic.
  - `:263` — `remainingDiscountFor` unchanged, still the source of `eligible`; `eligible <= 0`
    inside an open window is `entitlement_spent`.
  - `:282-284` — the settlement test, now keeping `settlingCents` so the blocked branch can name it.

`erp/src/app/api/receivables/applications/route.ts:20-41` — `discount` is now the `DiscountOffer`
record rather than a number, nested (`{ open, discount: {…} }`) rather than flattened, so `open` and
`amount` cannot be confused in the JSON. Docblock updated to say so.

### The screen

`erp/src/app/receivables/batches/[id]/BatchDetail.tsx`

- `:107-113` — `DiscountOfferView`, the client-side mirror of the server type (a client component
  may not import from `src/server/**`). It deliberately omits the four-way blocker union: the two
  figures are non-null **exactly** for `would_not_settle`, so the cell branches on their presence
  and there is no second copy of the union to keep in step by hand.
- `:115-134` — `ApplyLineFields` gains `discountSettlingAmount` / `discountWouldEarn` (empty string
  = absent, since `useBulkGrid` fields are strings). Neither is ever edited, so `compose` always
  serves server truth for them.
- `:340-371` — the cell is now a three-way render, with the reasoning block above it. Text, never a
  disabled control.

### Arm 1's comment (the small piece of work arm 1 still carried)

`erp/src/server/applications.ts:271-279`, sited exactly where `remainingDiscountFor`'s output and
the settlement feasibility test meet. It states the empty-set argument: a `DISCOUNT`-only call
brings no cash, so the test reduces to `eligible ≥ open`; `eligible ≤ percent × open < open` for
every percentage below 100; therefore a discount can never settle an invoice on its own, at any
terms this shop writes. **Nothing else about arm 1 was touched** — not the eligible basis, not
`remainingDiscountFor`, and not the test named `leaves the entitlement cap — not the settlement
guard — refusing the two-step discount` (`tests/applications.test.ts:807`), whose body is unchanged
apart from the mechanical call-site migration below.

---

## 2. The return-shape decision, and the ~20 existing call sites

**Decision: rename and widen.** `discountAvailable(): Promise<number>` became
`discountOffer(): Promise<DiscountOffer>`. There is now **one** style; nothing is half-migrated.

Two alternatives were considered and rejected:

- *Add `discountOffer` beside `discountAvailable`.* The route would use the new one and the old one
  would survive as an export **no production code calls** — a function kept alive only by its tests.
  That is the "two styles" state the brief forbids, wearing a different hat.
- *Keep the name, widen the type.* `discountAvailable` returning a record reads wrong at every call
  site (`.amount` on a thing called "available"), and `invoiceOpenBalanceById`'s docblock already
  used the name to mean "a number".

The rename is a compile-time forcing function: every one of the call sites breaks loudly, so none
can be missed. `npx tsc --noEmit` is clean.

**All 20 call sites in `tests/applications.test.ts` were migrated**, mechanically and identically:

```
expect(await asSystem(() => discountAvailable(a, b))).toBe(X)
expect((await asSystem(() => discountOffer(a, b))).amount).toBe(X)
```

No assertion changed meaning, no test lost strength, and no helper was introduced to hide the new
shape (a `discountAmount()` wrapper was considered and dropped — it would have concealed exactly the
thing a reviewer needs to see). The `describe` title and two prose comments naming the old function
were renamed with it. `grep discountAvailable erp/src erp/tests erp/e2e` now returns only
`BatchDetail.tsx`'s own **grid field name** for the amount (`:117`, `:129`, `:205`, `:325`, `:353`,
`:358`), which is client-side vocabulary and unrelated.

---

## 3. The hint sentence, and why it stays true for a partly-spent receipt

Rendered in two lines (`BatchDetail.tsx:362-369`):

> Not enough cash left on this receipt to settle.
> Applying 980.00 here would earn 20.00.

The second line is built from **one template literal**, not interleaved JSX text and expressions —
it is asserted verbatim by two E2E flows, and an exact-text assertion should not rest on JSX's
line-joining rules.

### The arithmetic

The server's guard is `cashCents >= openCents − cents(eligible)`, where `cash` is
`paymentOnAccount(payment.amount, live PAYMENT applications)` — **this receipt's unapplied cash**,
not its face amount. So the figure the operator needs is `settlingAmount = open − eligible`, and
what it earns is `wouldEarn = eligible`.

Take the case the brief warns about. A 1,000.00 receipt, 300.00 of it already applied to another
invoice; this invoice open at 1,000.00, terms 2/10 inside the window:

```
eligible        = 2% × 1,000.00            =    20.00
settlingAmount  = 1,000.00 − 20.00         =   980.00
unapplied cash  = 1,000.00 − 300.00        =   700.00
guard           = 700.00 ≥ 980.00          =   false   -> would_not_settle
```

- *"Remit 980.00 to earn 20.00"* is **false** here. This receipt's face amount already **is**
  1,000.00 — above 980.00 — and it is still refused. To leave 980.00 unapplied the customer would
  have had to remit **1,280.00**, a figure the sentence never mentions and the server never
  computes.
- *"Applying 980.00 here would earn 20.00"* is **true** here, and in every other case. It is a
  conditional about what reaches **this invoice**, and it makes no claim about what the receipt
  currently has or what its face amount was. If 980.00 does reach this invoice, the guard passes
  (`980.00 ≥ 980.00`), the save's exactness test passes (`980.00 + 20.00 = 1,000.00 = open`), and
  20.00 is earned. The first line carries the part the second deliberately does not — that this
  receipt cannot currently supply it.

`tests/applications.test.ts:488-509` pins exactly this, including the discrepancy the sentence has
to survive: `expect(payment.amount.toNumber()).toBeGreaterThan(Number(offer.settlingAmount))` while
the offer is still blocked. It then voids the 500.00 spent elsewhere and asserts the offer appears
at exactly the promised 20.00 — so 980.00 is proved to be the real threshold, not a decorative
number.

The figures come from the server for this reason and are **never** re-derived on the client: the
grid knows neither the entitlement cap nor the receipt's unapplied cash. `DiscountOffer`'s docblock
(`applications.ts:206-222`) records the argument at the code.

Arm 1's closure is what makes this a single stable sentence: a discount is only ever takeable in the
settling call, so there is exactly one figure that earns it.

---

## 4. Which blockers speak, and why the silent ones have no route out

| Blocker | Speaks? | Why |
|---|---|---|
| `would_not_settle` | **yes** | The only operator-fixable one. More cash reaching this invoice turns the block into an offer, and the hint names how much and what for. |
| `no_terms_discount` | no | The invoice was **issued** under terms carrying none, and #79 froze that pair onto the paper. Nothing done to this receipt changes what the customer was promised in writing; there is no action to name. |
| `window_closed` | no | The remittance date is the **customer's**, not the operator's. The only "route out" would be back-dating a receipt, which is not a route this manual will ever print. |
| `entitlement_spent` | no | The fourth case, which the ruling does not enumerate. `remainingDiscountFor` has nothing left inside an open window — in practice the #81 cap (the discount was already taken and a void reopened the invoice); degenerately also an invoice with too little still open for the percentage to round to a cent. The money was already given away, or there is none left to give. No message of its own, per the brief; the case is documented at `applications.ts:191-197`. |

All four are **named on the server** even though three are silent — a read that answers "zero, and I
cannot tell you why" is the defect being fixed, not a shape worth preserving one level down. Each
silent blocker carries `settlingAmount: null` and `wouldEarn: null`, which is mechanically what
keeps the cell empty, and each has its own test.

One ordering note worth a reviewer's eye: `entitlement_spent` is checked **before** the settlement
test (`:263` vs `:283`). That is deliberate and is asserted at `tests/applications.test.ts:549-568`
— in that fixture the settlement test *would* pass, so the wrong order would tell an operator to
remit more cash for a discount that no longer exists.

---

## 5. Tests

### Added — `erp/tests/applications.test.ts`, eight cases, all in the `discountOffer` suite

| Line | Case | RED-verified |
|---|---|---|
| `:446` | carries no blocker when it has a figure to offer | via perturbation B |
| `:455` | names the settling figure and what it earns when the receipt is too small | **A** |
| `:467` | names the figure one cent short of settling | **A** |
| `:488` | names a figure that stays true for a receipt already part-spent elsewhere | **A** |
| `:511` | names the REMAINING open balance's figure, not the original total's | **A** |
| `:529` | blames the issued terms, silently | via perturbation B (passes both ways — see below) |
| `:538` | blames the closed window, silently | **B** |
| `:549` | blames the spent entitlement, silently, after a void reopens the invoice | **B** |

**RED verification was done by perturbing the implementation and re-running**, since the rename
makes a pre-implementation run fail on the import rather than on the assertion:

- **Perturbation A** — `settlingAmount: settlingCents / 100` → `openCents / 100` (i.e. the hint
  names the whole open balance, "remit 1,000.00"). **4 failed, 4 passed**; the four figure tests
  caught it, each on the exact number (e.g. `490` vs `500` at `:521`).
- **Perturbation B** — `blockedOffer(termsBlock)` → `blockedOffer("no_terms_discount")` **and**
  `blockedOffer("entitlement_spent")` → `blockedOffer("would_not_settle")`. **2 failed, 6 passed**:
  the `window_closed` and `entitlement_spent` cases. Note honestly that `:529` still passed under
  this perturbation — hard-coding `"no_terms_discount"` is precisely what that test expects — so its
  RED cover comes from A/B only indirectly; it is pinned by `:538` failing on the same line.

Both perturbations were reverted from a byte-for-byte backup and the suite re-run green.

### E2E — two assertions in each of two flows

`erp/e2e/flows/receivables-apply-age-statement.mjs` and `erp/e2e/flows/close-month-end.mjs`.

1. **#155 arm 2** (`:198` and `:350`) —
   `invoiceCandidateRow.getByText("Applying 980.00 here would earn 20.00.", { exact: true })`,
   row-scoped, beside each flow's existing checkbox-count-of-0 assertion. Both flows sit on exactly
   this scenario: a 1,000.00 invoice at 2/10 inside the window, met by a 700.00 / 600.00 check, so
   `eligible = 20.00` and `settlingAmount = 980.00` in both. Nothing has been applied from either
   receipt at that point, so the unapplied cash is the full face amount.
   The stale comments claiming the checkbox is "the ONLY thing rendered in the Discount cell" were
   rewritten in both files; `grep` confirms no such claim survives anywhere in `e2e/`.
2. **#163, carried from Task 3** (`:139` and `:314`) —
   `page.getByText("Not proved — no control total", { exact: true })`, immediately before
   `shot("batch-created")`. The string was read out of
   `BatchDetail.tsx:691` rather than pasted from the brief; it matches, em dash included. Both flows
   create their batch by filling only **Deposit date**, so both genuinely sit in the unproved state
   at that point.

`node --check` passes on both flow files. (`npx eslint src tests` does not cover `e2e/`.)

### Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint src tests` | pass |
| `node --check e2e/flows/receivables-apply-age-statement.mjs` | pass |
| `node --check e2e/flows/close-month-end.mjs` | pass |
| `vitest run tests/applications.test.ts tests/receivables-routes.test.ts tests/write-offs.test.ts` (scratch DB `erp_test_a3`) | **156 passed** |
| `npm run manual:build` | pass, deterministic |

`npm run test:e2e` **not run**, per instruction.

---

## 6. What I could not verify mechanically

- **The rendering itself.** There is no DOM test environment in this repo, so nothing below
  Playwright observes `BatchDetail.tsx`. The three-way cell, the empty-string sentinel, the
  `? … : … && …` shape and the exact DOM text are covered **only** by the two E2E assertions above,
  which I did not run (the group owner runs `test:e2e` at close).
- **Two specific E2E risks, stated so they can be watched for on that run:**
  1. The hint text depends on JSX producing exactly `Applying 980.00 here would earn 20.00.` I
     removed the main hazard by emitting it as a single template literal inside one `<span>`, whose
     only siblings are whitespace-with-newline JSXText nodes (dropped by the compiler). I am
     confident, but it is unrun.
  2. `getByText(..., { exact: true })` matches on an element's normalized text content. The
     enclosing `<div>`'s text is the two sentences concatenated, which does **not** equal the
     assertion string, so there should be no strict-mode ambiguity — again, unrun.
- **The `?paymentId=&invoiceId=` route's new JSON shape** has no route-level test;
  `tests/receivables-routes.test.ts` has never covered that GET (verified: it contains no
  `applications` reference at all). The shape is typed end-to-end by `tsc`, and the service beneath
  it is fully covered, but nothing asserts the wire format. Flagged rather than fixed, since adding
  a route suite was not in scope.

---

## 7. Files touched beyond the brief's list, and why

- **`docs/manual/07-receivables.md`** + **`docs/manual/manual.html`**. Not on my file list, so:
  flagging it explicitly. The chapter's line "When the discount does not apply, the checkbox simply
  is not offered" became **false** on a screen I changed, and CLAUDE.md makes the doc update part of
  the work; Task 2's own commit set the precedent on this branch by editing the same chapter. Two
  edits: the paragraph now shows the hint and explains that its figure is what must reach *this
  invoice* rather than what the cheque must be worth; and the **"known rough edge"** note — which
  cited #155 as pending — was narrowed to what actually remains after this task (the *refusal*
  message on a forced apply is still the same three undifferentiated words; that wording was **not**
  part of the ruling) and now records arm 2 as ruled and done. `npm run manual:build` re-run; the
  diff is confined to that chapter's region (9 lines in `manual.html`).

## 8. Adjacent things noticed and not fixed

1. **The refusal message on the save side is still undifferentiated.** Forcing a discount through
   `applyPayment` returns the same `no early-pay discount applies` whether the window closed, the
   terms carry none, or the entitlement is spent — the server now knows exactly which, three lines
   away in `discountOffer`, but `resolveReason` does not ask. The owner's ruling scoped arm 2 to the
   **offer read and the display**, so I left it; it is now the only part of the manual's "rough
   edge" note that is still true. Worth its own issue.
2. **Spec §15's arm-2 row** (`docs/superpowers/specs/2026-07-29-heat-treat-erp-design.md:325`)
   describes the defect using the issue's original phrasing, *"remitting 980.00 instead of 500.00
   would earn 20.00"* — the sentence the brief correctly identifies as false for a partly-spent
   receipt. The row's actual contract clause ("the operator-fixable case renders a hint naming the
   settling figure") is satisfied exactly, so I did not amend the row; but a future reader could
   take the illustrative half as the required wording. Task 4's call.
3. **The group's progress ledger** (`docs/execution/2026-08-20-round-3-group-a/progress.md`) still
   marks all four tasks "not started"; Tasks 2 and 3 did not update it either. Left alone — it reads
   like the group owner's file.
4. **`docs/HANDOFF.md`** not touched, matching Tasks 2 and 3 and the brief's Task 4, which owns the
   group's entry.

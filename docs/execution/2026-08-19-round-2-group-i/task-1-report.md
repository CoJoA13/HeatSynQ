# Task 1 — #69 + #8 — implementer report

Branch `group-i-ready-issues`. Two commits, one per issue, plus this report.

| | |
|---|---|
| `5bfe003` | `fix(roles): read the delete reason through reasonFromBody, and correct the docs that said role-delete was unbuilt (#8)` |
| `bed28b6` | `feat(receivables): the early-pay discount is earned only by a payment that settles the invoice (#69)` |

Gates, all from `erp/` on a per-task scratch DB (`erp_scratch_i1`, created + migrated, dropped at
the end), with the override that actually works (`DATABASE_URL_TEST=…`, not `DATABASE_URL`):

| Gate | Result |
|---|---|
| `npm test` | **3407 passed / 203 files**, 0 failed |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npx eslint e2e` (extra, not a required gate) | one **pre-existing** warning in `cert-results-print.mjs`, a file this task did not touch; verified pre-existing by stashing |
| `npm run test:e2e` | **not run** — group-level by brief. **Two flows were edited and are owed a run** (see "What the reviewer should probe") |

---

## #8 — closed as already satisfied, with the pin

Recon's finding held at HEAD: `deleteRole` has required a trimmed reason in the SERVICE since
`47d6d0a` (2026-08-01), `tests/roles.test.ts:85-93` pins it, and the admin page prompts. Nothing of
that was re-implemented. What was actually broken was the route's body read.

**`erp/src/app/api/admin/roles/[id]/route.ts`** — the hand-rolled
`(await req.json().catch(() => ({}))) as { reason?: unknown }` + `typeof body.reason === "string"`
is now `reasonFromBody(await req.json().catch(() => null))`, imported from `@/server/http` (the shape
14 other routes use; note the `null` sentinel, not `{}`). The stale comment claiming it "Mirrors
deleteCustomer's route" — untrue since customers moved to `reasonFromBody` — now points at
`reasonFromBody`'s own docblock, which is where the reasoning lives.

**NEW `erp/tests/roles-routes.test.ts`** (4 tests), cloned from `tests/customer-routes.test.ts:58-77`:

- **RED first, verified**: `DELETE` with `body: "null"` and a JSON content-type threw
  `TypeError: Cannot read properties of null (reading 'reason')` out of the handler at
  `route.ts:26` — a 500 where every sibling route answers 400. Now 400 with `/reason/i`.
- The happy path: a real reason → 200, the role gone from `listRoles()`, **and the reason on the
  audit entry** (the point of collecting it — a 200 that dropped the text would pass a weaker test).
- The no-body pin (400), so the `catch(() => null)` swap cannot silently regress.
- A whitespace-only reason (400, role survives) and the 401/403 pair.

Route handler tests pass ctx throughout: `del(request, { params: Promise.resolve({ id }) })`.

**Docs.** `docs/HANDOFF.md` §5.17's "(still to build)" corrected, citing `roles.ts:54-70` +
`47d6d0a` and recording that the issue was ruled against the stale text. The main spec §15 role row
gained "(built)" with the same citation.

---

## #69 — the settlement guard

Owner ruling 2026-08-19: **a discount is earned only by a payment that SETTLES the invoice**;
a partial inside the window earns nothing. Implemented as a guard, not a basis change — the eligible
figure is still `discountPercent × open balance`, untouched.

**`discountAvailable` (the offer).** Now also reads the payment's `amount` and its live applications,
derives the unapplied cash through `ar-balances.paymentOnAccount` (the existing definition, not a new
sum), and returns the eligible figure only when `cashCents >= openCents - eligibleCents`; otherwise
0. `issuedTerms` remains the only percentage source — no fallback to the live customer relation was
added anywhere. Integer cents on both sides of the comparison.

**`applyPayment`/`resolveReason` (the save).** A DISCOUNT is refused unless this payload's
`PAYMENT + DISCOUNT` cents for that invoice **equal** its pre-call open balance, with a message that
names the rule and both figures:

> `an early-pay discount is earned only by a payment that settles the invoice — this covers 520 of the 1000 open`

**The load-bearing pre-aggregation.** Two maps are built from `data.lines` *before* the sequential
loop: `openAtCallCents` (each invoice's open balance at call start) and `settlingCents` (its
`PAYMENT + DISCOUNT` total). Deriving cash inside the loop would make the verdict depend on payload
ORDER — pinned by a test that sends `[DISCOUNT, PAYMENT]` and expects it to succeed. The DISCOUNT
total is aggregated for the same reason one level down: a split entitlement (`980 + 12 + 8`) must not
be refused at its first discount line for "leaving 8.00 open", which is what a per-line reading would
do. The existing cross-invoice `paymentLinesCents` accumulator was left alone, as instructed.

**Check order inside the DISCOUNT branch** is deliberate: window/entitlement (`elig <= 0` →
"no early-pay discount applies") **first**, then settlement, then the #81 aggregate cap. A genuine
terms or window problem therefore still reports itself as one instead of as a settlement problem —
and it is what keeps `tests/applications.test.ts`'s pinned `"no early-pay discount applies"`
assertions pointed at the rule they were written for.

**Tests** — `tests/applications.test.ts`, 62 in the file, 8 of them RED before the implementation:

- `discountAvailable`: no offer when the cash cannot settle; the offer at exactly `open − eligible`;
  **one cent short → 0** (the boundary); the offer on the REMAINDER after an earlier part payment
  (the half of the ruling that is easy to lose); and only UNAPPLIED cash counting (cash spent on
  invoice A stops settling invoice B).
- `applyPayment`: a non-settling DISCOUNT refused; a DISCOUNT riding a partial refused with the whole
  call rolled back; the payload-order test; the WRITE_OFF exclusion; and one invoice's cash not
  settling another's discount.
- Every pre-existing test that took a discount on a partial was converted to a settling payload with
  the *same* rule under test — the cap tests now carry the cash that makes the CAP (not the new
  guard) the refusal, with their messages pinned so a future reader can tell which rule fired.
- The pinned full-payment test (`980 + 20 → open 0`) is untouched and green.

**Docs.** 5B design spec §5.2's "the amount being settled" bullet rewritten (rule, ruling date, both
read sites, the write-off exclusion); the demo doc's §2 open question closed with a RULED block; and
the main spec §15 row — see the deviation below.

---

## Deviations, and why

1. **I corrected the main spec §15 row for #69, which the brief did not ask for.** That row still
   carried the *superseded* first ruling ("the AMOUNT BEING PAID … only the base changes") — the one
   the brief's own recon section says was put to the owner wrongly and re-ruled. Shipping this code
   against a binding decision log that states the opposite policy was not a defensible thing to
   leave, so the row now states the settlement ruling, records that it supersedes the same day's
   first answer and why, and names the consequence. **`docs/HANDOFF.md`'s line-3 rolling paragraph
   still carries the superseded wording** ("#69 ruled — the early-pay discount basis is the AMOUNT
   BEING PAID"); I deliberately did not touch it, because that paragraph is rewritten by the
   controller at every group close-out and three implementers editing it would collide. **It needs
   the controller's correction at close-out.**

2. **A WRITE_OFF does not count toward settling.** The brief gives the formula as
   `cash + discount == open` while its headline says "the invoice lands at EXACTLY zero"; the two
   differ only when a write-off rides in the same payload (`950 + 20 + 30` lands at zero and earns
   nothing under the formula). I implemented the formula, on the reading that the owner earns the
   discount on a full early *payment* and a short-pay the shop absorbs is the opposite of being paid
   early — and because it is the tighter of the two, which is the safer side of a ruling that
   tightens. It is pinned by its own test and is a one-line change if the reviewer reads it the other
   way.

3. **Two E2E flows changed** (`receivables-apply-age-statement.mjs`, `close-month-end.mjs`). Both
   took the early-pay discount on a *partial* payment, so both would have gone red — and not merely
   at the assert: the "Take 20.00" checkbox renders only when `discountAvailable > 0`, so the
   `.check()` call would have timed out on an absent element. Rather than silently dropping the
   interaction I turned it into a positive assertion of the new rule — `count() === 0` on the
   Discount cell's checkbox, with a message naming #69 — which is stronger coverage than the blind
   `.check()` it replaces. Downstream figures re-derived: the A/R flow's applied total 550 → 530,
   Current bucket 450 → 470, aging Net and statement total due 250 → 270 (both, they must agree);
   the close flow's fixture-math comments (no asserted dollar figure there depended on the discount
   — its second-export assertion is scoped to the voided write-off, and "Payment 600.00 · Applied
   400.00 · On account 200.00" is PAYMENT-type only, so it is unchanged).

4. **A finding, pinned rather than fixed: the two-step discount is now unreachable.** The brief says
   the DISCOUNT-only follow-up "must keep working — it settles, so it qualifies". My guard *does*
   pass it (`0 + 20 == 20` against a 20.00 remainder). It is the **pre-existing #81 entitlement cap**
   that refuses it, and did so at HEAD too: `remainingDiscountFor` offers `min(2% × 20, 20) = 0.40`,
   so a 20.00 discount is refused with "discount exceeds the eligible early-pay amount of 0.4". And
   the 0.40 it does offer cannot be taken either, because 0.40 does not settle 20.00. Since
   `pct × open < open` for any percentage below 100, **no DISCOUNT-only call can ever satisfy both
   rules** — a discount is now takeable only in the same call as the settling payment. That is a real
   narrowing, it is not caused by this change, and I pinned it in a test
   (`leaves the entitlement cap — not the settlement guard — refusing the two-step discount`) that
   asserts *which* message fires, so the boundary is visible instead of folklore. Candidate
   follow-up if the owner wants the two-step back: the eligible basis for a settling discount would
   have to be the invoice figure the remittance was netted against, not the residue.

---

## What the reviewer should probe

- **The E2E run is owed** (group-level, per the brief — I did not run it, and three implementers
  sharing port 3000 and the dev DB is why). The two edited flows are the ones to watch, plus any
  flow touching `/receivables`. `close-month-end.mjs` is the riskier of the two: its `variance 0`
  and `readiness gaps 0` assertions are structural rather than dollar-pinned, so I reason they hold
  with one fewer posting, but that is reasoning, not a run.
- **The check order in `resolveReason`** — window, then settlement, then cap. Several tests pin
  messages that would flip if the order changed.
- **Deviation 2** (the WRITE_OFF exclusion) is the one genuinely interpretive call in this task.
- **A UX wrinkle I did not change**: on the apply grid, taking the discount requires typing
  `open − discount` as the payment amount. Typing the full open balance *and* checking the box now
  fails on the over-application check ("That exceeds the invoice's open balance of 0"), exactly as it
  did before this change — so it is not a regression, but the grid does not help the operator get it
  right. Out of the brief's scope (which named the two service sites); worth an issue if the group
  wants it.
- **`discountAvailable` now reads the payment's applications.** It is a plain autocommit read feeding
  the UI (not a guard — the save re-derives everything under its own claims), so no transaction
  threading was added. Worth a second pair of eyes that this is the right call for a read that no
  invariant depends on.

---

# Fix round 1 — the five review Minors

Reviewer verdict was **Spec ✅ · Approved (round 1)**, zero Important, zero Critical; all five items
below are Minors. Only one changes behavior (the E2E addition). Two commits:

| | |
|---|---|
| `ec06fbf` | `docs(receivables): name the multi-invoice caveat in the §4.3 settlement block (#69)` — **committed first and alone**, to clear `erp/src/server/applications.ts` for the #77 implementer the controller was holding |
| *(this commit)* | the remaining four Minors + this note |

**Item 2 — the §4.3 header overclaimed** (`applications.ts`). It said the two read sites "must
agree", full stop. They must agree *per invoice*; across a whole grid they deliberately cannot, since
`discountAvailable` answers about one invoice and measures the payment's entire unapplied cash
against it — a $1,000 check facing two $1,000 invoices offers "Take 20.00" on both, and taking both
is refused by the payment's own unapplied-amount check (the same upper bound the plain amount inputs
have always had). The block now says so, and states the invariant that actually holds: it is
one-directional — every DISCOUNT the save accepts satisfies the offer's condition, so the save can
never accept what the offer would refuse. Comment only.

**Item 1 — the discount happy path had lost all E2E coverage.** Both flows that drove the
"Take 20.00" checkbox now assert its absence, so nothing end to end rendered the offer, checked it,
or drove a DISCOUNT through the route. Restored at the **tail** of
`receivables-apply-age-statement.mjs`, after every aging/statement assertion, so the existing fixture
math is untouched: a second check of **460.60** settles the 470.00 still open and takes the **9.40**
offered (2% of 470.00, inside the 20.00 entitlement). Re-derived and checked in integer cents —
`46060 >= 47000 − 940` is the offer's boundary **exactly**, so a cent lost anywhere in the chain
shows up as an absent checkbox rather than a wrong number, and the save's exactness test is
`46060 + 940 == 47000`. It asserts the offer is present *and* reads "Take 9.40" (the mirror of the
two absence assertions), that the panel settles to
`Payment 460.60 · Applied 460.60 · On account 0.00`, that a **Discount** application row exists for
9.40, and that the settled invoice drops out of the candidate list.

Three traps handled while writing it, each commented in place: the second payment shares the batch's
one payment type, so the earlier `paymentRow` locator would match two rows from here on (the new row
is located by **check number**); the page now carries the other row's "Apply" **toggle** alongside
the panel's "Apply" **submit**, so the submit is scoped to the panel's own `<td colSpan={8}>` via
`ancestor::td[1]` rather than the unscoped `page.getByRole` the first apply can safely use; and the
batch's `controlTotal` is null (the flow never sets one), so `postBatch`'s #80 footing check does not
object to a second payment — which matters because `close-month-end.mjs` posts this batch. That flow
also already sets **"Discount GL account"** among its four Admin → Billing defaults, so the restored
DISCOUNT posting is covered by readiness exactly as it was before #69 removed it.

**Item 3 — attribution in the spec.** The WRITE_OFF exclusion was stated inline with the owner's
ruled text as though the owner had said it. Both spec sites now label it as the implementation's
reading of `cash + discount == open`, **pending ratification**, with the reasoning, the reviewer's
endorsement, and the reviewer's sharper argument for it (counting a write-off would open a
`PAYMENT 500 + DISCOUNT 20 + WRITE_OFF 480` loophole), plus the note that it is a one-line change if
the owner reads it the other way.

**Item 4 — `e2e/run.mjs`** no longer describes `close-month-end` as seeding "a discounted/written-off
payment"; it points at the A/R flow's settling second check for where the discount now lives.

**Item 5 — the demo doc contradicted itself** ("none of the three options" / "the basis stays the
open balance", which is option 1). Rewritten: the basis *is* option 1 and did not move; what the
owner added is a settlement guard none of the three options contemplated.

**Follow-up issue filed: [#155](https://github.com/CoJoA13/HeatSynQ/issues/155)** — "5B A/R: the
two-step early-pay discount is unreachable after #69, and the hidden offer explains nothing (§5.14)".
It carries both arms: the arithmetic finding (composing #69 with the #81 cap leaves no pair of
numbers that satisfies both, so a discount is takeable only in the same call as the settling payment
— with the owner question of whether "pay first, discount after" is a real remittance pattern, and
the basis change that would fix it if so), and the reviewer's §5.14 finding (an operator entering a
partial sees nothing at all in the Discount cell and cannot learn that remitting 980.00 would earn
20.00, though the hide reason is operator-fixable). The issue records the E2E note for whoever takes
it: the flows assert a row-scoped checkbox count of 0, so a text-only hint keeps them green while a
disabled-with-tooltip checkbox would fail them, correctly.

## Fix-round gates

Scratch DB `erp_scratch_i1` recreated + migrated, dropped after.

| Gate | Result |
|---|---|
| `npx vitest run` on the four touched suites (applications, applications-routes, roles-routes, roles) | **98 passed** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `node --check` on both edited `.mjs` files | clean |
| `npx eslint e2e` | the same **pre-existing** `cert-results-print.mjs` warning, nothing new |

The full suite was not re-run this round — the only non-comment changes are E2E `.mjs` files and
docs, neither of which vitest loads. **The E2E run is still owed at group level, and now has one more
reason to matter**: the settling second apply is new UI driving, not just re-derived numbers.

---

# Fix round 2 — the red group E2E, and the panel-lifetime trap

The settling-payment step I added in fix round 1 failed the group run at
`receivables-apply-age-statement.mjs:367`, waiting for the panel summary line
`Payment 460.60 · Applied 460.60 · On account 0.00`. The apply itself had SUCCEEDED — `await settled`
resolves only on `res.ok()` — so the money landed and the locator was what was wrong. One commit,
E2E-only.

## The mechanism, confirmed and corrected

The controller's hypothesis was that a successful apply CLOSES the panel, taking my anchor with it.
The conclusion was right — the anchor left the DOM — but the mechanism is not panel closure, and the
difference is what makes the trap worth writing down.

`ApplyPanel.apply()` never touches `expandedPaymentId` (BatchDetail.tsx): on success it resets the
grid, calls `onApplied()` and reloads. **The panel stays open.** What actually vanished is the
CANDIDATE TABLE inside it, which renders only under `rows.length > 0` — and my apply settled the
family's only open invoice, so the candidate list went empty and the table unmounted. Every locator I
had derived from it went with it, including `settleTable.locator("xpath=ancestor::td[1]")`.

So the rule is sharper than "the panel may close":

> **A settling apply destroys the candidate table it was driven from.** Anchoring post-apply
> assertions on that table means anchoring them on the very thing your success removes. Pre-apply
> locators may use it freely — it is alive then by definition.

This is also why the trap did not exist before: the flow's FIRST apply leaves 470.00 open and
`close-month-end`'s leaves 570.00, so their candidate tables survive, and both assert their summary
line page-scoped anyway. A grep of `e2e/` finds exactly three anchors on that columnheader
(`receivables-apply-age-statement.mjs:171` and `:343`, `close-month-end.mjs:327`); only mine settles,
so only mine was exposed. The other two are latent — they break the day either apply starts settling,
which the comment now warns about in place.

## The fix

`settlePanel` is now the panel's own wrapper `<tr>`, reached from the payment row that always
exists — `settlingRow.locator("xpath=following-sibling::tr[1]")`, matching BatchDetail.tsx's
`<Fragment>` shape (payment `<tr>`, then the `<tr><td colSpan={8}>` panel row while expanded). It
keeps every benefit the old scope had — in particular disambiguating the panel's "Apply" SUBMIT from
the other payment row's "Apply" TOGGLE, which is why the assertions are scoped rather than
page-scoped — while surviving the settlement.

Two smaller hardenings went in with it, both races the first version would have hit intermittently
rather than deterministically:

- **The candidate row's `detached` wait now runs FIRST**, before the two content assertions. It
  doubles as the wait for the panel's post-apply reload, so those assertions read a settled DOM
  instead of racing it.
- **The discount row is filtered on the amount as well as the type.** Before the reload lands, the
  stale candidate table's own **"Discount" COLUMN HEADER** row would satisfy a type-only filter —
  and `.locator("td").nth(2)` on a header row of `<th>`s finds nothing. Filtering on both `Discount`
  and `9.40` can only ever match the applications table's data row.

## Verification

`node --check` on the file (Task 4's finding stands: `npx eslint src tests` does not cover `e2e/` at
all and returns 0 on a file that cannot be parsed — worth remembering that neither gate would have
caught this one either, since it was a live-DOM fact, not a syntax or type fact).

Then the **full group E2E**, not just the flow I touched, per the controller's instruction:

```
All 23 flows passed. Artifacts: erp/e2e-artifacts
EXIT=0
```

`receivables-apply-age-statement` **PASS** (the flow that was red), `close-month-end` **PASS** (the
other flow this task edited), and the 21 others unaffected. Run against a throwaway `next dev` on
port 3100 and the dev DB, the harness's own arrangement; fixtures cleaned up by `run.mjs`.

**A gap worth naming while it is fresh**, since Task 4 already found half of it: `npx eslint src tests`
does not cover `e2e/` and returns 0 on an unparseable flow file (Task 4's duplicate declaration), and
`node --check` would not have caught THIS one either — a locator that resolves to a real element at
write time and to nothing after the DOM changes is neither a syntax nor a type fact. Only running the
flow finds it. That is an argument for the controller's instruction (run the full suite, don't reason
about it) rather than for a new gate.

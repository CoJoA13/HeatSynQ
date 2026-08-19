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

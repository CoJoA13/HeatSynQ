# Walkthrough and defect log

The human-judgment half of the pre-acceptance verification. [`sweep.md`](sweep.md) is the
machine half — it visits every screen and reports what the browser saw. This file records what
a person concluded while driving the app: what works, what is misleading, and what was filed.

Run against the demonstration dataset ([`dataset.md`](dataset.md)) on 2026-08-19/20.

## What was verified working

**Document production — all eight kinds.** Every `StoredDocument` in the dataset carries a
valid `%PDF` header at a sensible size: traveler ×7, shipper ticket ×2, BOL, certificate,
invoice ×2, credit memo, statement ×2, quote ×2. The paper is the heart of this system and the
whole pipeline produces real documents.

**The screens.** The sweep discovered **45 routes** from `src/app/**/page.tsx` and captured **50
screens** from them (a dynamic route yields one screen per discovered id). **50 PASS** — real
content, clean console, no failed requests — and **no FAIL**. The walkthrough itself found one:
`/admin/users`, which was #160 — the page rendered correctly and the failure was five signature
404s it fired by design. That is fixed (below), and the sweep has had a clean gate since. See
`sweep.md` for the per-screen table; the four screens its heuristic flagged as sparse were checked
by hand and cleared (below).

**The money screens agree with each other.** The A/R aging, the customer A/R sections and the
month-end continuity schedule are drawn from the same reads and reconcile — the continuity
schedule's independent aging cross-check is what proves it, and it reports a variance rather
than hiding one.

**The order-to-cash chain.** Orders exist in every status the enum can reach, including
`REOPENED` — which is produced the only way it can be, by reversing a shipment on an invoiced
order.

## Filed from this walkthrough

| # | What | Kind |
|---|---|---|
| [#159](https://github.com/CoJoA13/HeatSynQ/issues/159) | On-account cash is stranded once its month closes — an application inherits the payment's date, so a closed month freezes that cash permanently | **Ruled — not a defect, closed.** The cash-journal entry belongs to the date the cash arrived, and a late allocation genuinely does move a closed month's aging. The lock is working; the reopen is the sanctioned route. Procedure: allocate on-account cash before its month closes |
| [#160](https://github.com/CoJoA13/HeatSynQ/issues/160) | The Users page emits one 404 per signature-less user, so a healthy page can never pass a console/request health gate | Defect — **fixed** (round 3 group C): the users list now carries a `hasSignature` boolean, so the preview image is requested only when there is one |
| [#161](https://github.com/CoJoA13/HeatSynQ/issues/161) | Shipment reversal is implemented and tested but has **no UI control** — and the refusal messages instruct operators to "re-reverse", a step with no button | **Fixed** (round 3 group B): a Reverse control beside Void, on the same permission the route enforces. `REOPENED` is now reachable from a screen and matched by the board's own Reopened filter, and the "void the reversal, edit, re-reverse" refusals now name steps an operator can take, and (since [#182](https://github.com/CoJoA13/HeatSynQ/issues/182), fixed 2026-08-23) the original's pair-freeze banner on an invoiced pair names the invoice first too, matching its Void button — both off one shared precedence helper. **Its gate deliberately omits the invoice block Void carries** — reversal is the correction for an invoiced shipment, so blocking it there would disable the control in the one case it exists for. Cert half: [#165](https://github.com/CoJoA13/HeatSynQ/issues/165) |
| [#162](https://github.com/CoJoA13/HeatSynQ/issues/162) | The statement printed a finance charge that is never billed — excluded from the total due, never posted, never aged, never exported | **Ruled informational — fixed** (round 3 group C): the figure is shown, never levied. The control and the printed line now say so, and the spec no longer promises a persisted, idempotent finance-charge run |
| [#163](https://github.com/CoJoA13/HeatSynQ/issues/163) | A receipt batch with no control total shows a Balance of 0.00, identical to one that balances | Defect — **fixed** (round 3 group A): `balance` is `null` when there is no control total, and both screens say **Not proved** instead of a zero that reads as checked. The schema comment and the 5B design spec had both said `controlTotal − Σ payments` all along — the service was the one that disagreed |

### About #162 — the most consequential finding

Verified independently: `statements.ts:309` returns `totalDue: aging.net`, and `financeCharge`
appeared nowhere in the server outside its own calculator and the statement printer. So the
statement showed a finance charge above a total that excludes it, and nothing recorded that a
charge was ever made. A shop ticking that box monthly would have believed it was charging
interest and have billed nothing.

**Ruled 2026-08-19: the figure is informational — shown, never levied.** That ratifies two
earlier rulings the issue had not found (P5B §3 ruling 9 and P5C §3 ruling 4, the latter saying
in as many words that it is *not* an open question), so the defect was never the missing posting
— it was that a deliberately informational figure was presented as a levy. Fixed in round 3
group C: the control and the printed line both say the charge is not billed, and the main spec's
two remaining promises of a persisted, idempotent finance-charge run are struck.

Collecting interest means raising a real invoice. If that ever becomes routine, building the
posting half is a spec amendment reversing three rulings, not a bug fix.

### About #161

Verified three ways when filed: `grep -rn "/reverse" src/app src/components` returned nothing, no
client file referenced the route, and no E2E flow exercised it. The route was already covered by 17
unit tests. The shipment page rendered the whole *read* side — pair-freeze banners, the "void the
reversal first" Void precedence — so the UI explained reversals to an operator who could not create
one. It was also the only writer of the `REOPENED` order status, equally unreachable in practice.

**Fixed in round 3 group B.** The one judgement worth recording: the new control's gate does **not**
carry the invoice block that Void's does. It is the same page, the same permission, and the button
directly beside it — so cloning that ladder was the obvious move, and it would have disabled Reverse
on precisely the invoiced shipments reversal exists to correct. `reverseShipper` carries no invoice
guard at all; it reads finalized-invoice state only to decide which orders become `REOPENED`. The
unit test pins the absence rather than the behaviour, deep-equalling the gate with and without the
block, so the field cannot creep back into the decision.

A second unreachable route was found in the same sweep, split out as
[#165](https://github.com/CoJoA13/HeatSynQ/issues/165) and **fixed in the same group**: `POST
/api/certs` had no UI caller, and the order hub's "Create cert for Load N" was hardcoded to LOAD
scope, so no screen could raise an ORDER- or SHIPMENT-scope certificate when automatic creation
missed one. SHIPMENT scope needed a **new route** rather than a relaxed schema — `POST /api/certs`
is `.strict()` and omits `shipperId` by a decision recorded in that file's own docblock, so it was
routed around instead of reversed.

Building the picker also exposed a guard that had never been needed: a hand-raised SHIPMENT cert can
name any (order, shipment) pair, where the two automatic callers always passed a pairing they had
just written. An unpaired one prints every quantity as zero under a bare order label, so `createCert`
now refuses it. **A new surface finding a latent gap in the service beneath it** is the useful shape
here — the guard was not missing because anyone overlooked it, but because nothing could reach the
state until this control existed.

## Judged and cleared — not defects

Recorded so the next reader does not re-litigate them.

**Four screens flagged as "rendered almost nothing"** by the sweep's heuristic. Checked each in
the browser: `/admin/roles` renders all five roles and `/admin/surcharges` all three — they are
list screens rather than tables, which is what the heuristic keys on; `/login` and `/practice`
are legitimately sparse. **The heuristic was deliberately left alone.** It exists to flag
borderline screens for a human, and a human cleared them; tuning it until it stops flagging is
how it stops working.

**The admin navigation appeared to be missing Templates, Audit log and Backups.** It is not —
the DOM carries all 21 links. The accessibility-tree read that suggested otherwise was
truncated output, not app behaviour. Verified directly before reporting.

**`REOPENED` looked like a dead order status** that nothing writes, which would have meant the
board offers a filter that can never match. It is written by shipment reversal
(`shippers.ts:2094`); the schema comment calling it "reserved" is simply stale. (Reaching it
from a screen is a different matter — see #161.)

**Only the LEAD part's recipe revision locks at order save**, which looked like it would let a
multi-line order's other recipes drift away from the printed traveler. It does not: the
traveler is a lead-part document by design — it reads `order.lines[0]`'s locked revision and
that part's inspections only (`traveler.ts:874-901`; spec §3.1/§10 makes the lead part the
order's process identity). Nothing the traveler shows can drift, so locking the lead alone is
consistent rather than partial.

**Finalize re-stamps the invoice's terms label** from the customer's terms record, clearing a
hand-typed label when the customer has none. Deliberate, from a review round: the label must
match the discount numbers frozen alongside it (#79), or the paper would advertise terms it
does not carry. The blank-customer edge is the only rough part, and it is cosmetic.

## Rough edges worth knowing (not yet filed)

Found by driving every service back to back while building the dataset. None is a correctness
or data-integrity defect — every guard that fired, fired correctly — but each costs somebody
time:

1. **`applyPayment` and `applyCredit` disagree about how to type money**, in the same file: one
   takes a decimal string, the other a number. Two adjacent money entrypoints, two contracts.
2. **~~"no early-pay discount applies" covers three distinct causes~~ — fixed
   ([#175](https://github.com/CoJoA13/HeatSynQ/issues/175), 2026-08-20).** Outside the window, no
   terms on the invoice, and entitlement already consumed each name themselves now, off the same
   composition the offer read uses. The out-of-window one now also names the day the window ran
   through ([#178](https://github.com/CoJoA13/HeatSynQ/issues/178), 2026-08-23), off that same
   single deadline computation.
3. `process-templates.ts` and `templates.ts` both export `createTemplate` for unrelated
   concepts.
4. **There is no supported way to seed the demo slice into the dev database.** The guarded
   entry correctly refuses on `erp`, so the rebuild needs a `tsx -e` one-liner. The guard is
   right; the dev-side convenience script is missing.
5. `postBatch`'s control-total match inverts the natural order of writing a caller, and fails
   late.
6. ~~A blind `createCert` collides with the eagerly-created cert without hinting one exists.~~ **Fixed** ([#165](https://github.com/CoJoA13/HeatSynQ/issues/165), round 3 group B): the refusal now names which live cert covers that scope instance, with a link to it. The UI still does not pre-check — uniqueness is settled server-side under the order claim and a client-side guess would be a second opinion that can disagree with it.
7. `createQuote` needs a real user in the actor context, so the demo seed's system actor cannot
   create one.

## What the demonstration data cannot show

Three states are unreachable through the app's own front door and are therefore **absent rather
than faked**. `dataset.md` explains each in full; in short:

- **A multi-month Sales report.** Finalizing stamps the current date and Sales recognises on
  it, so seeded invoices all land in the build month. Demonstrating this needs a database that
  has genuinely been used across months.
- **A prior month with invoice activity**, for the same reason — the closed month carries cash
  only. It follows that a prior month can hold only *unapplied* cash, because the close refuses
  any variance between its roll-forward and the aging, and those two agree in a past month only
  while its cash stays unapplied.
- **A currently-reopened accounting period.** Re-closing updates the row in place, so the
  reopen survives only in the audit log.

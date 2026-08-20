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
screens** from them (a dynamic route yields one screen per discovered id). **49 PASS** — real
content, clean console, no failed requests — and **1 FAIL**, `/admin/users`, which is #160: the
page renders correctly and the failure is five signature 404s it fires by design. See `sweep.md`
for the per-screen table; the four screens its heuristic flagged as sparse were checked by hand
and cleared (below).

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
| [#159](https://github.com/CoJoA13/HeatSynQ/issues/159) | On-account cash is stranded once its month closes — an application inherits the payment's date, so a closed month freezes that cash permanently | **Owner decision** |
| [#160](https://github.com/CoJoA13/HeatSynQ/issues/160) | The Users page emits one 404 per signature-less user, so a healthy page can never pass a console/request health gate | Defect |
| [#161](https://github.com/CoJoA13/HeatSynQ/issues/161) | Shipment reversal is implemented and tested but has **no UI control** — and the refusal messages instruct operators to "re-reverse", a step with no button | **Owner decision** |
| [#162](https://github.com/CoJoA13/HeatSynQ/issues/162) | **"Assess finance charges" prints a finance charge that is never charged** — excluded from the total due, never posted, never aged, never exported | **Owner decision** |
| [#163](https://github.com/CoJoA13/HeatSynQ/issues/163) | A receipt batch with no control total shows a Balance of 0.00, identical to one that balances | Defect |

### About #162 — the most consequential finding

Verified independently: `statements.ts:309` returns `totalDue: aging.net`, and `financeCharge`
appears nowhere in the server outside its own calculator and the statement printer. So the
statement shows a finance charge above a total that excludes it, and nothing records that a
charge was ever made. A shop ticking that box monthly would believe it had been charging
interest and have billed nothing. Either the control is mislabelled (it is informational) or
the posting half was never built — that is the owner's call, and it should be made before the
parallel-run month.

### About #161

Verified three ways: `grep -rn "/reverse" src/app src/components` returns nothing, no client file
references the route, and no E2E flow exercises it. The route is covered by 17 unit tests. The
shipment page renders the whole *read* side — pair-freeze banners, the "void the reversal first"
Void precedence — so the UI explains reversals to an operator who cannot create one. It is also
the only writer of the `REOPENED` order status, which is therefore equally unreachable in
practice.

A second unreachable route was found in the same sweep and is noted on #161: `POST /api/certs`
has no UI caller either, and the order hub's "Create cert for Load N" is hardcoded to LOAD
scope — so no screen can manually create an ORDER- or SHIPMENT-scope certificate if the
automatic creation ever misses one.

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
2. **"no early-pay discount applies" covers three distinct causes** — outside the window, no
   terms on the customer, entitlement already consumed. Reading `discountFor` is the only way
   to tell which. A clerk cannot. (Related to [#155](https://github.com/CoJoA13/HeatSynQ/issues/155).)
3. `process-templates.ts` and `templates.ts` both export `createTemplate` for unrelated
   concepts.
4. **There is no supported way to seed the demo slice into the dev database.** The guarded
   entry correctly refuses on `erp`, so the rebuild needs a `tsx -e` one-liner. The guard is
   right; the dev-side convenience script is missing.
5. `postBatch`'s control-total match inverts the natural order of writing a caller, and fails
   late.
6. A blind `createCert` collides with the eagerly-created cert without hinting one exists.
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

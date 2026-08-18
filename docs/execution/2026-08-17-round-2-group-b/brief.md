# Round 2, Group B — A/R that needs no accountant · task brief

**Branch:** `group-b-ar` · **PR:** #135 · **Base:** `1c1fc77`
**Source of scope:** `docs/2026-08-17-backlog-round-2.md`, Group B.

## Why this group exists

Round 2 is what gets worked while the accounting meeting's answers come back. Group B is the A/R
work that needs **no** accountant input — clear defects plus one undelivered spec deliverable.

## Scope — six issues

| # | Defect |
|---|---|
| #83 | The customer A/R open items exclude credits and on-account cash, so the net cannot be reconciled to the table |
| #85 | "Per-division" statements print only the parent, silently omitting every division |
| #86 | A negative `Customer.financeChargeRate` is accepted and silently suppresses finance charges |
| #82 | Terms both-or-neither validation has a TOCTOU race |
| #79 | The early-pay discount reads the customer's CURRENT terms, not the invoice's issued terms |
| #75 | Credit-memo application has no UI — `applyCredit` and its route exist, tested, uncalled |

**#79 is buildable regardless of the accounting meeting.** Q13 decides the discount *basis* (a
percentage of what); this decides *which* percentage — the one the paper was issued under.

## Owner ruling taken before the branch opened (2026-08-17)

**The credit-application UI lives in the CUSTOMER A/R SECTION** (#75) — beside the open invoices it
can pay down. That makes **#83 and #75 one task**: #83 is what puts open credits into that list, and
#75 hangs the Apply action off the rows it adds. Rejected: the receipt-batch screen (a credit memo
has no receipt batch — it exists independently of any deposit) and the invoice page (nothing there
tells an operator a credit exists to apply).

## Constraints binding this work

- TDD per issue: failing test → implement → pass → commit. **RED-verify every test.** For a DB
  constraint or a write that only fires inside a service, that means dropping/reverting the mechanism
  and watching the test fail, not just observing green.
- Every standing rule in `CLAUDE.md`: the frozen-paper rule (§5.4), the row-lock discipline, the
  reports/reads rule, "a client component must not import from `src/server/**`", and the
  hand-written-CHECK convention for invariants Prisma's schema cannot express.
- Migrations follow the no-TTY recipe and apply to **both** databases.
- Gates: `npm test`, `tsc`, `eslint`, `build`, and `npm run test:e2e` **watched to completion**.
- Three of the six are UI deliverables — verify them in the browser, not only in tests.

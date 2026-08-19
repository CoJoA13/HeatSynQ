# Round 2 Group F — infrastructure and tooling — progress ledger

Branch `group-f-infra`, opened 2026-08-18 from `a11f6c2`.
Issues: **#30, #111, #40, #34, #35, #112, #32** build; **#107 closed not-planned at kickoff**
(owner ruling, recorded on the issue: the shop's scale cannot produce the problem, reports stay
deliberately simple pure reads; revisit trigger = a source table grows large enough that a
no-filter run gets visibly slow or memory-heavy).

## Kickoff rulings (2026-08-18)

- **#107 → closed not-planned** (owner, asked at kickoff — the #76 precedent). Nothing built.
- Controller scope calls, per the issues' own texts: **#112 takes the minimal fix** (remove the
  broken in-container parenthetical; consistent with the production seed's documented
  constraint); **#30 includes the boot check** ("ideally starts the image far enough to confirm
  the server boots" — the issue's own ask); **#111's fix shape decided by recon** under the
  binding constraints serialize + no-pinning + prefer-deleting-a-mechanism (the issue's
  round-3-flagging-round-2 warning).

## Task verdicts

(one entry per task as reviews land)

# Round 3 Group A residue — progress ledger

Branch `round-3-group-a-residue` off `main` at `d7dbdd6`. Brief: `brief.md`.

Three tasks, strictly sequential (Tasks 2 and 3 share `applications.ts`), plus docs.

| # | Issue | Task | Review | State |
|---|---|---|---|---|
| 1 | #173 | The closed-period clause covers every application | Needs fixes → **1 Important, fixed** (`ad44d2c`) | **done** |
| 2 | #174 | A closed-month write-off shows a disabled Void | Approved — 0 Critical, 0 Important, 3 Minor | **done** |
| 3 | #175 | The discount refusal names which dead end | Approved — 0 Critical, 0 Important, 3 Minor | **done** |
| 4 | — | Docs: four chapters + HANDOFF | — | **done** |

## Commits

| SHA | What |
|---|---|
| `614f97f` | The brief, committed **first** |
| `c482187` | #173 — rename `writeOffVoidHint` → `applicationVoidHint` |
| `3b78dc8` | #173 — the period clause covers every application |
| `a66b277` | Task 1 report |
| `c887397` | #174 — `voidable` flag + disabled-with-reason Void |
| `61a5ec6` | Task 2 report |
| `ad44d2c` | #173 review **Important** — the counter that could not fail |
| `48be5ae` | #175 — four causes, four sentences, one composition |
| `e1f8c3a` | Task 3 report |
| `803e9c4` | #174/#175 review round — the render test my brief said was impossible |

## Filed from this group

- **#178** — the out-of-window discount refusal does not say *when* the window closed. Deliberately
  left: naming it needs the deadline threaded out of the single `addDays`, not computed a second
  time, which would reopen the drift this task closed.

## What this group is worth remembering for

**1. A fix that establishes a rule, then applies it only to the case that prompted it.** All three
issues here are that shape, and all three were filed by the *reviews of the work that created them*.
#157 shipped a hint true of open-vs-closed months and false of write-offs-vs-payments, in the same
breath as fixing a hint that was true of write-offs and false of everything else. Worth asking, at
the end of any fix: *what else does the rule I just wrote apply to?*

**2. The conjunction can carry the defect.** #173 looked like a query-scope fix. It was not: the old
sentence hung the obstacle off the route it had just named, so a wider query underneath that phrasing
would have made the sentence *more* wrong. The fix is a semicolon and two clauses that share no
subject.

**3. Guard the invariant with a type, not a convention.** `PreSettlementBlock =
Exclude<DiscountBlock, "would_not_settle">` makes a fifth blocker a compile error. Reducing
`remainingDiscountFor` and `issuedTerms` to one call site each is a stronger guarantee than the test
that pins their agreement.

**4. A guard nobody watched fail proves nothing — and its comment will say the opposite.** Three
instances on this branch:
- #173's refusal-path counter patched the `prisma` singleton while the code ran on a transaction
  client (`tx.application === prisma.application` is **false**, measured). It could not fail, and
  `invoice-guards.ts` cited it as "Pinned by a query counter".
- The tooltip pin re-declared the client's rule and pinned the copy, under a comment claiming it
  pinned the client.
- My own render test used `toContain("disabled")`, which passes on Tailwind's `disabled:*` class
  names with the feature deleted.

Each was caught by *running* something, never by reading. Two by reviewers; the third by its own
negative case — which is the argument for always writing the negative beside the positive.

**5. A brief can ship a false premise, and it costs more than a bug.** Four briefs of mine asserted
that a `.tsx` change cannot be unit-tested here. There is no jsdom, so clicks and effects are
Playwright's — but `renderToStaticMarkup` renders initial state, and four suites already did it.
Implementers correctly reported the client half as unverifiable **because I told them it was**. The
constraint I stated was real; the conclusion I drew from it was not.

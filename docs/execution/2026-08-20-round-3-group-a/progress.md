# Round 3 Group A — progress ledger

Branch `round-3-group-a` off `main` at `814a025`. Brief: `brief.md`.

Tasks ran **strictly in sequence** — 2 → 3 → 1 → 4 — because Tasks 1/2 share
`src/server/applications.ts` and Tasks 1/3 share `BatchDetail.tsx`, and there are no worktrees in
this checkout. (Task 3 ran before Task 1 rather than after, once Task 2's review freed the schedule:
Task 3's files are disjoint from Task 2's diff, so its implementer could run alongside Task 2's
reviewer. Task 1 had to wait for Task 3 to release `BatchDetail.tsx`.)

| # | Issue | Task | Review | State |
|---|---|---|---|---|
| 2 | #157 | Bounded write-off retention + conditional void hint | Approved, round 1 — 0 Critical, 0 Important, 6 Minor | **done** |
| 3 | #163 | An unproved batch stops reading as balanced | Approved, round 1 — 0 Critical, 0 Important, 4 Minor | **done** |
| 1 | #155 (arm 2) | The hidden discount offer names its route out | Needs fixes → **1 Critical, fixed** (`363d2a1`) | **done** |
| 4 | #159 | Docs: the closed-month cash rewording | — (prose) | **done** |

## Commits

| SHA | What |
|---|---|
| `79b2e47` | The brief, committed **first** |
| `62e11f1` | #157 — retention bound, `closedMonthsForDisplay`, conditional hint |
| `17a7e1c` | Task 2 report |
| `8995faf` | #163 — `balance: number \| null`, both read shapes, both display sites |
| `ab48dcf` | Task 3 report |
| `263c513` | #157 review round 1 — call-site allowlist, stronger held-lock pin, wrong comment corrected |
| `c81b29d` | #159 rewording + CLAUDE.md's period lock + the manual's three-state Balance |
| `e9e0af1` | 5B plan's balance formula marked superseded |
| `11c2ca7` | #155 arm 2 — `discountOffer`, the hint, both E2E flows |
| `df502a9` | Task 1 report |
| `363d2a1` | #155 review round 1 **Critical** — the wire shape the rename could not force |

## Gates at close

- `npx tsc --noEmit` clean · `npx eslint src tests` clean · `node --check` on both edited flows
- `npx vitest run` — **3486 tests / 204 files, all passing**
- `npm run test:e2e` — **23/23 flows** (both A/R flows carry the new assertions)
- `npm run manual:capture` — **50/50 screens**, no console errors, no failed requests
- `npm run manual:build` — 14 chapters, 46 figures, 14.60 MB (under the 16 MB ceiling)

## Filed from this group

- **#173** — the closed-period void hint covers write-offs only; a payment or discount in a closed
  month still names a route that refuses you. The identical defect one door down from #157's fix.
- **#174** — a closed-month write-off on a still-open invoice shows an enabled Void that always 409s.
- **#175** — the save-side refusal still says the same three words for four different dead ends, now
  that the offer read knows which.
- A measurement added to **#169**: a fresh `manual:capture` **fails the 16 MB ceiling outright**, so
  the repo currently cannot regenerate its own manual.

## Log

- **2026-08-20** — Branch cut, recon done, brief committed first (house rule: the execution record is
  committed on the first task, not at the end).
- **2026-08-20** — All four tasks done, three reviews taken, one Critical fixed, full gates + E2E
  green, PR opened.

## What this group is worth remembering for

**A rename is a compile-time forcing function for callers of the FUNCTION, and not for consumers of
the JSON.** `res.json()` is `any`, so widening a route payload is exactly the change `tsc` cannot
see. That is how `tests/applications-routes.test.ts` kept asserting the old flat shape through a
clean typecheck, and it is why the fix pins the whole envelope rather than one field.

**A guard that has never failed proves nothing.** The call-site allowlist added in review was RED-
verified by making the repository genuinely wrong — and its first version was itself wrong (it
counted the defining module, so it would have failed on a clean tree). Reasoning about a guard is
how this session produced two false guarantees in comments; running it against a broken repo is what
catches them.

**Check the figures rather than reasoning about them.** Two reviewers disagreed about whether the
manual's receivables screenshots had gone stale. Rebuilding the dataset and re-capturing settled it
in one pass — they had not — and the same attempt measured #169 far more precisely than the issue
had it.

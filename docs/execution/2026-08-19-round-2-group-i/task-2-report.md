# Task 2 — #137, the three statements-screen defects — implementer report

Branch `group-i-ready-issues`. One code commit plus this report.

| SHA | What |
|---|---|
| `bb62c9c` | `fix(statements):` all three defects + the extracted gate, TDD'd (all three RED first) |

Files: `erp/src/app/receivables/statements/Statements.tsx`, `erp/src/server/statements.ts`, NEW
`erp/tests/statements-screen.test.ts`, and one test each appended to `erp/tests/statements.test.ts`
and `erp/tests/receivables-routes.test.ts`. Nothing outside the task's stated scope was touched.

## RED first, with the exact reported shapes

- **Defect 3, service**: `printStatementsPerDivision(parent, { asOf: "2026-02-30" })` returned a
  2-element list, each entry `error: "\"2026-02-30\" is not a valid date (yyyy-mm-dd) for As-of
  date"` — the issue's "N per-member failures" reproduced verbatim.
- **Defect 3, route**: the divisions endpoint answered **200** for that same body.
- **Defects 1 & 2**: all 10 gate cases failed on `printControlTitle is not a function`.

## The fixes

**1 — a failed preview no longer prints over the stale one.** `loadPreview`'s catch now clears
`preview` **inside** its existing `latest.isCurrent(t)` guard, so a *superseded* rejection cannot
clobber current state either (the F7 both-landings rule). Not at the top of `loadPreview`: that
callback re-runs on every keystroke in the as-of field, and blanking a good preview there would
flash the pane empty on each one — round 8 deliberately cleared only `loaded`, and that stands.

**Deviation from the issue text, as instructed and re-verified here:** the new branch gates on
`preview === null`, **not** on `error`. `error` is a shared bucket the customer-options catch also
writes (`Statements.tsx`, the `familyLookup` effect), so gating on it would re-disable Print for
exactly the caller defect 2 opens up — the two fixes would have cancelled out.

**2 — the family gate falls open instead of locking out.** `familyKnown: boolean` →
`familyLookup: "pending" | "known" | "unknown"`. `"unknown"` is set in the `!customersAllowed`
early return and in the catch; `"known"` on success; and the effect sets `"pending"` again the
moment it actually dispatches, so the in-flight window stays closed for a caller who does hold
`customers.view`.

One ordering point worth naming for review: `customersAllowed` is false while `usePermissions` is
still resolving, so `"unknown"` is set on first mount before permissions land. That is harmless
because `printControlTitle` answers `!viewAllowed` on its **first** branch, ahead of the family
one — the control is disabled for the permission reason in that window, not opened. Commented at
the effect.

**I verified the server refusal myself rather than taking it on trust**: `POST
/api/receivables/statements` (`erp/src/app/api/receivables/statements/route.ts`) calls
`hasLiveDivisions(body.customerId)` and throws 409 "That customer has divisions — use Print per
division, or tick Combine family" whenever `combineFamily !== true`. It is pinned by the existing
`tests/receivables-routes.test.ts` "refuses an un-combined print for a customer WITH divisions"
(which I re-ran green). So the client gate is genuinely belt-and-braces and a wrong guess produces
a self-describing refusal, never a silently parent-only statement. Recorded in the comments at both
the gate and the call site.

The Preview header now names the customer (`code` + `name`) from the payload the server already
sends — once the gate falls open, a caller without `customers.view` has a **disabled and empty**
selector and otherwise no way to confirm the `?customerId=` they arrived on.

**3 — an invalid `asOf` is a request-level 400.** `parseAsOf(asOf)` hoisted to immediately after
the `asOf` default and **before** the parent lookup, so it sits outside every per-member `try` —
the `runStatements` shape, cloned. `buildStatementInTx` keeps its own parse (it is the boundary for
the single-print and preview callers); the second parse is idempotent. The partial-results test is
green and untouched: the hoist only removes the *shared* date from the per-member failure surface.

## Testability — the extracted gate

`printControlTitle` is exported from `Statements.tsx` and driven directly by the new suite — the
`runControlState` / `tests/backups-page-state.test.ts` precedent, since `vitest.config.ts` sets
`environment: "node"`. The client module imports cleanly under node (no DOM, no `src/server`
import). 10 cases: the brief's (a)–(e) plus the all-clear, the "unknown still waits for the
preview" case, the in-flight preview, the in-flight print, and a bite-proofing case asserting that
a null preview beats the per-division and printing branches (each of which was ENABLED pre-fix).

## Deviations and judgement calls (all deliberate — please check these first)

1. **`preview === null`, not `error`** — brief-sanctioned; rationale above and in the code.
2. **The gate takes scalar FIELDS, not the two `Gate` objects.** Measured, both ways, on this file:
   passing `viewAllowed` — which is also a `loadPreview` `useCallback` dependency — into a call the
   React Compiler cannot see into makes it report that dependency as "may be modified later" and
   **skip optimizing the whole component**, which `npx eslint src` treats as an ERROR
   (`react-hooks/preserve-manual-memoization`). The backups precedent never hits this because its
   `useCallback` has `[]` deps. Bisected to the single argument.
3. **`const viewAllowed = viewGate.allowed === true;`** — for the same reason: it must be a *fresh*
   primitive, not an alias into the object `gate()` builds during render. This looks like an
   incantation, so it carries a comment saying what re-reds if it is simplified away. Verified in
   both directions.
4. **Added the effect-scoped `let stale` cleanup to the customer-options effect.** It previously had
   neither a ticket nor a flag, and the tri-state made it a three-setter fetch-into-state where a
   stale rejection reporting `"unknown"` over a fresh `"known"` would open the gate on a list we
   *do* have. Same effect I was already editing; the §5.13 dep-keyed shape (`LinesSection.tsx`).
5. **A small in-pane failure line** ("This customer's statement could not be loaded.") for the
   `loaded && !preview` case — otherwise the Preview section renders a header over nothing, and the
   only explanation sits in the shared banner.
6. **Test placement**: the service test went into the existing `printStatementsPerDivision` describe
   in `tests/statements.test.ts` (beside the partial-results test it must not break) and the route
   test into the existing divisions describe in `tests/receivables-routes.test.ts` — their natural
   homes. Both diffs are pure appends; I verified neither file carries another task's edits.

## Gates

Run from `erp/` against a per-task scratch DB (`erp_scratch_i2`, created + `migrate deploy`'d, and
**dropped afterwards**) via `DATABASE_URL_TEST=…` — not `DATABASE_URL`.

| Gate | Result |
|---|---|
| `npm test` | **3404 passed / 3405**, 202 files passed |
| `npx tsc --noEmit` | 1 error — **not mine** (see below) |
| `npx eslint src tests` | **0 errors**, 1 warning — **not mine** |
| `npm run test:e2e` | not run — group-level per the brief |

**Tasks 1 and 3 are editing this same working tree concurrently**, so the whole-repo gates pick up
their mid-flight edits. Every residual failure is theirs, and none is in a file I touched:

- the single test failure is `tests/audit-children.test.ts` (Task 3's NEW file) — its own fixture
  hits `Application_source_check`;
- the tsc error is `src/server/applications.ts(575,82)` (Task 1's file, wave-1 #69 work);
- the eslint warning is an unused `settlement` in that same file.

tsc reports every failing file, not just the first, so the absence of any diagnostic in my five
files is positive evidence they typecheck. My three suites were also run in isolation and are
green: `statements-screen` (10), `statements` (17), `receivables-routes` (43).

## Open concerns for the reviewer / close-out

- **Not widened, per the brief**: #137's residual all-failed-200 shapes (a missing published
  STATEMENT template, a corrupt `invoice_number_prefix`) are the same "failing while reporting
  success" class but are not parse errors — they remain a close-out follow-up issue, not this task.
- **No HANDOFF/spec edit made.** This is a defect fix that amends no decision or convention; the
  §15 decision log and HANDOFF backlog line for #137 belong to the group close-out. Flagging it so
  the controller confirms rather than assumes.
- The React Compiler constraint in deviations 2–3 is a real, reproducible trap for any future
  client component that both memoizes on a gate field and passes it to an extracted pure gate. It
  is documented in-file; the controller may judge it worth a line in CLAUDE.md's client-state
  paragraph at close-out.

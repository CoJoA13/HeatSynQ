# Task 3 report — Shared primitives: allocateNumber + lockCurrentRevision

## Implementation notes

Both functions were transcribed verbatim from the brief's code blocks — no logic changes. Two
adjustments the surrounding files demanded:

**Import form.** `settings.ts` had no `Prisma` import at all; added
`import type { Prisma } from "../../prisma/generated/prisma/client";` as the last import line,
copying `audit.ts`'s exact form (type-only, since `allocateNumber` only ever uses
`Prisma.TransactionClient` as a type annotation, never a runtime member of the `Prisma` namespace —
unlike `part-process-steps.ts`, which already has a non-type `import { Prisma }` because
`addStep`/`updateStep`/etc. read `Prisma.TransactionIsolationLevel.Serializable` at runtime).
`part-process-steps.ts` needed no new import — `Prisma`, `HttpError`, and `lockRevision` were
already in scope.

**Comment form.** The brief formatted both snippets as `// <filename>.ts — <explanation>` — that
prefix is the brief document's own "which file this block targets" label, not source content, so
I dropped it in both places and kept the substance. For `lockCurrentRevision` the task prompt
additionally asked to "mirror the existing comment style, tersely" — `part-process-steps.ts` gives
every exported function a `/** ... */` doc comment, so that one became a proper doc comment rather
than the brief's `//` line comment. `settings.ts` has no JSDoc precedent anywhere in the file
(`getSetting`/`setSetting`/`allSettings` are all comment-free), so `allocateNumber` kept a plain
`//` comment, matching that file's own style instead.

**Placement.** `allocateNumber` sits between `setSetting` and `allSettings` (a per-key operation,
grouped with the other per-key operations rather than the list-everything one).
`lockCurrentRevision` sits immediately after `lockRevision`, before `loadTemplate`'s doc comment —
it calls `lockRevision` directly and its own doc comment references `workingRevision`'s claim SQL,
so it reads best next to the function it wraps.

**A TypeScript question I verified rather than assumed.** `SETTINGS` is `as const satisfies
Record<string, {...default: unknown...}>`; `satisfies` preserves the narrow `as const` inference,
so `SETTINGS[key].default` for `key: SettingKey` (a plain union, not a generic type parameter) is
typed as the literal union `"" | 1000 | 5 | 3 | 480`, not `unknown`. I was not certain
`def.default as number` (a union mixing string and number literals, cast straight to `number`)
would pass TypeScript's assertion-comparability check without an intermediate `as unknown`. It
does — `npx tsc --noEmit` is clean — so no adjustment was needed; flagging only because it was a
real "might have to STOP and ask" candidate that resolved itself empirically rather than by my own
reasoning being trustworthy enough to skip the check.

**Race test design (the brief's "both orderings").** The existing "a lock landing mid-mutation"
test holds `lockRevision`'s transaction open with explicit signal promises (`hasLocked`/`release`)
and lets `updateStep` race in naturally — that works because `lockRevision` is a single exported
statement, cheap to wrap. `workingRevision` (what `updateStep` actually claims through) is private
to the module, so there is no equivalent hook to hold *its* transaction open from a test. Ordering
A (`lockCurrentRevision` claims first) mirrors the existing test exactly, substituting
`lockCurrentRevision` for `lockRevision`. Ordering B (`updateStep` claims first) fires both calls
without awaiting between starts instead — the same technique the brief specifies for
`allocateNumber`'s own concurrency test. I verified empirically (12 runs with temporary logging,
removed before commit) that this reliably lands `updateStep` first every time in this environment,
so ordering B is not flaky — but I kept a three-way assertion (amend-then-lock /
lock-then-cut / 409) rather than hardcoding the one branch actually observed, because the
guarantee under test is the row lock's correctness, not this environment's scheduling, and the
codebase's own precedent (the original test's "either ordering is acceptable" comment) treats
these races the same way.

## TDD evidence

**RED** — both test files written against the not-yet-existing exports:

```
$ npx vitest run tests/allocate-number.test.ts tests/part-process-steps.test.ts
 FAIL  tests/allocate-number.test.ts  (6 failed — "allocateNumber is not a function")
 FAIL  tests/part-process-steps.test.ts  (6 new failed — "lockCurrentRevision is not a function";
       25 pre-existing tests in the file still passed)

 Test Files  2 failed (2)
      Tests  12 failed | 25 passed (37)
```

**GREEN** — after transcribing both implementations:

```
$ npx vitest run tests/allocate-number.test.ts tests/part-process-steps.test.ts
 ✓ tests/part-process-steps.test.ts (31 tests) 1897ms
   ✓ part process steps: the revision-cut rule > a lock landing mid-mutation cannot leave the locked revision modified  352ms
   ✓ part process steps: lockCurrentRevision > lockCurrentRevision landing mid-mutation cannot leave the locked revision modified  338ms
 ✓ tests/allocate-number.test.ts (6 tests) 226ms

 Test Files  2 passed (2)
      Tests  37 passed (37)
```

Repeated 5x back-to-back — 37/37 every run, no flakiness. The two race tests specifically
re-verified: `-t "updateStep landing mid-lock-claim"` run 12x with a temporary `console.log` of
which branch fired, all 12 landed on "updateStep won the claim, amended in place, then got locked"
— confirming ordering B reliably exercises the reverse interleaving from ordering A rather than
coincidentally re-testing the same thing. Logging removed before commit (`grep console\.` on both
test files returns nothing).

**Full gates, final run:**

```
$ npm test
 Test Files  63 passed (63)
      Tests  632 passed (632)          # 620 baseline + 12 new

$ npx tsc --noEmit
(clean, exit 0)

$ npx eslint src tests
(clean, exit 0)

$ npm run build
(succeeds, standalone output produced)
```

Baseline before this task (confirmed by running the suite untouched first): 62 files / 620 tests,
matching the stated starting point.

## Files changed

- `erp/src/server/settings.ts` — `allocateNumber` (+15 lines)
- `erp/src/server/part-process-steps.ts` — `lockCurrentRevision` (+16 lines)
- `erp/tests/allocate-number.test.ts` (new, 6 tests)
- `erp/tests/part-process-steps.test.ts` — new `describe("part process steps: lockCurrentRevision")`
  block (+137 lines, 6 tests) plus the one-line import addition

Commit: `3ca4cd5` — `feat: allocateNumber and lockCurrentRevision primitives` (no attribution
trailer, per the owner's 2026-08-01 instruction). Working tree clean after commit; only the
pre-existing untracked `.claude/` and `.vscode/` remain (present before this task started, not
touched by it).

## Self-review

**Completeness** — every brief bullet has a test:
- allocateNumber: seed default + persisted increment (one test, both assertions); sequential N,
  N+1; concurrent-distinct-consecutive (fired unawaited); no audit row; rejects an unknown key
  (two tests — status 400, and `instanceof HttpError`).
- lockCurrentRevision: 400 on no revision; 400 on a revision with zero steps; returns highest
  revisionNumber + sets lockedAt (built a two-revision scenario specifically to prove "highest",
  not just "the only one"); idempotent, no second audit row; the 2C-3 race regression, both
  orderings (two tests).

**Quality** — Re-read both diffs fresh after implementing. Doc comments cross-checked against
what they claim: `lockCurrentRevision`'s comment says "same claim SQL as workingRevision" — I
diffed the two `$queryRaw` blocks by eye to confirm they select the same target row, differing
only in the extra `revisionNumber` column `lockCurrentRevision` also needs. No stray edits outside
the two functions and their tests (confirmed via `git diff --stat` before staging — exactly the
four files, +219/-0).

**Discipline (YAGNI)** — nothing added beyond the two functions and their tests. Neither function
is wired into a route or caller yet — both are exported and unused outside their own test files,
matching the brief (these are primitives for later tasks in the phase, same as `lockRevision`
itself sat unused for one whole phase per its own doc comment).

**Testing** — every test hits the real `erp_test` database through `prisma.$transaction`, nothing
mocked. `allocateNumber`'s "writes no audit row" test counts `prisma.auditLog` directly rather
than trusting the implementation's own claim. The idempotency test for `lockCurrentRevision`
asserts audit-row *count* before/after (not just "no error"), same pattern as the existing
`lockRevision` idempotency test. No `.only`/`.skip`/`console.*` left in either test file (checked
by grep before commit). Output is pristine — no warnings, no unhandled rejections — across five
repeated full runs of both new/touched files and one full 632-test suite run.

## Concerns

1. **Ordering B's three-way assertion has two branches never observed in this environment** (see
   Implementation notes) — only "updateStep wins the claim" fired across 12 trials here. This is
   expected (both calls go through the same connection pool and `updateStep` is fired first in
   program order, so it reliably reaches Postgres first on this box), not a defect, but it means
   the "lockCurrentRevision wins" and "409" branches are currently unverified-by-execution, only
   verified-by-reasoning. If a future CI environment's scheduling ever differs, those branches
   would start executing for the first time — worth knowing if this test is ever investigated for
   flakiness later.
2. **`allocateNumber`'s type signature accepts any `SettingKey`, not just the five `*_number_next`
   keys** — calling it with e.g. `"company_name"` would compile (the union-cast `as number` covers
   it) but misbehave at runtime (`current + 1` on a string). Not tested, because the brief names no
   such test and every real caller in this phase only ever allocates a numbering key — flagging in
   case a future task calls it with the wrong key by mistake; a `key extends NumberSettingKey`
   narrower type would close this but is a scope decision beyond what the brief asked for.
3. Node version: this environment's default shell `node` is v22.23.1; the project pins `>=26`.
   Every command in this report ran after resolving `/home/cojoa13/.nvm/versions/node/v26.5.1/bin`
   onto `PATH` explicitly (shell state doesn't persist between tool calls here) — flagging in case
   it's not already known, not something this task changed.

No other deviations from the brief's exact signatures/rules.

## Fix round 1 (Task 3 review)

Two Important findings. Both fixed; Minors deliberately left untouched (recorded elsewhere, out
of this round's scope).

### Finding 2 — missing part guard (fixed first; simpler, and Finding 1's new test needed the
final implementation to test against)

`lockCurrentRevision` was missing the part-existence/soft-delete guard every sibling in the file
opens with (`workingRevision`'s own first line). Added, verbatim:

```ts
const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
if (!part) throw new HttpError(404, "Part not found");
```

as the new first two statements of `lockCurrentRevision`, before the existing claim query.

**Two new tests** in the `lockCurrentRevision` describe block: unknown `partId` → 404 "Part not
found"; a soft-deleted part whose revision still has a step → 404, and the revision's `lockedAt`
stays `null` (read via a raw `findFirstOrThrow`, since `getRevision` itself 404s on a soft-deleted
part and can't be used to inspect the row).

**RED, reproducing the exact review-described bug** (guard temporarily removed, both new tests run
alone):

```
$ npx vitest run tests/part-process-steps.test.ts -t "404s"
 FAIL  … 404s "Part not found" for an unknown partId
   AssertionError: expected Error: This part has no process steps { status: … } to match object { status: 404, … }
   - Expected: { "message": "Part not found", "status": 404 }
   + Received: HttpError { "status": 400 }

 FAIL  … 404s a soft-deleted part with a step-bearing revision, and never locks it
   AssertionError: promise resolved "{ revisionNumber: 1 }" instead of rejecting
   - Expected: Error { "message": "rejected promise" }
   + Received: { "revisionNumber": 1 }

 Tests  2 failed | 2 passed | 29 skipped (33)
```

This is exactly the two symptoms the finding named: the wrong (400, not 404) message for an
unknown part, and a soft-deleted part's revision actually getting locked. Guard restored,
**GREEN**:

```
$ npx vitest run tests/part-process-steps.test.ts -t "lockCurrentRevision"
 ✓ tests/part-process-steps.test.ts (33 tests | 25 skipped) 676ms
      Tests  8 passed | 25 skipped (33)
```

### Finding 1 — the race tests don't discriminate the FOR UPDATE

**The comment fix** (`tests/allocate-number.test.ts:24-26`, no code change): reworded away from
claiming the FOR UPDATE is "what has to serialize these" — the concurrency test doesn't isolate
that claim, it only observes the outcome (two concurrent allocations never collide or skip). New
wording says exactly that and says explicitly that it does not by itself prove the mechanism.

**The discriminating test — first attempt, tried and discarded.** I initially transcribed the
finding's literal recipe: an explicit holder transaction takes the same
`SELECT "id" FROM "PartProcessRevision" … FOR UPDATE`, holds it; `lockCurrentRevision` is started
and raced against a 200ms timer, asserting it has not settled; the holder releases;
`lockCurrentRevision` is awaited and asserted to complete with the revision locked.

Before trusting it, I ran the same sanity-check protocol the finding asks for on *this* attempt —
and it failed the sanity check. With `lockCurrentRevision`'s `FOR UPDATE` deleted (`SELECT`
unchanged otherwise), the test **still passed**:

```
$ npx vitest run tests/part-process-steps.test.ts -t "blocks on the row lock"
   (FOR UPDATE deleted from lockCurrentRevision's claim)
 ✓ tests/part-process-steps.test.ts (34 tests | 33 skipped) 335ms
   ✓ … lockCurrentRevision blocks on the row lock while another transaction holds it  335ms
 Tests  1 passed | 33 skipped (34)
```

Reason, confirmed by this run rather than assumed: `lockCurrentRevision` calls `lockRevision`
immediately after its claim, and `lockRevision`'s own `updateMany` is a real write against the
*same* row. Any write to a row a holder has FOR-UPDATE-locked blocks until the holder releases,
independent of whether the reader that led to that write took its own lock first. So with the
holder just sitting on the row and never writing anything, `lockCurrentRevision`'s overall promise
fails to settle within 200ms whether or not its own claim has `FOR UPDATE` — the downstream write
provides accidental cover. The finding's literal recipe is correct in spirit but not sufficient
against *this* function's specific control flow (claim immediately followed by a write to the same
row); discarded rather than kept as decoration.

**The replacement, designed to break that cover.** Instead of a bare holder, the holder claims the
row, signals, waits, and — only once released, still inside the same transaction before
committing — deletes the revision's one step. This turns the discriminator from a timing question
into a data-correctness one:

- With the FOR UPDATE genuinely in effect, the claim itself is what blocks. It cannot read past
  the holder, so by the time it does, the delete is committed — the step-count check runs on fresh
  (zero) data and `lockCurrentRevision` correctly 400s. The revision is never locked.
- Without it, the claim reads immediately, *before* the holder's delete is even issued, sees
  stepCount 1, and proceeds into `lockRevision`. That write still blocks on the holder (same
  mechanism as the discarded attempt) — but once unblocked, `lockRevision`'s `updateMany` only
  ever guards on `lockedAt: null`, not step count, so it succeeds anyway. The revision ends up
  locked despite having zero steps as of the moment that write lands.

The bounded 200ms wait is kept, but reframed in the test's own comment as scaffolding, not the
discriminator: its job is only to guarantee `lockCurrentRevision`'s claim has actually been
dispatched (and, in the buggy case, has already read stale data) before the holder is released —
without it, JS/Prisma scheduling could let the holder's release-and-delete run before
`lockCurrentRevision` even starts reading, which would erase the stale-vs-fresh distinction the
test depends on.

**Sanity check on the replacement — GREEN with the fix in place:**

```
$ npx vitest run tests/part-process-steps.test.ts -t "cannot lock a revision that loses its last step"
 ✓ … lockCurrentRevision cannot lock a revision that loses its last step while the claim is held  335ms
 Tests  1 passed | 33 skipped (34)
```

**FOR UPDATE deleted again — this time the test correctly FAILS:**

```
$ npx vitest run tests/part-process-steps.test.ts -t "cannot lock a revision that loses its last step"
   (FOR UPDATE deleted from lockCurrentRevision's claim)
 FAIL … lockCurrentRevision cannot lock a revision that loses its last step while the claim is held
   AssertionError: promise resolved "{ revisionNumber: 1 }" instead of rejecting
   - Expected: Error { "message": "rejected promise" }
   + Received: { "revisionNumber": 1 }
 Tests  1 failed | 33 skipped (34)
```

Confirms the design: without the claim's lock, `lockCurrentRevision` incorrectly succeeds and
locks a revision that, by the time its write lands, genuinely has zero steps — the exact class of
bug the FOR UPDATE exists to prevent. Restored (`git diff` against the prior commit shows only the
two-line Finding 2 guard on this file — confirmed below), **GREEN**.

I kept both original race tests (ordering A and B) alongside this one rather than deleting them —
they still cover a real, different property (no corruption under either arrival order for the
`lockCurrentRevision`/`updateStep` pair), just not specifically the claim's own lock. Only the
first, non-discriminating *replacement attempt* was discarded, not the pre-existing pair.

### Verification, this round

```
$ npx vitest run tests/part-process-steps.test.ts tests/allocate-number.test.ts
 Test Files  2 passed (2)
      Tests  40 passed (40)          # 37 previous + 3 net (2 Finding-2 + 1 discriminating test)
```

Repeated 5x back to back — 40/40 every run, no flakiness.

```
$ npm test
 Test Files  63 passed (63)
      Tests  635 passed (635)        # 632 previous + 3 net

$ npx tsc --noEmit
(clean, exit 0)

$ npx eslint src tests
(clean, exit 0)
```

`git diff --stat` for this round: `src/server/part-process-steps.ts` +2/-0 (the Finding 2 guard
only — `settings.ts` untouched, Finding 1 needed no production code change);
`tests/part-process-steps.test.ts` +88/-0 net; `tests/allocate-number.test.ts` +5/-3 (comment
reword only).

### Files changed, this round

- `erp/src/server/part-process-steps.ts` — Finding 2's part guard (+2 lines)
- `erp/tests/part-process-steps.test.ts` — 2 Finding-2 tests + 1 discriminating race test
  (replacing one discarded non-discriminating attempt, net +88 lines / 3 tests)
- `erp/tests/allocate-number.test.ts` — comment reword only, no test/assertion change

Commit: `6a23b0d` — `fix: lockCurrentRevision part guard + discriminating row-lock regression` (no
attribution trailer). 3 files, +95/-3.

### Concerns carried forward from the original report

Unchanged and still applicable: (1) the ordering-B race test's two non-"mutation-wins" branches
remain unexercised in this environment; (2) `allocateNumber`'s type signature still accepts any
`SettingKey`; (3) Node version note. Nothing in this fix round changes those.

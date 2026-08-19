# Task 4 report — #32 (pg@9 tripwire) + #35 (per-model sweep scoping)

Implementer: fresh subagent, 2026-08-18. Branch `group-f-infra`.

## Files touched (only these)

- `erp/tests/helpers/setup.ts` — one word: `const SUPPRESSED_PG_DEPRECATION` → `export const` (line 30). No behavior change; the filter body is untouched.
- `erp/tests/pg-forward-hazard.test.ts` — NEW, DB-free, the sweep style (#32).
- `erp/tests/partial-unique-sweep.test.ts` — per-model scoping refactor, `ALLOWED_CALLS` deleted entirely (#35).
- this report.

## #35 — RED → GREEN

**RED (watched):** deleted the two `ALLOWED_CALLS` entries under the OLD global matching and ran
`npx vitest run tests/partial-unique-sweep.test.ts`. Exact failure:

```
FAIL  tests/partial-unique-sweep.test.ts > partial unique sweep > no findUnique, findUniqueOrThrow, upsert, update, or delete is keyed on a live-rows-only unique column
AssertionError: Use findFirst({ where: { <col>, deletedAt: null } }) instead — …
- []
+ [
+   "src/server/order-drafts.ts: .findUnique({ where: { userId … } })",
+   "src/server/order-drafts.ts: .upsert({ where: { userId … } })",
+ ]
 ❯ tests/partial-unique-sweep.test.ts:90:28
 Test Files  1 failed (1) / Tests  1 failed | 1 passed (2)
```

Exactly the two order-drafts call sites the recon predicted — SavedView's partial
`@@unique([userId, name], where: …)` contributing bare `userId` to the global union,
mis-matching OrderDraft (plain `@unique`, no `deletedAt`).

**GREEN (watched):** implemented the recon's prototyped design; `ALLOWED_CALLS` stays deleted.
`2 passed (2)` — the pass is proof the scoping did the work, not that the calls stopped
matching: RED shows both sites DO match the widened where-key pattern and their column IS in
the global union, so passing without an allowlist is only reachable through the captured
`orderDraft` receiver scoping to OrderDraft's empty partial set.

**Design as landed** (`tests/partial-unique-sweep.test.ts`):

- `partialUniqueColumnsByModel(): Map<string, Set<string>>` (:17) — same inner `@@unique` regex
  (:21) and the same compound-key `a_b` handling; only WHERE columns are stored changed.
- Guard rail preserved as the global union: `globalUnion` (:63) with
  `expect(globalUnion.size).toBeGreaterThan(0)` (:64) — same "worthless if the parse silently
  fails" semantics as the old `partial.size` check. The second test's
  `softDeletable.length > 0` rail is untouched.
- `byDelegate` (:81–84): EVERY model gets an entry keyed by first-letter-lowercased delegate
  name; models with no partial columns map to an empty set — that empty set is exactly what
  clears a known-but-unaffected delegate (OrderDraft).
- Widened call-site regex (:90):
  `/(?:\.(\w+))?\.(findUnique|findUniqueOrThrow|upsert|update|delete)\(\s*\{\s*where:\s*\{\s*(\w+)/g`
  — optional receiver capture. Captured + known delegate → that model's set; uncaptured or
  unknown → global-union fallback (:92). Multi-line-receiver residual stated in the comment
  (:76–80): `prisma.orderDraft\n.findUnique(` captures nothing and falls back — conservative
  direction, still flags.
- Deliberately NOT touched: the parse regexes themselves (the one-line `@@unique(` assumption
  is a documented HANDOFF §5.11 dependency — storage changed, parsing did not), and the second
  test's `ALLOWED` set (owner-ruled plain-`@unique` exemptions — all survive verbatim).

**Detection-strength probe** (scratchpad script, real schema-derived sets, synthetic call
sites) — all five as designed:

```
OK  real offender via known delegate: flagged=true (expected true)          prisma.role.findUnique({ where: { name } })
OK  same column, unrelated known delegate: flagged=false (expected false)   prisma.orderDraft.findUnique({ where: { userId } })
OK  uncaptured receiver, fallback flags: flagged=true (expected true)       delegate.findUnique({ where: { name } })
OK  unknown captured receiver, fallback: flagged=true (expected true)       someRepo.thing.update({ where: { code } })
OK  multi-line receiver residual: flagged=true (expected true)              prisma.orderDraft\n  .findUnique({ where: { userId } })
```

## #32 — tripwire + proof of both failure paths

`tests/pg-forward-hazard.test.ts` (NEW): DB-free; imports `SUPPRESSED_PG_DEPRECATION` from
`./helpers/setup` (:5 — a module-cache hit; setup.ts already ran as the vitest setupFile, and
even a hypothetical re-run only re-wraps a filter that forwards everything non-suppressed).

- (a) MAJOR check (:38–52): `createRequire(import.meta.url)("pg/package.json").version`
  (pg's exports map exposes `./package.json`; resolves the installed 8.22.0), fails at
  `major >= 9` with a message naming issue #32, tests/helpers/setup.ts's emitWarning filter,
  and the premise (pg@9 removes deprecate-and-queue; may turn cosmetic into correctness).
- (b) suppression-still-real check (:54–69): `node_modules/pg/lib/client.js` (resolved as a
  sibling of `pg/package.json`) must contain the exported literal.
- File-top comment (:7–33) records WHY, the deliberately-skipped dynamic provocation
  (threshold-coupled, adapter-internal, DB-dependent), and the manual sourcemap re-check
  procedure the recon used (recover `query-interpreter.ts` from
  `@prisma/client/runtime/client.js.map` sourcesContent; look for the `case 'join'`
  `Promise.all(node.args.children.map(...))`) — documented rather than asserted, to avoid
  coupling the suite to Prisma shipping sourcesContent.

**Genuine RED is impossible for (a)** without a pg@9 install (adapter-pg's `^8.16.3` can never
resolve there). Failure paths therefore PROVEN by temporary edit, watched, restored:

| Check | Temporary edit | Watched output (exact) |
|---|---|---|
| (a) major | `toBeLessThan(9)` → `toBeLessThan(8)` | `AssertionError: pg resolved to 8.22.0. pg@9 removes the deprecate-and-queue path for overlapping client.query() calls on one connection — the very behavior @prisma/adapter-pg's concurrent sibling relation loads rely on, and the premise of the DeprecationWarning suppression in tests/helpers/setup.ts (its process.emitWarning filter). Under pg@9 that suppression is at best dead and at worst hides a correctness failure (overlap may throw instead of queue). Before upgrading: re-run the interpreter re-check documented at the top of this file, then remove or rework the setup.ts filter per its REMOVE note. Tracked as issue #32.: expected 8 to be less than 8` |
| (b) literal | assert `"BOGUS LITERAL THAT PG NEVER EMITS"` | `AssertionError: pg's lib/client.js no longer contains the deprecation message that tests/helpers/setup.ts suppresses ("Calling client.query() when the client is already executing a query"). The filter is stale — either pg dropped/reworded the warning (delete or update the filter) or the deprecation became an error (see issue #32).: expected false to be true` |

Both restored; final file carries `toBeLessThan(9)` and the exported literal.

## Gates (from erp/, all watched)

| Gate | Result |
|---|---|
| `npx vitest run tests/partial-unique-sweep.test.ts tests/pg-forward-hazard.test.ts` | `Test Files 2 passed (2) / Tests 4 passed (4)` |
| `npx tsc --noEmit` | exit 0, no output |
| `npx eslint tests` | exit 0, no output |

(Not run per brief: full suite, E2E — close-out's job. tsc necessarily typechecked the whole
tree, which was green even with the three concurrent tasks' in-flight edits present.)

## Reviewer attention

1. The GREEN-without-allowlist inference above (RED proves the sites match + column is in the
   union; GREEN therefore proves receiver capture + empty-set scoping) is the load-bearing
   argument that #35's pass is not vacuous.
2. `byDelegate` deliberately includes models with NO partial columns (empty set) — removing
   that `?? new Set()` and only mapping models present in `byModel` would send known-but-clean
   delegates to the global-union fallback and re-create the OrderDraft false positive.
3. The offender label format is unchanged (no receiver in it) — kept to minimize churn; the
   receiver is capture-only.
4. setup.ts's diff is exactly one `export` keyword; the tripwire file is the only new importer.
5. `pg-forward-hazard.test.ts` reads `lib/client.js` off `require.resolve("pg/package.json")`
   rather than `require.resolve("pg")` — pg's exports map exposes `./package.json`, and the
   package-root-relative join is stable across pg's internal entry-point layout.

# Task 2 — #40: db-errors reads the driver-adapter constraint shapes · implementer report

**Commit:** `50ed054` on `group-f-infra`. Two files only — `erp/src/server/db-errors.ts` +
`erp/tests/db-errors.test.ts` — no schema change, no new file, no route touched.

## What was built

### The two extractors (`erp/src/server/db-errors.ts`)

Both **legacy-first, adapter-fallback** (the `isDuplicateClientRequestId` precedent and its
documented rationale — a future adapter that populates the legacy keys wins), every read
`unknown`-typed and narrowed through the shared `AdapterMeta` shape (:9–17, the
`isRawRetryableFailure` style), never throwing:

- **`uniqueConflictFields`** (:31–44): `meta.target` (string[] **or** string — see reviewer note
  1) → `cause.constraint.fields`, with `stripQuotes` (:21) removing the one layer of surrounding
  `"` the adapter's DETAIL-line parse leaves on mixed-case identifiers. Empty arrays return
  undefined (see reviewer note 3). Wired into the P2002 branch at :150:
  `opts.conflictField ?? uniqueConflictFields(err)?.join(", ") ?? "value"` — `conflictField`
  still always wins, so every caller passing it is byte-identical.
- **`fkConstraintName`** (:51–63): `meta.constraint` → `cause.constraint.index` (the measured
  P2003 carrier — the key is `index`, not `fields`) → last-resort
  `/foreign key constraint "([^"]+)"/` on `cause.originalMessage`.

### `readableFkField` (:84–100)

Now reads its constraint name from `fkConstraintName`; the prefix/suffix check and the
`Id`-strip + letters-only guard + humanize run unchanged (the latter three extracted verbatim
into `humanizeFkField` :66–70 so the adapter's `{ fields: [column] }` FK variant — emitted when
pg sets `error.column`, carrying the column NAME directly rather than a constraint name — maps
through the identical humanize as a fallback branch when the name parse yields nothing).
Delete-direction violations keep the generic text by design (parent `modelName` vs child-table
constraint name — prefix check fails), now stated in the doc comment.

### Comment touch-points (same commit)

- db-errors.ts retry-scope comment (was :113–114): the claim that constraint-name discrimination
  "is unavailable on the driver-adapter stack (#40)" is no longer true, so the per-call-site
  boolean is restated on its own merits — whether a P2002 means "a concurrent writer won, a
  re-run will see its row" is a fact about the call site's insert semantics, not about which
  constraint fired.
- tests/db-errors.test.ts mirror comment (was :90–94): same restatement.
- The `violatedCheckConstraint` doc's "the #40 shape" reference (:59–60 pre-fix) stays — still
  accurate.

**Not touched, per the brief:** `violatedCheckConstraint`, `isDuplicateClientRequestId`
(orders.ts), `isRawRetryableFailure`, `isRetryableConflict`'s logic, all retry machinery.

## RED table (watched before implementing; the five brief-mandated tests)

| Test | RED reason observed |
|---|---|
| (1) real P2002, no conflictField, `Role.name` | **`A role with that value already exists`** received vs `…that name…` expected |
| (2) real camelCase P2002, `Session.tokenHash` | **`A session with that value already exists`** — `expected '…' to contain 'tokenHash'` |
| (3) real P2003, `paymentType.create` bogus `glAccountId` (delegate direct — the service pre-check would mask it) | **`That reference does not exist`** received vs `That gl account does not exist` expected |
| (4) synthetic legacy shapes | **`TypeError: err.meta?.target?.join is not a function`** — the string-target sub-case CRASHED today's translator (see reviewer note 1); the array-target and legacy-P2003 sub-cases were green pre-fix |
| (5) synthetic P2002, neither shape → "value" | Green pre-implementation (expected — it pins today's fallback so the fix can't regress it; the "never throws" direction) |

The existing legacy-shape synthetic (`meta.target: ["year","month"]` in the #90 describe) kept
untouched as the legacy regression. Post-fix: `tests/db-errors.test.ts` **16/16 green**.

## User-visible messages that changed

Recon §3's analysis holds: `conflictField` callers and service pre-checks are unchanged — only
the **race/backstop** paths speak differently:

- P2002 `A <entity> with that value already exists` → field-named, for entity-only
  `withDbErrors` callers: `closePeriod` after retry exhaustion ("…that year, month…"),
  `setCustomerSurcharges` ("…that customerId, surchargeId…" — quotes stripped),
  part-field-values, `printBol`/`createCredit` allocation collisions.
- P2003 `That reference does not exist` → `That <field> does not exist` wherever the constraint
  parses as `${modelName}_${field}_fkey` (insert/update-direction races past a pre-check).
  Delete-direction keeps the generic text (by design, unchanged semantics).
- Recon verified zero existing tests pin either generic fallback; the run below confirms.

## Gate results

| Gate | Result |
|---|---|
| `npx vitest run tests/db-errors.test.ts` (real erp_test DB) | **16 passed** (was 12; +5 new, −1 none removed — the 5 new tests, one file) |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint src tests` | clean (exit 0) |

Per the brief: not the full suite, not E2E (owed at group close-out).

## Reviewer-attention items

1. **RED exposed a latent crash in today's code**: a legacy `meta.target` arriving as a plain
   string (Rust-engine P2002s can carry either) blew up the old
   `(err.meta?.target as string[] | undefined)?.join(", ")` cast with
   `TypeError: err.meta?.target?.join is not a function` — an error-translation path that itself
   throws. The `unknown`-narrowing fixes it as a side effect; test 4's string-target sub-case
   pins it.
2. **Legacy-first is pinned adversarially**, not just by legacy-only shapes: test 4's synthetics
   carry BOTH shapes with *disagreeing* values (`target: ["name"]` vs adapter
   `['"somethingElse"']`; `meta.constraint` vs a different `cause.constraint.index`) and assert
   the legacy value wins.
3. **Two deliberate micro-hardenings beyond the brief's letter**: empty-array `target`/`fields`
   return undefined (else `.join` yields `""` → "A role with that  already exists"), and the
   quote-strip applies only where quotes can occur (adapter fields; legacy `target` passes
   through untouched, keeping legacy behavior byte-identical).
4. **`readableFkField` was restructured** (name extraction + humanize split out) rather than
   patched in place — the brief's "runs unchanged" holds behaviorally (same prefix/suffix
   checks, same guard regex, same humanize, verified by the legacy-P2003 synthetic passing
   pre- and post-fix), and the split is what lets the `{fields:[column]}` variant share the
   humanize instead of duplicating it. The variant is reached only when no constraint name
   parses — on the measured stack the name is essentially always recoverable
   (`index` or `originalMessage`), so it is a belt-and-suspenders branch.
5. The P2003 real-DB test calls `prisma.paymentType.create` directly by design (brief): the
   service path pre-checks via `assertRefExists` and would 400 before the constraint fires.

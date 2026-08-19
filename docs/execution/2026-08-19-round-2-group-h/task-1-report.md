# Task 1 report — #24 + #9, audit snapshot fidelity

Branch `group-h-polish`. Two behavioral commits + this report; TDD (RED watched) for both parts.
Files owned exclusively: `erp/src/server/audit.ts`, `erp/tests/snapshot-order-sweep.test.ts`,
`erp/tests/audit-claim.test.ts`. No other file touched.

## Part A — #24, ordered snapshot collections (commit 9afba47)

Three unordered list-relations produced spurious History diffs (HistoryPanel's whole-key
`JSON.stringify` comparison is order-sensitive). Fixed at snapshot CAPTURE, matching every
ordered include already in the file:

- `audit.ts:37` — `role.permissions` → `orderBy: { permission: "asc" }` (`permission` unique
  within a role via `@@unique([roleId, permission])`, so it orders alone).
- `audit.ts:60` — `processStepCode.fields` → `orderBy: [{ sort: "asc" }, { id: "asc" }]` —
  `sort` matches the live read (`listStepCodes`, process-step-codes.ts:73); `sort` is not unique
  within a code, so `id` breaks ties deterministically.
- `audit.ts:42` + `audit.ts:361` — `user.overrides` in BOTH `SNAPSHOT_INCLUDE.user` and
  `SNAPSHOT_SELECT.user` → `orderBy: { permission: "asc" }`. The SELECT entry is the one user
  snapshots actually take (the signatureImage exclusion); the recon find the issue body doesn't
  name. Cross-referencing comments on both entries so they can't drift apart silently.
- `audit.ts:332` — `SNAPSHOT_SELECT` is now exported so the sweep can walk both maps (a list
  relation projected through a `select` carries an unordered collection exactly as an `include`
  does); `SNAPSHOT_INCLUDE`'s exported-for comment now names both tests.

**The sweep** (`erp/tests/snapshot-order-sweep.test.ts`): parses `prisma/schema.prisma` TEXT for
relation fields (`name Type[]` lines filtered to Type ∈ model names — the partial-unique-sweep
precedent; the v7 client exposes no runtime DMMF), recursively walks `SNAPSHOT_INCLUDE` +
`SNAPSHOT_SELECT` through nested `include`/`select` clauses into the related model, and asserts
every list-relation key maps to an object carrying `orderBy`. Parse-sanity guards in the
precedent's style (relation map non-empty; walk visited > 0 lists). A second test pins that
every `AuditableModel` key maps to a schema model by uppercasing its first letter — which also
backs Part B's table-name derivation. Behavioral pin: `setRolePermissions` with the same set in
two delivery orders → the second entry's before/after permission-key arrays compare equal
(per-key, since delete/recreate legitimately mints new row ids).

**RED evidence** (watched before the fix):

```
+ [
+   "SNAPSHOT_INCLUDE.role.permissions (Role.permissions: RolePermission[])",
+   "SNAPSHOT_INCLUDE.user.overrides (User.overrides: UserPermissionOverride[])",
+   "SNAPSHOT_INCLUDE.processStepCode.fields (ProcessStepCode.fields: ProcessStepFieldDef[])",
+   "SNAPSHOT_SELECT.user.overrides (User.overrides: UserPermissionOverride[])",
+ ]
```

Exactly the three entries, `user.overrides` flagged in both maps. Judgment note: the behavioral
pin PASSED pre-fix (a three-row table's scan order happened to agree) — the sweep is the RED
driver; the pin pins the post-fix guarantee, which is deterministic by construction (both sides
sorted by `permission`), not the pre-fix failure.

## Part B — #9, claim-before-snapshot (commit ecb6d43)

`auditedUpdate` read its before-snapshot, ran `doIt`, read its after-snapshot — a concurrent
committed write to the same row landed inside the after-snapshot, so each entry's diff absorbed
the other edit's field. Fix is generic, at the two seams:

- `audit.ts` `claimAuditedRow` — `SELECT "id" FROM "<Table>" WHERE "id" = $1 FOR NO KEY UPDATE`
  via `db.$queryRaw` with `Prisma.raw` for the identifier and the id as a bound parameter.
  `model` is compiler-constrained to the `AuditableModel` union AND runtime-validated against
  `SNAPSHOT_INCLUDE`'s key set (`Record<AuditableModel, …>` — its keys are the model list)
  before the identifier is inlined; the table name is the key with its first letter uppercased
  (no `@@map` in the schema; pinned by the sweep's mapping test). The doc comment preserves the
  required notes: doIt's mutation takes this same row lock in this same tx, so the deadlock
  surface is unchanged — the claim only acquires it EARLIER; already-claimed families
  (order/invoice/quote/template/revision) re-lock a row their tx holds (no-op); Serializable
  callers see a locking read whose 40001 their existing retry wrappers already handle; a missing
  id locks nothing and throws nothing, preserving the existing null-snapshot / count-0 paths.
- The claim is the first statement of `auditedUpdate` and `auditedSoftDelete`, before the
  before-snapshot. `auditedCreate` untouched (no before-snapshot, fresh row). `Prisma` flips
  from a type-only to a value import for `Prisma.raw` (the customers.ts style).

### The one deviation from the brief — FOR NO KEY UPDATE, not FOR UPDATE

The brief specified `FOR UPDATE`. Implemented that way, `tests/customers.test.ts`'s
"cannot form a reciprocal parent cycle from two concurrent updates" deterministically timed out
(flagged by the Task 3 implementer from a clean worktree; reproduced 5.0s→timeout on an
isolated scratch DB). Diagnosed live off `pg_locks`/`pg_stat_activity` during the hang:

- Each transaction claimed its OWN row `FOR UPDATE`, then its `UPDATE … SET parentId = <other>`
  fired the self-FK's RI trigger, which probes the REFERENCED row with `FOR KEY SHARE` —
  and `FOR KEY SHARE` conflicts with `FOR UPDATE` (and nothing weaker). Each tx blocked on the
  other's xid: a genuine ABBA deadlock through Postgres's own trigger. The deadlock detector
  resolved each collision after `deadlock_timeout` (~1s; observed xids advancing between
  samples), so ten test iterations accumulated ~10s and the 5s test cap fired. NOT a
  claim-vs-claim ordering problem — the RI probe is inside Postgres's trigger, so the
  `claimOrdersInOrder` discipline cannot reach it.
- Pre-fix there was no conflict at all: a non-key-column UPDATE takes only `FOR NO KEY UPDATE`,
  which is compatible with `FOR KEY SHARE`; SSI resolved the reciprocal race at commit.

So the claim uses `FOR NO KEY UPDATE` — exactly the lock strength every audited non-key
mutation (scalar patches, `deletedAt` stamps) already takes. Writers of the same row still
mutually exclude (`NO KEY UPDATE` conflicts with itself — the #9 guard holds; the parked
interleave test still shows B blocking at the claim), and RI probes pass exactly as they always
did — which is what makes the brief's "deadlock surface unchanged" note TRUE rather than
aspirational. The invariant test was not touched, not weakened, and passes as before via SSI
(52/52 in customers.test.ts). The rationale is recorded in `claimAuditedRow`'s doc comment.

**Tests** (`erp/tests/audit-claim.test.ts`) — deterministic, never racing:

1. Unit interleave: transaction A enters `auditedUpdate("customer", …)` whose `doIt` parks on a
   deferred before its own write; transaction B then runs a COMPLETE `auditedUpdate` patching a
   different field of the same row. The parked deferred forces B into A's snapshot window every
   run (RED deterministic); post-fix B blocks at the claim, and the assertion holds under ANY
   interleaving. The assertion is exact changed-key sets per entry (`updatedAt` included, since
   @updatedAt bumps on every write): A = `["name","updatedAt"]`, B = `["defaultPo","updatedAt"]`.
   Dual-transaction shape copied from quote-delete-races.test.ts (immediate handlers, 20000ms
   timeouts, real helpers never paraphrases, raw-prisma fixtures). Comment records that vitest's
   default Read Committed is FINE here — the row claim guards at any isolation.
2. Service-level: two concurrent `updateCustomer` calls patching `name` / `defaultPo`; both
   entries' changed-key sets are exactly their own field + `updatedAt`, and both writes landed.

**RED evidence** (watched before the fix):

```
FAIL  unit: a complete auditedUpdate committing inside a parked one's snapshot window …
AssertionError: expected [ 'defaultPo', 'name', 'updatedAt' ] to deeply equal [ 'name', 'updatedAt' ]
```

A's entry absorbed B's `defaultPo` — the exact #9 mechanism. The service-level race also went
red pre-fix on this hardware with the same absorbed-key shape (not guaranteed pre-fix, being a
true race; the parked test is the deterministic RED).

## Gates (from erp/)

Three implementers ran full suites concurrently against the one shared `erp_test` DB during
wave 1; concurrent `truncateAll`s stomp each other (observed: `reseedSingletons` duplicate-id
failures, TRUNCATE-vs-transaction deadlocks), so — matching Task 3's approach — my authoritative
run used a private scratch DB (`erp_test_t1`: created, `migrate deploy`, suite, dropped after).

- `npm test` (isolated, full suite, post-both-commits' content): **193 files — 192 passed,
  1 failed; 3275 tests — 3274 passed, 1 failed.** The single failure is
  `tests/quote-links.test.ts` "a link save whose snapshot predates a committed line-drop
  re-resolves" — **proven foreign by bisect**: with my `audit.ts` edit stashed it fails
  identically (deterministic 5s timeout, 3/3 solo runs). Mechanism, for whoever owns it
  (Task 3's #100 item 2 poll, landed this branch): the poll waits for an ungranted lock from a
  backend whose `pg_stat_activity.query LIKE '%order_number_next%'`, but Prisma parameterizes
  `allocateNumber`'s key — the parked query text is `SELECT "value" FROM "Setting" WHERE "key"
  = $1 FOR UPDATE`, so the LIKE never matches and the poll spins past the 5s test cap. (The
  choreography itself works: pg shows the save parked on the gate exactly as designed. A
  text-filter on `'%"Setting"%FOR UPDATE%'` — the literal parts — would match; not my file to
  edit.)
- Every suite touching my changes passed: `customers.test.ts` 52/52 (the reciprocal-cycle
  invariant intact), `audit-claim` 2/2, `snapshot-order-sweep` 3/3, `audit`/`audit-tx`/
  `certs-schema`/`roles`/`users`/`process-step-codes` 83/83.
- `npx tsc --noEmit` — clean. `npx eslint src tests` — clean. (Both re-run over the merged tree
  after wave-1 sibling commits landed.)
- E2E deliberately not run — group level per the brief.

## Judgment calls / deviations

- **`FOR NO KEY UPDATE` instead of the brief's `FOR UPDATE`** — see Part B above; the brief's
  own required invariants ("deadlock surface unchanged"; the reciprocal-cycle test's invariant
  preserved without weakening) are only satisfiable at this lock strength. Flagged explicitly
  here per the brief's deviation rule.
- `SNAPSHOT_SELECT` export: the sweep has to walk it (the third #24 entry lives there), and the
  house precedent for map-validity testing (`certs-schema.test.ts`) already exports
  `SNAPSHOT_INCLUDE` for exactly this reason. Export-with-comment, no behavior change.
- The sweep's mapping test doubles as the runtime backing for `claimAuditedRow`'s table
  derivation — one test, both consumers named in its comment.
- The behavioral pin passing pre-fix is recorded rather than forced red — making it red would
  mean asserting on Postgres scan order, which is exactly the nondeterminism #24 is about.
- The quote-links red is reported, with mechanism and bisect evidence, rather than fixed —
  `tests/quote-links.test.ts` is Task 3's surface and this task's file-ownership rule says
  touch nothing else.

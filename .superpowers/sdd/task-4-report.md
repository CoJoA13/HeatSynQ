# Task 4 report — Cert resolution chain and the freeze at order save

## What was implemented

**New file `erp/src/server/certs.ts`** — the resolver only, per the scope boundary:

```ts
export type CertResolution = { certRequired: boolean; certScope: CertScopeValue };
export async function resolveCertSettings(db: Db, customerId: string, partIds: string[]): Promise<CertResolution>
```

Implements spec §6.1 exactly:
- **Required**: `line.part.certRequired ?? customer.certRequiredDefault ?? cert_required_default`,
  evaluated per line and OR'd across every id in `partIds` — any line requiring a cert makes the
  order require one.
- **Scope**: the identical chain, read from `partIds[0]` (the lead) alone — never combined across
  lines, so a rider's disagreement never wins.
- One query for the customer's two defaults (`findFirst`, `deletedAt: null`), one query for every
  named part's two columns (`findMany`, `deletedAt: null`) — not one query per part, the
  `resolveLineParts` N+1-avoidance precedent. The two plant defaults are read via `getSetting`.
- `db: Prisma.TransactionClient` — accepts a `tx` (createOrder's own transaction) or the bare
  `prisma` client, which structurally satisfies the same type (the `readDetail` precedent in
  orders.ts, confirmed by the brief's own test calling `resolveCertSettings(prisma, …)` directly).

**`erp/src/server/orders.ts`** — freeze at save + accept edits:
- `saveNewOrder` calls `resolveCertSettings(tx, customer.id, data.lines.map(l => l.partId))` right
  after `resolveLineParts` (line validation) and before `allocateNumber`/the write, and writes
  `certRequired`/`certScope` onto the created row from that result — never from caller input.
- `CREATE` gains `customerJobNo: z.string().max(60).default("")`, written straight onto the order.
- `CONTAINER_ITEM` (shared by `createOrder`'s nested container create AND `replaceContainers`)
  gains `customerContainerId: z.string().max(60).default("")`.
- `OrderDetail`/`OrderContainerDetail` gain the new fields; `toDetail` and `auditPayload` project
  them (the create audit entry now records the resolved `certRequired`/`certScope`, not just the
  caller's raw input, and `customerContainerId`/`customerJobNo`).
- `UPDATE_ORDER` gains `certRequired: z.boolean().optional()`, `certScope: z.enum(CERT_SCOPES).optional()`,
  `customerJobNo: z.string().max(60).optional()`; `updateOrder`'s patch construction wires all
  three through with the same `!== undefined` no-op-on-omit pattern every other field uses.
  `replaceContainers`'s `createMany` now writes `customerContainerId` too.

**`erp/src/server/parts.ts`** — `FIELDS` gains `certRequired: z.boolean().nullable().optional()`
and `certScope: z.enum(CERT_SCOPES).nullable().optional()` (shared by `CREATE` and
`UPDATE = FIELDS.partial()`); `SELECT`/`PartRow`/`toRow` project both, nullable, with `certScope`
cast from the Prisma enum the way `pricePer` already is.

**`erp/src/server/customers.ts`** — `CREATE` gains `certRequiredDefault`/`certScopeDefault`,
same nullable+optional shape (reused by `updateCustomer` via `CREATE.partial()`); `SELECT`/
`CustomerRow`/`toRow` project both.

No route files needed changes — every route in this app passes the raw JSON body straight to the
service function's own zod schema (`PATCH /api/orders/[id]`, `.../containers`,
`PATCH /api/parts/[id]`, `PATCH /api/customers/[id]` all follow this "authorize, parse, delegate"
shape already), confirmed by reading each one before touching anything.

## Nullable vs `false`, verified end to end

Both the resolver test suite and the new wiring tests assert this explicitly: an explicit
`certRequired: false` on a part or customer beats an inherited `true` further up the chain, and
`null` (or an omitted key) is what falls through to the next link — never coerced to `false`
anywhere in the zod schemas, the Prisma columns, or the projections.

## Tests

### TDD evidence

**RED** — `npx vitest run tests/cert-resolution.test.ts`, run after writing `certs.ts` (Step 3) but
*before* wiring `createOrder` (Step 4):

```
✓ resolveCertSettings > lets the part beat the customer beat the plant
✓ resolveCertSettings > requires a cert when ANY line requires one
✓ resolveCertSettings > takes scope from the lead line when lines disagree
× resolveCertSettings > freezes the resolution onto the order at save
  AssertionError: expected undefined to be true
  ❯ tests/cert-resolution.test.ts:97:32
     expect(after.certRequired).toBe(true);
✓ resolveCertSettings > falls all the way through to the plant default when nothing overrides it
✓ resolveCertSettings > an explicit false on the part beats a true customer default …

Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```

Expected: the first three (and two extra) tests exercise `resolveCertSettings` in isolation, which
was already implemented per the brief's fixed interface — they pass immediately. The fourth test
exercises the *freeze at save*, which had not been wired into `createOrder` yet: `OrderDetail`
carried no `certRequired` key at all, so `after.certRequired` read `undefined`. This is genuine RED
for Step 4's actual deliverable.

**GREEN** — same command after wiring `createOrder`/`UPDATE_ORDER`:

```
✓ tests/cert-resolution.test.ts (6 tests) 334ms
Test Files  1 passed (1)
     Tests  6 passed (6)
```

### Full regression + new wiring coverage

```
npx vitest run tests/cert-resolution.test.ts tests/orders.test.ts tests/parts.test.ts \
  tests/customers.test.ts tests/certs-schema.test.ts
 ✓ tests/orders.test.ts (123 tests)      [+4 over the 119 baseline]
 ✓ tests/customers.test.ts (40 tests)    [+2 over the 38 baseline]
 ✓ tests/certs-schema.test.ts (13 tests) [unchanged — Task 2's own schema test]
 ✓ tests/parts.test.ts (18 tests)        [+2 over the 16 baseline]
 ✓ tests/cert-resolution.test.ts (6 tests) [new]
Test Files  5 passed (5)
     Tests  200 passed (200)
```

Added beyond the brief's four required `cert-resolution.test.ts` cases (still in that same file,
since the scope boundary names it as the one required test file):
- a full-plant-default fallback case (nothing overrides anything down the chain)
- an explicit-`false`-beats-`true` case, stated as its own assertion (not just inferred from the
  first "lets the part beat the customer" test, which uses `false` for a different reason —
  isolating the "beats a truthy override" case on its own)

Added to `tests/orders.test.ts` (the natural home for exercising `createOrder`/`updateOrder`/
`replaceContainers` themselves, as opposed to the resolver in isolation):
- `createOrder` freezes `certRequired`/`certScope` from the resolver and carries
  `customerJobNo`/`customerContainerId` through, including the lead-vs-rider scope disagreement
- `createOrder` defaults `customerJobNo` and `customerContainerId` to `""` when omitted, and
  `certRequired`/`certScope` to the plant defaults (`false`/`ORDER`) when nothing else overrides
- `updateOrder` PATCHes `customerJobNo`/`certRequired`/`certScope`, and a part edited *after* that
  PATCH does not silently re-resolve it (the freeze stays frozen even across a later override)
- `replaceContainers` carries `customerContainerId` through a bulk replace

Added to `tests/parts.test.ts` and `tests/customers.test.ts`: round-trip through create/update,
clear back to `null` (inherit), and default to `null` on create when omitted — for
`certRequired`/`certScope` and `certRequiredDefault`/`certScopeDefault` respectively.

### Full suite + gates

```
npm test          → 79 files, 1072 tests passed
npx tsc --noEmit   → clean
npx eslint src tests → clean
npm run build      → succeeded (route manifest includes all pre-existing routes unchanged)
```

## Files changed

- `erp/src/server/certs.ts` — new
- `erp/tests/cert-resolution.test.ts` — new
- `erp/src/server/orders.ts` — modified (CREATE/UPDATE_ORDER/CONTAINER_ITEM schemas,
  OrderDetail/OrderContainerDetail types, `saveNewOrder`, `updateOrder`, `replaceContainers`,
  `auditPayload`, `toDetail`)
- `erp/src/server/parts.ts` — modified (FIELDS, SELECT, PartRow, toRow)
- `erp/src/server/customers.ts` — modified (CREATE, SELECT, CustomerRow, toRow)
- `erp/tests/orders.test.ts` — modified (4 new tests)
- `erp/tests/parts.test.ts` — modified (2 new tests)
- `erp/tests/customers.test.ts` — modified (2 new tests)

## Self-review

**Completeness against the brief and spec §6.1**: all seven steps done. `resolveCertSettings`
matches the exact signature and both `??` chains from §6.1. The freeze happens exactly where Step 4
specifies (after line validation, before the write, inside `saveNewOrder`'s own transaction).
`customerJobNo` defaults `""`/`.max(60)` as specified. All three order fields plus
`customerContainerId` plus the four part/customer cert columns are accepted and projected.

**Naming**: every name matches the brief verbatim — `resolveCertSettings`, `CertResolution`,
`certRequired`/`certScope`, `certRequiredDefault`/`certScopeDefault`, `customerJobNo`,
`customerContainerId`.

**YAGNI**: no cert creation, no requirements/readings, no listing/void — confirmed by re-reading
`certs.ts` (39 lines of actual logic) against the scope boundary before finishing. Did not touch
`PART_PASTE_COLUMNS`/`CUSTOMER_PASTE_COLUMNS` (TSV paste) since the brief's Step 5 lists only the
JSON create/update schemas and detail projections — paste is a distinct, unmentioned surface and
extending it wasn't asked for.

**Test quality**: every new test asserts on real behavior (resolved values, round-trips,
before/after PATCH state), not just "does not throw". The `updateOrder` test specifically proves
the freeze *stays* frozen across a later part edit, which is the one behavior spec §6.1 calls out
as easy to get backwards.

**Pristine output**: `npm test`, `tsc --noEmit`, `eslint src tests`, and `npm run build` are all
clean with zero warnings.

## Concerns

- **`resolveCertSettings`'s plant-default reads run through a second DB connection while called
  from inside `createOrder`'s open Serializable transaction.** `getSetting` always uses the
  top-level `prisma` client (settings.ts has no `tx`-accepting variant), and the brief's fixed
  interface (`resolveCertSettings(db, customerId, partIds)`, no pre-fetched-settings parameter,
  called directly with `prisma` in the brief's own tests) leaves no way to route that specific read
  through `tx` instead. `createOrder`'s own existing comment on its settings reads flags "a
  second-connection read into a Serializable transaction that goes on to lock a Setting row itself
  (`allocateNumber`)" as the shape a deadlock is introduced through, and this reproduces that
  general shape. In this specific case it cannot collide with `allocateNumber`'s `FOR UPDATE` on
  `order_number_next`, because `cert_required_default`/`cert_scope_default` are different Setting
  rows that nothing else locks — so this is not the same hazard, only the same *shape* of it. I
  followed the brief's Steps 3 and 4 literally (self-contained resolver, called from inside the
  transaction) since deviating would have meant either changing the required exact signature
  (breaking Task 5's dependency on it) or not wiring `createOrder` in this task at all (contradicting
  Step 4). Documented in `certs.ts`'s own doc comment. Flagging for the owner/reviewer in case a
  different design is preferred once Task 5's shipment-scope creation is in view.
- The "Interfaces later tasks depend on" section says "Task 5 calls this from inside `createOrder`'s
  transaction, so it must accept a transaction client as `db`" — but Step 4 of *this* brief
  explicitly instructs wiring `resolveCertSettings` into `createOrder` now. I followed Step 4 (the
  literal checklist item) rather than reading the interfaces note as "defer this wiring to Task 5",
  since Step 4 is unambiguous and the freeze-at-save behavior is this task's own stated deliverable.
  No test or behavior would be needed for the freeze without this wiring existing.

## Fix round — review came back "Needs fixes" (one Important, three Minor)

### Important — plant-default reads must go through the caller's client

**Finding**: `resolveCertSettings` called `getSetting("cert_required_default")` /
`getSetting("cert_scope_default")` with no second argument, so both always went through the
top-level `prisma` client — a second, competing pool connection opened while `createOrder`'s own
Serializable transaction held its own connection open. The reviewer correctly identified this as
the identical pool-starvation shape fix-wave R4 finding 8 fixed for `printTraveler`
(`readTravelerData`, `src/server/traveler.ts`), not merely "the same shape as a hazard that
doesn't apply here" as my original report argued — `createOrder` is a much hotter path than
traveler printing, and the concern was pool exhaustion under concurrency, not lock collision.

**What changed**:
- `src/server/settings.ts` — `getSetting<K>(key, db = prisma)` now takes an optional second
  parameter, typed `Prisma.TransactionClient` (which the bare `prisma` client structurally
  satisfies, the same `readDetail`/`readTravelerData` precedent already used throughout this
  codebase). `db.setting.findUnique(...)` replaces the old hardcoded `prisma.setting.findUnique(...)`.
  Every other existing call site (`sessions.ts`, `orders.ts`, `traveler.ts`, every test) calls
  `getSetting(key)` with one argument and is completely unaffected — the parameter is additive and
  defaults to the exact prior behavior.
- `src/server/certs.ts` — `resolveCertSettings` now routes every one of its four reads (customer,
  parts, `cert_required_default`, `cert_scope_default`) through the `db` it was given, so a caller
  passing `tx` never opens a second connection while that `tx` is open. The four reads were also
  switched from `Promise.all` to sequential `await`s, mirroring `readTravelerData`'s own documented
  reason: multiple queries sharing ONE physical connection (true whenever `db` is a `tx`) trigger
  `@prisma/adapter-pg`'s single-connection-overlap deprecation warning if issued concurrently —
  `tests/helpers/setup.ts` documents the identical threshold for `readDetail`'s relation loads.

**Minor (folded in) — redundant customer query**: `saveNewOrder` already holds the full `customer`
row a few lines above its `resolveCertSettings` call. Left the re-query in place rather than adding
a "pass the row you already have" parameter: the exact three-argument interface
(`resolveCertSettings(db, customerId, partIds)`) is what Task 5 depends on, and now that this read
runs on `db` — the caller's own already-open connection — the cost is one extra round trip on a
connection already held, not a second competing one. That is a minor efficiency note, not the
pool-starvation defect the Important finding named, so I judged it not worth widening the contract
for. Documented inline in `certs.ts` at the query itself.

**Covering tests**:

```
npx vitest run tests/cert-resolution.test.ts tests/orders.test.ts tests/settings.test.ts tests/traveler.test.ts
 ✓ tests/orders.test.ts (124 tests) 6477ms
 ✓ tests/traveler.test.ts (28 tests) 3905ms
 ✓ tests/settings.test.ts (25 tests) 672ms
 ✓ tests/cert-resolution.test.ts (6 tests) 338ms
Test Files  4 passed (4)
     Tests  183 passed (183)
```

No stray `DeprecationWarning` output from the switch to sequential reads (verified — none appeared
in the run above, matching the intent of avoiding it in the first place).

### Minor — brief deviation: `customerContainerId` should be `.optional()`, not `.default("")`

**Finding**: the brief specifies `customerContainerId: z.string().max(60).optional()` on
`CONTAINER_ITEM`; I had written `.default("")`. Functionally identical end-to-end (an omitted key
either way lets the `String @default("")` column apply its own default on the Prisma `create`), but
the brief's exact schema shape is binding per the task instructions.

**What changed**: `src/server/orders.ts` — `CONTAINER_ITEM.customerContainerId` is now
`z.string().max(60).optional()`, with a comment noting the two forms are behaviorally identical and
explaining why `.optional()` is the one that's binding. No other code needed to change:
`c.customerContainerId` is now typed `string | undefined` everywhere it's read out of the parsed
input (the Prisma create/createMany data and the audit payload), and `undefined` is exactly what
those call sites need to let the DB default apply — confirmed by `npx tsc --noEmit` staying clean.

**Covering tests**: the existing `createOrder`/`replaceContainers` `customerContainerId` tests
added in the original pass (`tests/orders.test.ts`) already exercise both the omitted-key path
(defaults to `""`) and the explicit-value path — no behavior changed, so no test needed changing;
they're included in the `tests/orders.test.ts` run above (124 tests, all green).

### Minor — missing audit-content assertion for the resolved cert values

**Finding**: `auditPayload` was extended to record the *resolved* `certRequired`/`certScope` (not
the caller's raw input), and the original report claimed this in prose, but no test pinned it —
this project's convention (CLAUDE.md, global-constraints) is to assert audit **content**, not
merely that an entry exists.

**What changed**: added one test to `tests/orders.test.ts`'s `"createOrder: audit"` describe block:

```ts
it("records the RESOLVED certRequired/certScope in the create audit entry, plus customerJobNo/customerContainerId", async () => {
  const { customer, lead, rider, containerType } = await fixture();
  await prisma.part.update({ where: { id: lead.id }, data: { certRequired: true, certScope: "LOAD" } });
  await prisma.part.update({ where: { id: rider.id }, data: { certScope: "SHIPMENT" } });

  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, customerJobNo: "JOB-77",
    lines: mockupLines(lead.id, rider.id),
    containers: [{ typeId: containerType.id, count: 1, customerContainerId: "CUST-1" }],
  }));

  const entry = await prisma.auditLog.findFirstOrThrow({
    where: { entity: "order", entityId: order.id, action: "create" },
  });
  const after = entry.after as Record<string, unknown>;
  expect(after).toMatchObject({ customerJobNo: "JOB-77", certRequired: true, certScope: "LOAD" });
  expect((after.containers as Record<string, unknown>[])[0]).toMatchObject({ customerContainerId: "CUST-1" });
});
```

The lead part is given `certRequired: true`/`certScope: "LOAD"` and the rider a *disagreeing*
`certScope: "SHIPMENT"` — no cert fields are passed as input to `createOrder` at all, so the only
way `after.certRequired`/`after.certScope` can read `true`/`"LOAD"` is if `resolveCertSettings`
actually ran during this save and its answer (not a schema default, and not the rider's scope) is
what landed in the audit snapshot.

**Covering test**: included in the `tests/orders.test.ts` run above — 124 tests, all green
(123 baseline-after-first-pass + this one).

### Full regression after all four fixes

```
npm test              → 79 files, 1073 tests passed
npx tsc --noEmit       → clean
npx eslint src tests   → clean
```

## Fix round 2 — the previous fix introduced a new Important bug

Re-review confirmed the Important finding and two of the three Minors from round 1 as genuinely
closed, but found that round 1's own fix for the third Minor (`.default("")` → `.optional()` on
`CONTAINER_ITEM.customerContainerId`) introduced a new Important-level defect.

### The bug

`customerContainerId: z.string().max(60).optional()` means an omitted container's
`customerContainerId` parses to `undefined`, not `""`. `auditPayload`'s `containers.map` at
`src/server/orders.ts:373` wrote `customerContainerId: c.customerContainerId` with **no fallback**
— unlike every sibling optional field in the same object literal (`qty: c.qty ?? null`,
`tareWeight: c.tareWeight ?? null`, `grossWeight: c.grossWeight ?? null`). `redact()`
(`src/server/audit.ts`) round-trips the payload through `JSON.parse(JSON.stringify(value))`, and
`JSON.stringify` drops object keys whose value is `undefined`. So the create audit entry for any
order whose container omits `customerContainerId` — the ordinary case, since the field has no
present-day user (spec §3.22) — silently lost the key entirely, while the stored row and every
later DB-backed snapshot (`readDetail`, `SNAPSHOT_INCLUDE.order`) correctly carry `""`. A
subsequent container edit's "before" snapshot would then disagree in *shape*, not just value, with
the create entry for the same field — exactly the inconsistent-representation class issue #24
exists for.

### What changed

`src/server/orders.ts:373` (now `:378` after the added comment):

```ts
// before
customerContainerId: c.customerContainerId,
// after
customerContainerId: c.customerContainerId ?? "",
```

Matches its siblings in the same object literal and the column's own DB default.

### Other `.optional()` fields checked for the same pattern

Walked every field `auditPayload` writes against its source zod schema (`CREATE`, `LINE`,
`SERIAL_ITEM`, `CONTAINER_ITEM`, `CHARGE_ITEM`):

- `poNumber`, `vsOrderNumber`, `customerJobNo`, `notes`, `serials[].description` — all
  `.default("")`, never `undefined` in the parsed output. Safe.
- `lines[].partId`, `lines[].qty`, `lines[].weight` (`decimalField(..., { required: true })`,
  confirmed non-optional in its own overloaded return type), `containers[].typeId`,
  `containers[].count`, `serials[].serial`, `charges[].description` — all required, no
  `.optional()`/`.nullable()` anywhere in their schema. Safe.
- `containers[].qty`, `containers[].tareWeight`, `containers[].grossWeight`, `charges[].amount` —
  all genuinely optional/nullable (`.nullable().optional()`, or `decimalField` without
  `required: true`) but ALL already carry an explicit `?? null` at their write site. Safe.
- `containers[].customerContainerId` — the one field that was `.optional()` with no fallback. Now
  fixed.
- `clientRequestId` (`CREATE`, `.optional()`) is never written into `auditPayload` at all (a
  deliberate omission, not a missed fallback) — not affected.

**`customerContainerId` was the only field with this defect.** No other fix needed elsewhere in
`auditPayload`.

### Regression test

Added to `tests/orders.test.ts`'s `"createOrder: audit"` describe block, asserting KEY PRESENCE
(not `toMatchObject`, which passes on a missing key):

```ts
it("still carries the customerContainerId key (as \"\") in the create audit entry when the container omits it", async () => {
  const { customer, lead, containerType } = await fixture();
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    containers: [{ typeId: containerType.id, count: 1 }], // no customerContainerId
  }));

  const entry = await prisma.auditLog.findFirstOrThrow({
    where: { entity: "order", entityId: order.id, action: "create" },
  });
  const after = entry.after as { containers: Record<string, unknown>[] };
  expect(Object.hasOwn(after.containers[0], "customerContainerId")).toBe(true);
  expect(after.containers[0].customerContainerId).toBe("");
});
```

**RED, verified by temporarily reverting the fix** (`customerContainerId: c.customerContainerId`,
no `?? ""`) and re-running just this test:

```
npx vitest run tests/orders.test.ts -t "still carries the customerContainerId"
 FAIL  tests/orders.test.ts > createOrder: audit > still carries the customerContainerId key (as "") …
AssertionError: expected false to be true
 ❯ tests/orders.test.ts:919:71
   expect(Object.hasOwn(after.containers[0], "customerContainerId")).…
Tests  1 failed | 124 skipped (125)
```

**GREEN**, fix restored (confirmed byte-identical to the pre-revert file via `diff`):

```
npx vitest run tests/orders.test.ts tests/cert-resolution.test.ts
 ✓ tests/orders.test.ts (125 tests) 6439ms
 ✓ tests/cert-resolution.test.ts (6 tests) 342ms
Test Files  2 passed (2)
     Tests  131 passed (131)
```

### Note on the deprecation-warning signal (no action — acknowledged)

The reviewer flagged that round 1's report leaned on "no stray `DeprecationWarning` appeared" as
evidence the reads in `resolveCertSettings` are sequential — but `tests/helpers/setup.ts`
suppresses that exact warning class at the source, so a concurrent version would have produced
identical (silent) output; the signal doesn't discriminate. Noted, no code change — the sequential
reads themselves are correct (confirmed by the reviewer reading the code directly), only the prior
report's justification for them was weak. Not citing that signal again.

### Full regression after this round

```
npm test              → 79 files, 1074 tests passed
npx tsc --noEmit       → clean
npx eslint src tests   → clean
```

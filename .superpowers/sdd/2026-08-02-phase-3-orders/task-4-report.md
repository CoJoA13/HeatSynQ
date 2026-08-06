# Task 4 report — Orders service: create, read, list, export, traffic light

**Status:** complete. Commit `c132cab` — `feat: order create/read/list/export with locked revisions, auto-split, numbering` (no attribution trailer).

**Suite:** 706 passing, 65 files (baseline 635 → +71). `npx tsc --noEmit` clean, `npx eslint src tests` clean, `npm run build` clean.

---

## 1. What was implemented

### `erp/src/lib/traffic-light.ts` (new, 42 lines, client-safe)

- `TRAFFIC_LIGHTS` — the four lights as a const tuple, ordered most-urgent-first. The array order *is*
  `computeLight`'s evaluation order, which is what makes "most-urgent-first" structural rather than a
  consequence of how the two settings happen to be sized.
- `TrafficLight` — derived from that tuple (the `PRICE_PER` / `STEP_FIELD_TYPES` house pattern).
- `LIGHT_LABELS` — "Did miss" / "Will miss" / "May miss" / "On target". Spec §6 requires colour **plus
  text**; the Excel export consumes these today and Task 12's board will consume the same map rather
  than inventing a second vocabulary.
- `computeLight(requestDate, today, mayMissDays, willMissDays)` — whole-UTC-day difference, then
  `did_miss` (strictly past) → `will_miss` (≤ will) → `may_miss` (≤ may) → `on_target`. Both windows
  inclusive of their own edge.

### `erp/src/server/orders.ts` (new, 647 lines)

Exports: `OrderWarnings`, `OrderDetail` (+ the five child row types), `BoardRow`, `OrderFilter`,
`createOrder`, `getOrder`, `listOrders`, `exportOrders`. **No Task 5/6 surface** — no `updateOrder`,
`voidOrder`, `linkOrder`, line/container/serial/charge mutators, no load editing.

`createOrder` follows the brief's transaction skeleton in the mandated order:
validate customer → `resolveLineParts` → dates → `allocateNumber` → `lockCurrentRevision` →
`assertRefExists` per distinct container type → `lineTotals` + `splitLoads` → `auditedCreate` with the
nested order create → `createSerials` → clear the actor's draft → `readDetail(tx, …)` + warnings.
All inside `withDbErrors` → `prisma.$transaction(…, Serializable)`.

## 2. Decomposition choices (names/decomposition were mine; structure was binding)

| Helper | Why it exists |
|---|---|
| `parseDate(value, field)` | The brief's thin wrapper over `parseDateOnly`. Message follows the two existing precedents verbatim: `"2026-02-30" is not a valid date (yyyy-mm-dd) for Received date` — same shape as `part-field-values.ts` and `part-process-steps.ts`. Reused by the board's four date filters ("Received from/to", "Request from/to"). |
| `lineLabel(index, part?)` | **One** label shape — `Line 2 (ACME · 3541720C3)` — shared by every line-anchored 400 *and* every warning, so the operator reads the same identifier in the refusal, the warning banner and the saved order. Falls back to the bare `Line 1` only when the part could not be resolved at all, which is the one case with nothing to name it with. |
| `resolveLineParts(tx, customerId, lines)` | One `findMany` for the distinct ids, then a walk in payload order so the **first** bad line is the one reported and a part used on two lines is fetched once. Returns `ResolvedPart[]` derived via `Prisma.PartGetPayload<{ select: typeof PART_SELECT }>` (the `parts.ts` `Raw` precedent). |
| `lineTotals(lines)` | Σqty and Σweight, the weight sum in **integer cents**. `decimalField(12, 2)` has already bounded every line to 2 dp, so the cents are exact — `load-split.ts`'s reasoning applied one level up, and what keeps the split's sums landing on the totals exactly. |
| `buildWarnings(customer, parts, lines)` | Serialization lines first, then credit hold — spec §5.5's own listing order. |
| `duplicateSerialError(lines, parts)` | See §3 below. |
| `createSerials(tx, orderId, lineIds, lines, parts)` | One `createMany`; serials cannot ride the order's nested create because they need line ids. |
| `auditPayload({...})` | See §4 below. |
| `readDetail(db, id, traffic)` / `toDetail` | Shared by `getOrder` (on `prisma`) and the tail of the save (on `tx`) — the `customer-addresses.ts` `Db` precedent. |
| `trafficSettings()` | Both windows in one pair of reads, taken **once per call**, then handed to every row. |
| `orderByFor` / `boardWhere` / `dateRange` / `searchWhere` | Split so both input rejections (`sort`, dates) happen before any query is issued. |

### Decisions worth naming

- **Settings read before the transaction opens.** `getSetting("request_days_default")` and the two
  traffic settings run on the top-level client *before* `$transaction`. A read on a second connection
  from inside a Serializable transaction that later locks the very same `Setting` row (`allocateNumber`)
  is exactly the shape a deadlock gets introduced through later. `request_days_default` is read
  unconditionally rather than lazily — one indexed lookup, versus a sentinel that would need explaining.
- **`Object.hasOwn` on the sort whitelist.** `SORTABLE["constructor"]` and `SORTABLE["toString"]` are
  inherited and truthy; calling one would hand Prisma something that is not an `orderBy` at all. This is
  the Phase 1 `__proto__` registry lesson.
- **An unrecognised sort key is a 400, not a silent fallback.** A board quietly sorted by something else
  is the discoverability failure this project keeps refusing to ship.
- **Search matches the LEAD part only** (`lines: { some: { position: 1, … } }`). A board row is labelled
  with its lead part; matching a rider would surface an order under a part number that appears nowhere
  in the list the operator is looking at.
- **Order-number search is range-guarded.** `orderNumber` is Int4; a 14-digit search term handed to
  Prisma is a `PrismaClientValidationError` (a status-less 500), not "no match". Guarded by
  `/^\d+$/` + `Number.isSafeInteger` + `≤ 2_147_483_647`, with a test.
- **`orderNumber` as universal tiebreaker.** Every non-`orderNumber` sort appends `{ orderNumber: "desc" }`
  so two orders sharing a request date don't come back in whatever order the planner picked that run —
  the `readAudit` `[{ at }, { id }]` lesson.
- **Dates cross the DTO boundary as `"yyyy-mm-dd"` strings** (global constraint §11), so `BoardRow` feeds
  `toXlsx` with clean date cells and no client-side timezone hazard.
- **`OrderDetail` carries `voided: boolean`, not raw `deletedAt`.** The void *reason* lives in the
  `auditedSoftDelete` entry (spec §5c), so the hub reads it from history; a bare timestamp on the DTO
  would be a second, weaker source of the same fact.
- **`linkedOrders` is not filtered on `deletedAt`.** A voided sibling in a link group is precisely what
  that panel exists to show, and it matches `getOrder` returning voided orders at all.
- **Two reads per distinct container type**, documented inline: `assertRefExists` is the *mandated*
  writer-side half of the reference-delete TOCTOU guard and returns nothing, while the audit payload
  needs the live name so history reads "Basket" and not a cuid. Skipped entirely when there are no
  containers.

## 3. The duplicate-serial message

The brief asks for "P2002 → 400 naming the serial". P2002 reports which **columns** collided, never
which **value** did — so naming it has to come from the payload. `createSerials` catches P2002 from the
`createMany` and calls `duplicateSerialError`, which re-walks the payload in entry order to find the
repeat the database just refused:

```
Line 1 (ACME · 3541720C3): serial "EC001" is entered twice
```

Doing the scan **inside the catch** rather than as a pre-check means the database's own
`@@unique([lineId, serial])` index stays the real guard (nothing is enforced twice), the happy path
pays nothing for the scan, and the message still names the value. The unreachable fallback (P2002 with
no in-payload repeat) returns a generic serial-anchored 400 rather than leaking Prisma text.

Tested both ways: a repeat within one line is refused and nothing is written; the same serial on two
*different* lines is allowed, which the composite unique key permits by design.

## 4. The audit payload

`auditedCreate` takes the payload as an argument, which is the chance to shape it rather than accept
whatever a read-back would give:

- Every collection is **ordered by construction** — issue #24's lesson (an unordered collection makes
  two identical snapshots render as a spurious diff) applied to the *create* entry, not only to
  `SNAPSHOT_INCLUDE`'s update snapshots.
- Every foreign key travels with the live name it points at: `partNumber` beside `partId`,
  `typeName` beside `typeId`, `customerCode` beside `customerId`. Same rule `SNAPSHOT_INCLUDE.order`
  follows for update diffs, so the create entry and the later update diffs read alike.
- Collection layout **mirrors `SNAPSHOT_INCLUDE.order`**: `lines`, `containers`, `serials`, `loads`,
  `charges` all top-level. Serials are keyed by `linePosition` rather than `lineId` because line ids do
  not exist when the payload is composed — which also happens to read better than a cuid would.
- `status: "OPEN"` is recorded explicitly (the column default, never written by `createOrder`) so the
  create entry and every later diff describe the same field set.
- No ids anywhere (they don't exist yet), and nothing file-shaped — asserted by a test that stringifies
  the whole snapshot and greps for `filedata` after seeding a `StoredDocument` on the order.

## 5. TDD evidence

### RED — `npx vitest run tests/orders.test.ts tests/traffic-light.test.ts`

Tests written first, against modules that did not exist:

```
 FAIL  tests/orders.test.ts [ tests/orders.test.ts ]
Error: Cannot find module '@/server/orders' imported from '…/erp/tests/orders.test.ts'

 FAIL  tests/traffic-light.test.ts [ tests/traffic-light.test.ts ]
Error: Cannot find module '@/lib/traffic-light' imported from '…/erp/tests/traffic-light.test.ts'

 Test Files  2 failed (2)
      Tests  no tests
```

### GREEN — same command after implementing

```
 ✓ tests/orders.test.ts (61 tests) 2548ms
 ✓ tests/traffic-light.test.ts (10 tests) 4ms

 Test Files  2 passed (2)
      Tests  71 passed (71)
```

### Full gates

```
$ npx tsc --noEmit          # clean
$ npx eslint src tests      # clean
$ npm run build             # clean (standalone build)
$ npm test
 Test Files  65 passed (65)
      Tests  706 passed (706)
   Duration  54.96s
```

### Mutation probes — proving the tests actually bite

A module-not-found RED is a weak RED (nothing executes), so five deliberate mutations were applied and
reverted, each targeting logic a passing-by-accident test would not catch:

| # | Mutation | Result |
|---|---|---|
| M1 | `computeLight` evaluates `may_miss` before `will_miss` | **5 of 10** traffic-light tests fail |
| M2 | search matches any line's part number, not `position: 1` | "matches only the LEAD part number" fails |
| M3 | request-day chain reads the *last* part's override instead of the lead's | "lets the LEAD part's override beat both" fails |
| M4 | `revisionNumber` written on every line, not just position 1 | "locks the lead part's current revision…" fails |
| M5 | `lockCurrentRevision` returns the number without calling `lockRevision` | both the happy-path lock test **and** the race test fail |

`diff` against pre-mutation copies confirmed every file restored byte-identically before the final run.

## 6. Concurrency: what was measured, not assumed

**Probe (before writing the concurrency test).** Two `allocateNumber` calls in concurrent
**Serializable** transactions were run against `erp_test`. Result:

```
OK 1001
ERR P2010  Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`
     meta.driverAdapterError.cause.originalCode = "40001"
```

Under Read Committed (which `tests/allocate-number.test.ts` uses) `SELECT … FOR UPDATE` blocks and
re-reads; under Serializable Postgres refuses instead. So **one of two concurrent saves always loses**,
with the retryable 409 `withDbErrors` already maps 40001 to — exactly what the global constraints
predict ("serialization failures already map to 409; `translatePrisma` handles P2010-wrapped 40001").

`createConcurrently()` therefore fires the saves without awaiting between starts, **asserts the loser
failed with exactly 409 and nothing else**, retries it, and then asserts the numbers are distinct and
consecutive with no gap. The test passes whether or not the two happen to serialize naturally, so it is
not flaky, and it proves the real contract rather than a weaker one.

**The save-vs-step-edit race test was vacuous on the first attempt and was fixed.** Instrumenting it
showed `save=rejected edit=fulfilled` on **6 of 6** runs — the editor reaches `workingRevision`'s claim
almost immediately while the save is still validating and allocating, so the save's `SELECT … FOR UPDATE`
always finds a row updated after its own snapshot. The original test returned early on a rejected save,
so every assertion below it was unreachable. It now retries the save (the documented answer to the 409)
and asserts the invariant unconditionally: the quoted revision is locked, carries one of the two legal
instructions, and stays byte-identical through a further step edit. Confirmed non-vacuous by M5 and
stable across 5 consecutive runs.

## 7. Test coverage against the brief's clusters

Every bullet has at least one test. 61 in `tests/orders.test.ts`, 10 in `tests/traffic-light.test.ts`.

**create** — two-line sibling order with the lead's `revisionNumber` and `null` riders; `lockedAt` set;
the mockup split (4,500 pc / 60,750 lb, `loadQty` 336 → 14 loads, 13 × 336 then 132, first load 4536.00,
last 1782.00, cents summing to exactly 6,075,000); weight-only cap (proves `Decimal → number`
pass-through); no caps → one load; containers/charges stored in payload order with 1-based positions;
`.strict()` rejects unknown keys at both levels.

**numbering** — two concurrent saves → distinct consecutive numbers; continues from a configured seed
(5200 → 5201); a failed save consumes no number and leaves the `Setting` row absent, and the next good
save still gets 1000.

**dates** — `receivedDate` defaults to today; plant default 5 with the business-day assertion
(Friday 2026-08-07 + 5 → Friday 2026-08-14); customer override 7 beats plant; **lead** part override 3
beats both, with a rider override of 20 present and deliberately ignored; explicit dates win, including
`targetDate: null`; malformed/non-existent dates 400 naming Received/Request/Target and write nothing.

**rejections** — unknown *and* soft-deleted customer; inactive customer; part of another customer
(`Line 2 (OTHR · X-9): that part belongs to another customer`); inactive part; unknown *and*
soft-deleted part; lead without steps → `This part has no process steps`, with the **rider exemption**
asserted in the same test; lead whose current revision has zero steps; unknown *and* soft-deleted
container type, writing nothing.

**serials** — per-line numbering from 1 against the right `lineId`; duplicate within a line named;
same serial on two lines allowed.

**warnings** — serialization warning naming the line, order still saved; no warning once serials exist;
credit hold warns without blocking; both together in spec order.

**audit** — exactly one `order` create entry, `after` carrying ordered lines (with `partNumber` and the
lead-only `revisionNumber`), containers (with `typeName`), 14 ordered loads, serials in **entry** order
(not alphabetical), charges; a separate test proves no `fileData`-shaped key anywhere.

**draft** — cleared to `null` inside the transaction for the acting user only, another user's untouched;
untouched when the save fails; a system actor with no user row saves fine.

**lock integration (§12.3)** — post-save `updateStep` cuts rev 2 and rev 1 is byte-identical
(`toEqual`, the `part-process-steps.test.ts` byte-compare shape); a second order quoting the same part
re-locks the same revision without cutting a new one; the genuinely concurrent save-vs-edit race above.

**getOrder** — 404 (and `HttpError` instance) on unknown; full graph, lead first, light computed;
`travelerPrinted` flips on a `StoredDocument`; **voided orders are returned**; `linkedOrders` excludes
self, ordered by number.

**listOrders** — board row shape with Σqty/Σweight, lead part, `loadCount`, `linked`; light per row from
the two settings (asserted after changing both to 40/5); voided hidden by default and shown with
`includeVoided` carrying `voided: true`; customer filter; status filter (single and multi); received and
request ranges inclusive of both ends; malformed date filter 400 naming the field; search across number
/ PO / VS# (case-insensitive) / lead part / customer code / customer name / no-match; rider part number
does **not** match; oversized numeric search term is harmless; requestDate sort both directions; default
sort newest-first; unrecognised sort key 400s; `linked` flips with a link group.

**exportOrders** — exact 16-column header row; a data row asserted cell by cell (including "Did miss"
and yes/no); `rowCount` proving one row per order; filtered set only; voided rows marked when included.

## 8. Self-review findings

- **Fixed during the task:** the save-vs-edit race test was vacuous (§6) — found by instrumenting the
  branch, not by reading it.
- **Fixed during the task:** `containerType` name lookup ran an empty `IN ()` query on every order with
  no containers (the common case). Now short-circuited, with the two-read rationale documented inline.
- **Reviewed and deliberately left alone:** `OrderDetail` carries `customerId` but no customer
  `code`/`name` object. The brief enumerates the shape and does not include one, and the lead line
  already carries `part.customer.code`. Task 14 (order hub) is where a customer display block, if
  wanted, should be specified rather than guessed at now.
- **Reviewed and deliberately left alone:** `listOrders`' `status` is typed `OrderStatus[]` with no
  runtime membership check — the `listParts`/`listCustomers` precedent, where the route owns the
  query-string parse. Task 9's route tests are the right place for that guard.
- No console output from either new module. `npm test` output is clean apart from the pre-existing
  concern in §9.

## 9. Concerns to carry forward

1. **`pg` deprecation warning, new to the suite, not caused by this task's design.** `npm test` now
   prints once:

   ```
   DeprecationWarning: Calling client.query() when the client is already executing a query is
   deprecated and will be removed in pg@9.0.
   ```

   Traced to `@prisma/adapter-pg`'s `PgTransaction.performIO` via
   `client-engine-runtime/query-interpreter.ts:246`, where Prisma `Array.map`s over sibling relation
   nodes. Measured threshold: **inside a transaction**, an `include` with 1 or 2 sibling relations is
   clean and 5 warns; the identical query **outside** a transaction is clean (separate pool
   connections). Reproducible in three lines of raw Prisma with no application code involved.

   This repo reaches it from `readDetail(tx, …)` (6 relations) and will reach it again in Task 5 from
   `SNAPSHOT_INCLUDE.order` (5 relations, read on `tx` by `auditedUpdate`) — so it is a property of the
   order graph under Prisma 7 + pg 8, already baked in by Task 1's audit include.

   **Not worked around deliberately.** Correctness is unaffected today (pg queues the queries). The two
   available workarounds are both worse than the warning: moving the detail read outside the transaction
   deviates from the binding §5 structure, and hand-serialising the six relation loads turns one read
   into six sequential round trips *inside a Serializable transaction*, lengthening the lock window the
   whole concurrency contract depends on. The real fix is upstream, or `relationLoadStrategy: "join"`,
   which is a preview-feature decision for the owner. Flagged as a separate background task.

2. **The 409 on concurrent saves is a UI contract, not just a service detail.** Two operators keying
   orders at the same instant means one sees "Another change to that order was saved at the same time —
   please try again". Task 13's entry page should retry once transparently rather than surfacing that to
   an operator who did nothing wrong. Recording it here so it is a decision rather than a surprise.

3. **`exportOrders` lives in the service, not the route.** Every other export in the app builds its
   columns in the route (`/api/parts/export` and friends). The brief specifies `exportOrders` as a
   service export, which is what was built; Task 9's route becomes a thin caller. Worth a glance for
   consistency if the owner would rather the columns lived beside the other exports.

4. **`Order.status` is only ever `OPEN` in Phase 3.** The status filter is implemented and tested
   (by setting `status` directly via Prisma), but nothing in this phase can produce a non-`OPEN` order.
   That is per spec §4 ("reserved values keep Phases 4–5 from churning the vocabulary") — noted so a
   reviewer does not read the filter as dead code.

## Pre-T5 infra fixes

Two small fixes landed before Task 5, closing out both concerns this report raised.

**1. The §9.1 `pg` DeprecationWarning is now silenced in test output.** `erp/tests/helpers/setup.ts`
wraps `process.emitWarning`, following the same house rule dotenv's `quiet: true` already serves
in that file. The wrapper drops only a `DeprecationWarning` whose message matches "Calling
client.query() when the client is already executing a query" — anything else, including other
DeprecationWarnings, still reaches the real `process.emitWarning` and prints. The docblock records
the upstream cause, the measured threshold, and the removal condition, and is not a substitute for
fixing this upstream: **issue #32** tracks it, so the filter itself has an obligation to be removed
the moment `@prisma/adapter-pg` stops loading sibling relations concurrently, and in any case before
any upgrade to pg@9 (whose changelog drops the call pattern both the warning and this suppression
depend on).

Verified: `npx vitest run tests/orders.test.ts 2>&1 | grep -c DeprecationWarning` → `0`. A scratch
test that called `process.emitWarning("…", "DeprecationWarning")` with an unrelated message, and a
second call with a `"CustomWarning"` type, confirmed both still print; the scratch file was deleted
after.

**2. `SNAPSHOT_INCLUDE.order.serials` now orders by line position, not `lineId`.** The §2 "decisions
worth naming" table and this report's own §4 already applied the issue-#24 ordering lesson to the
*create* payload; `SNAPSHOT_INCLUDE`'s *update* snapshot had the same trap Task 4 review caught
before it shipped a spurious diff: `lineId` is an opaque cuid, so ordering by it made snapshot order
track insertion history rather than the order an operator actually entered lines in. It now reads
`orderBy: [{ line: { position: "asc" } }, { position: "asc" }]` — Prisma 7 accepts the relation-field
`orderBy` with no compiler complaint — which makes it agree with `DETAIL_INCLUDE.serials`
(`erp/src/server/orders.ts`) and the create-path `auditPayload`, both already keyed by line
position. `auditPayload`'s own serials comment doesn't claim an exact mirror of `SNAPSHOT_INCLUDE`'s
ordering (it only contrasts `linePosition` against a cuid in general terms), so no wording there
needed correcting.

Verified: `npx tsc --noEmit` clean; `npx vitest run tests/orders.test.ts tests/audit.test.ts
tests/audit-tx.test.ts tests/part-process-steps.test.ts` → 4 files, 103 tests, all passing; full
suite `npm test` → 65 files, 706 passing (unchanged from this report's baseline); `npx eslint src
tests` clean.

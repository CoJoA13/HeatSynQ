# Tasks 4+5 — #93 export-audit journal + #90 Phase 5C minors — implementer report

**Commit:** `5749983` `feat(gl-export,close,db-errors): audit the summary journal (#93); 5C minors (#90)`
**Branch:** `group-e-close-gl`

## What landed

### #93 — the GL-export create-audit carries the emitted summary journal

- `src/server/gl-export.ts` — `exportClose`'s `auditedCreate` payload gains
  `summary: summaryLines.map((l) => ({ side, account: l.glAccountName, debit, credit }))` — the
  same aggregated `(account, side)` lines the CSV and register print (bounded by 2 × chart size,
  never transaction volume). `postingCount` stays; nothing else added — the CSV/register BYTES
  stay out of the audit row. `account` is the frozen account-number string the CSV itself prints.
- `src/server/audit.ts` — `SNAPSHOT_INCLUDE.glExportBatch` was inert (`auditedCreate` writes its
  `data` arg verbatim and never calls `snapshot()`; the model has no update/soft-delete path —
  `exportClose` is its only writer). Replaced with `undefined` + the reason stated in place.
- `src/server/audit.ts` — **belt added:** a `SNAPSHOT_SELECT.glExportBatch` entry listing every
  scalar except the `file`/`register` Bytes columns, relations omitted (postings are the
  unbounded per-event ledger). The mechanism made it clean — it is exactly the `storedDocument`
  precedent, including "currently unreached, defined so the exclusion exists the moment an
  update path appears," so it was added rather than declined.

### #90 — per-item dispositions (brief's table, all ten items)

| Item | Outcome |
|---|---|
| 1. 40P01 deadlock translation | **Fixed.** `isRawSerializationFailure` → `isRawRetryableFailure`, accepts `originalCode ∈ {"40001","40P01"}`; both call sites updated (the 409 translation and `isRetryableConflict`). Doc comments state the condition is identical: aborted, nothing written, safe re-run |
| 2. P2002 retry opt-in | **Fixed.** `retryOnSerializationConflict(run, tries = 5, opts: { retryUniqueConflict?: boolean } = {})`, default false. ONLY `closePeriod` passes `5, { retryUniqueConflict: true }` (the year-month insert race); `reopenPeriod` and `retryAllocation` take the default. Rationale in the comments verbatim per brief: allocation paths answer nonce P2002s by in-attempt replay and never retry (#115 — verified against orders.ts:725–730's own comment), and `meta.target` discrimination is unavailable on the driver-adapter stack (#40) |
| 3. schema.prisma:127 "Three separate FKs" | **Fixed** → "Six separate FKs". Comment-only; `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script` output: `-- This is an empty migration.` (verified after the edit) |
| 4. reference-links.ts BillingConfig comment | **Fixed** → "seven registry entries (the six billing GL accounts + the cert-charge step code)" — matches the actual registry (six `glAccount` targets + one `processStepCode` target, all spreading `BILLING_CONFIG_BLOCKER`) |
| 5. `Close.tsx` `kind: string` | **Fixed.** `ReadinessGapKind` union exported from `src/lib/gl-constants.ts` (client-safe); `gl-mapping.ts`'s `ReadinessGap.kind` and Close.tsx's local mirror both type against it (Close.tsx imports from `src/lib`, never `src/server`) |
| 6. Year floor + missing ceiling | **Fixed.** `MIN_CLOSE_YEAR = 2000` / `MAX_CLOSE_YEAR = 9999` in `gl-constants.ts`, full two-part floor rationale (Number(null)===0 passes isInteger; Date.UTC maps 0–99 → 1900s) + ceiling rationale on the constants. Applied to the brief's two named sites (`readiness/period.ts`, `close/route.ts`) **plus two more the grep found sharing the same magic 2000**: `preliminary/route.ts` (its own zod QUERY — the site the named test at routes:699–706 actually exercises) and Close.tsx's `?year=` parse (client mirror). Existing sub-2000 tests stay green; upper-bound cases added for preliminary AND close POST |
| 7. Empty no-op export | **Fixed.** `if (lines.length === 0) throw new HttpError(400, "Nothing to export — this period has no unexported postings")` immediately before `allocateNumber` — no number consumed, no empty batch row. UI error path verified by code reading: `Close.tsx`'s `doExport` catches, `setExportError`, and the existing banner renders the server sentence; no new UI built |
| 8a. Register `money()` blank-for-zero | **No change** (deliberate register style, per brief) |
| 8b. Close.tsx per-row gap count | **No change** (the server 409 is the guard, per brief) |
| 9. `close-month-end.mjs` p-3 locator | **Stabilized** (it was trivial): `data-testid="closed-period-row"` on the period row div in Close.tsx; `periodRow` now `locator('[data-testid="closed-period-row"]').filter({ has: span.font-medium hasText })` instead of the `ancestor::div[contains(@class,'p-3')]` xpath |

## RED table (all watched failing before implementation)

| Test | RED failure |
|---|---|
| #93: audit row carries the summary journal | `expected undefined to deeply equal [ { side: 'SALES', … } ]` — `after.summary` absent |
| #90-7: no-op re-run refused before a number is consumed (first-export test) | export resolved with an empty batch instead of rejecting 400 |
| #90-7: re-export after reversal refused (reversing-delta test) | same — resolved with `postings: []` |
| #90-7: re-export after reverse-then-repost refused | same |
| #90-7: August re-export refused (cross-month test) | same |
| #90-1: raw 40P01 → 409 | original `PrismaClientKnownRequestError` rethrown, not HttpError 409 |
| #90-2: P2002 default path thrown on attempt 1 | `expected 5 to be 1` — invocation count proved the blanket retry |
| #90-1: 40P01 absorbed by the retry wrapper | thrown on attempt 1 instead of re-run |
| #90-6: preliminary year=10000 → designed 400 | 400 by LUCK downstream — message `"10000-07-31" is not a valid date … for As-of date` fails the `/year/i` pin |
| #90-6: close POST year=10000 → designed 400 | same downstream-luck message, fails `/year/i` |

Two notes on RED procedure:

- The two upper-bound route tests initially passed on status alone — year 10000 already 400'd,
  but from `agingEndingArAt`'s date-string parse blaming "As-of date." Both tests were
  strengthened to pin the error message naming `year`, and re-watched RED for that reason. The
  bound was real work, not test theater.
- The P2002 **opt-in** test (`calls === 3` with `{ retryUniqueConflict: true }`) passed pre-change
  (extra args ignored; the blanket retry made it look opted-in) — it pins the opted-in behavior,
  the default-path test is the one that went RED.

## A fifth empty-export site the brief's sweep asked for

The brief named gl-export.test.ts:229–230 and asked for a sweep of other re-exports. Four more
surfaced, one of them not a re-export at all: the ruling-8 `finalizedAt`-scoping test exported
JULY — a month with **nothing ever in scope** (its invoice finalized in August) — and asserted the
invoice absent from the empty batch. Under #90 that first export is also (correctly) the
nothing-to-export refusal, and the test now asserts the rejection itself, which is a *stronger*
scoping proof: an `invoiceDate`-scoped implementation would emit the invoice and not throw.
`reports-sales.test.ts`'s single non-empty export and the E2E flow's two exports (first: real
events; second: a non-empty reversing delta) are unaffected — verified by reading, and by the full
suite.

## Migrate-diff evidence (item 3, and the group's no-migration rule)

```
$ npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script
-- This is an empty migration.
```

Run after the schema comment edit, from `erp/`.

## Gates

| Gate | Result |
|---|---|
| `npx vitest run tests/gl-export.test.ts tests/db-errors.test.ts` | 2 files, 33 passed |
| `npx vitest run tests/close-periods.test.ts tests/receivables-routes.test.ts tests/allocation-retry.test.ts` | 3 files, 63 passed |
| `npx vitest run tests/receipts.test.ts tests/period-locks.test.ts` | 2 files, 49 passed |
| `npm test` (full suite) | **184 files, 3197 passed** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| migrate diff | empty (above) |

E2E: owed at group level per the brief's sequencing ("E2E in background near the end"); not run
per-task. **The group run must include flow 18 (`close-month-end`)** — this task changed both its
`periodRow` locator and the DOM it targets (the `data-testid`), so that flow is the direct proof
of item 9.

## Reviewer attention

- **Behavior change beyond the named call sites (item 2):** before this, `retryAllocation`
  retried EVERY P2002 up to 10 times — including genuine, deterministic ones (e.g. a real
  `orderNumber` collision), which failed identically 10 times before surfacing. Now they surface
  on attempt 1. No test pinned the old behavior (full suite green), and the clientRequestId nonce
  never reached the wrapper anyway (`createOrder`'s catch replays it in-attempt,
  orders.ts:734–749), but it is a semantics change for any unforeseen P2002 under an allocating
  save.
- **Item 6 scope:** the brief named two parse sites; the fix landed on four (adding
  `preliminary/route.ts` and Close.tsx's URL-param mirror). Grounds: `preliminary/route.ts` is the
  route the brief's own named test (routes:699–706) exercises, and it duplicated the same magic
  2000 in its own zod schema — bounding only `period.ts` would have left the named test's route
  inconsistent with its siblings.
- **`readiness/period.ts` message changed** from "year (>= 2000) and month (1-12) are required" to
  "year (2000-9999) and month (1-12) are required" — no test pinned the old text.
- **#93 test asserts exact summary order** (A/R line first, then revenue). This is deterministic —
  every invoice pushes its A/R line before its revenue lines, so first-occurrence Map order puts
  A/R first regardless of invoice fetch order — but it does pin `aggregateLines`' insertion-order
  contract, which the register's side-filter comment already relies on.
- The `SNAPSHOT_SELECT.glExportBatch` belt is deliberately unreached today (same as
  `storedDocument`'s); nothing exercises it until an update/soft-delete path exists.

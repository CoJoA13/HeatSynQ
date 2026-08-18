# Round 2, Group E — Close, GL export and concurrency tripwires · task brief

**Branch:** `group-e-close-gl` · **Base:** `ed55ffe` (main)
**Source of scope:** `docs/2026-08-17-backlog-round-2.md`, Group E.

## Why this group exists

Group C merged (`4cada64`, PR #141) and the owner asked for the next group. Group E is the
close/GL/concurrency track plus four late additions that arrived with rulings or answers already in
hand: #73 and #80 from the accounting answers (Q16/Q18), #139 and #140 from the 2026-08-18 rulings.
Nothing here waits on anyone — all nine issues are buildable as specified.

## Scope — nine issues

| # | Work |
|---|---|
| #139 | **Freeze the pair** (ruling 2026-08-18): any edit to EITHER side of a live reversal pair is refused naming the pair. The creation guard landed on PR #141; the six edit-mutator doors remain |
| #140 | **Coverage-precise removal** (ruling 2026-08-18): `removeOrderFromShipper`'s printed-paper guard reads `coveredOrderIds`, not current membership |
| #73 | `receivedDate ≤ today` guard on `addPayment` (Q16: "No, not yet" — payments post after deposit) |
| #80 | `postBatch` refuses when a non-null `controlTotal` doesn't foot (Q18: refuse) |
| #88 | Broken-chain flag in `listClosePeriods` (ruling 2026-08-17, option c) |
| #93 | GL-export create-audit carries the emitted summary journal |
| #90 | Phase 5C minors bundle (see per-item dispositions below) |
| #132 | Retention failure must survive a manual backup's status overwrite |
| #95 | Two dangerous-direction SSI tripwire tests (deletePart / deleteCustomer vs quote writers) |

**No schema migration anywhere in this group.** #139/#140 ride columns #65/#52 already added
(`reversesShipperId`, `reversalClearedLineIds`, `coveredOrderIds`); #88 is a derived read; #93 is an
audit payload; #132 is a new sidecar file; the rest are guards, comments and tests. If an
implementer believes a migration is needed, stop and re-check the design first.

## Rulings and answers in hand (verbatim anchors)

- **#139 — FREEZE THE PAIR** (issue comment 2026-08-18, spec §15): while a reversal pair is live
  (both documents un-voided), any edit to EITHER document is refused naming the pair — the
  original's refusal says void the reversal first; the reversal's says a reversal is
  machine-generated mirror paper, void it and re-reverse. Rejected: header-edit carve-outs;
  math-only re-validation.
- **#140 — PRECISE** (issue comment 2026-08-18, spec §15): refuse only when a printed whole-set
  document actually NAMES the order; the refusal keeps naming the covering document (§5.14).
  Pre-#52 backfilled rows over-cover (current-at-migration membership) — still the safe direction.
- **#88 — option (c)** (issue comment 2026-08-17): flag, don't refuse, don't cascade. A derived
  read; per the Phase 8A rule a report/read must not claim, audit or run Serializable.
- **#73 — Q16 "No, not yet"** → the issue's first branch: guard at the source.
- **#80 — Q18 checkmark on "refusing is the safer default"** → validate the live payment sum under
  the batch claim and 400 naming the discrepancy.
- **#132 — the issue's own direction**: a separate retention-health signal — "the only one that
  neither duplicates the rule nor breaks the un-merged-overwrite property."

---

## Task 1 — #139 + #140: the shipper pair guards (one task, one file)

### #139 design (from kickoff recon, 2026-08-18)

**The chokepoint exists and is exact.** `claimLiveShipper` (`shippers.ts:782–796`) is called by
precisely the six edit doors — `updateShipper` (867), `addOrderToShipper` (966),
`removeOrderFromShipper` (1065), `replaceShipperLines` (1396), `replaceShipperContainers` (1475),
`replaceShipperSerials` (1548) — and by nothing else. `voidShipper` (claims via
`claimShipperRows`), `reverseShipperInTx` (claims via `claimShipperRow`), `printShippingTickets`
and `printBol` all bypass it deliberately. So ONE guard inside `claimLiveShipper`, after its
full-row re-read, covers all six doors and automatically exempts the reversal creation (which must
write the original's `lineComplete` flags at step 6b, shippers.ts:2013), the void-restore (1764),
and both print paths — including `printBol`'s lazy `bolNumber` allocation (2393), which is a
first-print number write, not an operator edit, and must keep working on a reversed shipment.

**The guard, two checks in order:**

1. **Target IS a reversal** (`shipper.reversesShipperId !== null`, already on the re-read row):
   refuse ALWAYS — not just when the original is live. A reversal is machine-generated mirror
   paper; editing one is never sensible, and refusing unconditionally converts today's
   *incidental* protection (the at-least-one-positive-line invariant, noted at
   `tests/shipper-void.test.ts:331–338`) into the explicit rule, covering corrupt pre-#65 data in
   the safe direction. Message names the pair: fetch the original's `shipperNumber` and throw
   `400 "This is a reversal of Packing List <n> — a reversal is machine-generated mirror paper;
   void it and re-reverse instead of editing it"`.
2. **A live reversal points AT the target**: `findFirst({ where: { reversesShipperId: id,
   deletedAt: null }, select: { shipperNumber: true }, orderBy: { shipperNumber: "asc" } })` — the
   exact shape at shippers.ts:1723 and 1896. If found: `400 "This shipment has been reversed by
   Packing List <n> — void the reversal first, then edit, then re-reverse"`.

**Lock argument (state it in the code comment).** The guarded state (the counterpart's existence /
liveness) lives on a different row, but every writer that CHANGES pair-liveness claims the
original's Shipper row: `reverseShipperInTx` claims it at 1870 before creating the reversal, and
`voidShipper` claims both rows via `claimShipperRows` (1710). `claimLiveShipper` holds that same
row (its `claimShipperRow` at the target; for reversal-side edits the state is on the claimed row
itself), so the guard's read after the claim is serialized against both creation and void at ANY
isolation — the CLAUDE.md "guarded state must be locked with the claimed row" rule is satisfied
transitively, without widening `claimLiveShipper` to a pair claim. Do NOT add a second claim path.

**UI (§5.16 — disabled says why):** `readShipperDetail` already returns `reversesShipperId` and
`reversedByShipperNumber`. In `ShipmentDetail.tsx`, when either is set (pair live), disable the
edit controls (add order, remove order, line/container/serial editors, header save) with the
server's sentence as the title, and show a short banner naming the pair — the existing void-gate
precedent at ShipmentDetail.tsx:258–270. Detail: `reversedByShipperNumber` is only set while the
reversal is LIVE (the `DETAIL_INCLUDE.reversedBy` filter), so the UI gate follows the server truth
for free after a void + reload.

**Tests** (extend `tests/shipper-void.test.ts` or a sibling describe): all six doors refused on
the ORIGINAL of a live pair (message names the reversal); all six refused on the REVERSAL (message
says mirror paper); void the reversal → the original edits again (the ruling's correction flow,
end to end: reverse → refused edit → void reversal → edit succeeds → re-reverse succeeds);
`printBol` on a reversed original still succeeds and allocates its number; the #65 void/restore
tests stay green untouched. Update the prose note at shipper-void.test.ts:331–338 to point at the
explicit guard.

### #140 design

Replace the predicate at shippers.ts:1083–1085 with the exact branch `listDocumentsForOrder`
already uses (`documents.ts:219`):

```ts
where: { shipperId: id, OR: [{ orderId: target.orderId }, { orderId: null, coveredOrderIds: { has: target.orderId } }] }
```

GIN-index-served (`StoredDocument_coveredOrderIds_idx`). The refusal message is unchanged — it
already names the covering document. The existing pin tests
(`shipper-children.test.ts:280–286` and 271–278) both store coverage that INCLUDES the target, so
they stay green under the precise predicate — the behavior #140 changes is currently unpinned in
either direction. Add both directions: an order added AFTER a whole-set print (coverage excludes
it) removes freely; an order the coverage names is refused. Note the interplay: on a pair-live
shipment the #139 freeze fires first (it's inside `claimLiveShipper`); that is correct and worth
one assertion.

## Task 2 — #73 + #80: the receipts guards (one task, one file)

### #73

`addPaymentInTx` (`receipts.ts:315`) is the SOLE writer of `receivedDate` — there is no
`updatePayment`, and `voidPayment` only stamps `deletedAt` (grep-verified). Guard right after
`parseDate` at line 332, sampling the clock once (the `invoices.ts:1736` precedent):

```ts
if (receivedDate.getTime() > todayDateOnly().getTime()) {
  throw new HttpError(400, "The received date must be on or before today — payments are entered after the deposit is in hand");
}
```

`todayDateOnly` joins the existing `business-days` import. The demo seed uses `receivedDate:
today` and passes unchanged. UI: add `max={formatDateOnly(todayDateOnly())}` to the bare
`<input type="date">` at `BatchDetail.tsx:667` (client-safe import — `business-days` is in
`src/lib`). Tests: tomorrow → 400; today and yesterday → OK.

### #80

- Widen `claimBatch`'s select (`receipts.ts:215–218`) with `controlTotal: true` and thread it
  through `claimLiveBatch`'s return — the figure is then read under the lock.
- In `postBatchInTx` after the "already posted" check and BEFORE `assertBatchMonthsOpen`: when
  `controlTotal !== null`, sum live payments (`deletedAt: null`) in integer cents with the file's
  own `cents()` helper (line 97 — the same arithmetic `toBatchDetail` uses), and refuse on
  mismatch:

```ts
throw new HttpError(400,
  `This batch does not balance — control total ${ct.toFixed(2)}, payments entered ${entered.toFixed(2)} ` +
  `(difference ${diff.toFixed(2)}). Enter the missing payments, or void this batch and re-key it ` +
  "with the correct control total.");
```

  The second sentence matters: `controlTotal` is immutable (createBatch is its only writer; the
  batch header has no edit path), so the refusal must name the way out (§5.14).
- Null `controlTotal` posts freely (balance is defined 0 — receipts.ts:17–19). Voided payments
  don't count (every existing sum filters them; so does this one).
- Tests (RED first): under-entered refused; over-entered refused; footed posts; null control total
  posts; a batch that footed, then had a payment VOIDED, refuses; empty batch with a non-null
  control total refuses. Existing `receipts.test.ts:202–230` already foots and stays green;
  the `voidBatch` tests at 553–579 use null control totals and stay green.

## Task 3 — #88: the broken-chain flag

`listClosePeriods` (`close-periods.ts:279–313`) already fetches EVERY row (no pagination), newest
first. Compute per row, in integer cents (the file's `cents()` at line 73):

- Find the prior CALENDAR month's row explicitly (`month-1` / year rollover) — never by array
  adjacency, since a gap month has no row.
- **CLOSED row, prior row exists** (any status — a REOPENED prior's `endingAr` is still its frozen
  last-close value, and its amber badge already signals the pending state): `chainBroken =
  cents(beginningAr) !== cents(prior.endingAr)`.
- **CLOSED row, no prior row**: `chainBroken = (an earlier-month row exists) || cents(beginningAr)
  !== 0` — a genesis month legitimately begins at 0 (`priorEndingAr`'s genesis rule); anything
  else is a gap or corruption, flagged.
- **REOPENED rows are never flagged themselves** — their figures are explicitly pending.

Add `chainBroken: boolean` and `priorEndingAr: number | null` to `ClosePeriodListItem`. No claim,
no audit, no isolation — the read stays exactly the plain `findMany` it is (Phase 8A rule,
restated in the ruling). UI (`Close.tsx` closed-periods row, the money line at 375–377): when
flagged, a red badge (`CHAIN BROKEN`) plus one sentence: "Beginning X no longer matches the prior
month's ending Y — re-close this month to re-chain." Nothing disabled, nothing refused.

Tests: `close-periods.test.ts` has NO `listClosePeriods` coverage today. Since this is a pure
read, raw `prisma.closePeriod.create` fixtures are legitimate (the reports precedent): intact
chain → no flags; prior re-closed with a different ending → next month flags; nonzero genesis →
flags; gap before a closed row → flags; REOPENED row itself → not flagged, but still serves as
the prior for its successor's comparison.

## Task 4 — #93: the export audit carries its journal

`exportClose`'s `auditedCreate` (gl-export.ts:188–190) records five scalars; `auditedCreate` never
runs `SNAPSHOT_INCLUDE`, so `audit.ts:236`'s `glExportBatch: { postings: true }` is inert (the
model has no update/soft-delete path — grep-verified). Fix per the issue's preferred option (a),
plus neutralize the dead entry:

- Add to the payload: `summary: summaryLines.map((l) => ({ side: l.side, account:
  l.glAccountName, debit: l.debit, credit: l.credit }))` — `glAccountName` is the frozen account
  number string the CSV itself prints, and the summary is bounded by 2 × chart-of-accounts size
  (typically 4–8 lines — recon measured), never by transaction volume. Keep `postingCount` (the
  per-event count) and add nothing else; the CSV/register bytes stay OUT of the audit row.
- Replace `SNAPSHOT_INCLUDE.glExportBatch` with `undefined` + a comment: create-only model, the
  create payload is self-contained by construction. If a `SNAPSHOT_SELECT` entry is cheap under
  the existing mechanism, add one excluding `file`/`register` as belt (the `storedDocument`
  precedent) — those two `Bytes` columns must never reach an audit row via a future update path.

Test (RED first): run a real `exportClose` over a small fixture, read the
`entity: "glExportBatch", action: "create"` audit row, assert `after.summary` matches the
aggregated journal (and Σdebit = Σcredit across it).

## Task 5 — #90: the minors bundle, per-item dispositions

| Item | Disposition |
|---|---|
| `db-errors.ts` 40P01 | **Fix.** Widen `isRawSerializationFailure` to accept `originalCode ∈ {"40001","40P01"}` (rename to say what it now is). A deadlock victim is safely retryable and deserves the same 409, not a bare 500. Unit tests with fabricated `P2010` errors |
| `retryOnSerializationConflict` retries ANY P2002 | **Fix.** Make the P2002 retry OPT-IN: `retryOnSerializationConflict(run, tries, { retryUniqueConflict })`, default false. Only `closePeriod`'s call site passes true (the year-month insert race is the one reachable P2002 the comment justifies); `reopenPeriod` and `retryAllocation` take the default — the allocation paths answer nonce P2002s by in-attempt replay, never retry (#115), and constraint-name discrimination via `meta.target` is NOT available on the driver-adapter stack (#40), so a boolean per call site is the honest scope. Unit test: a deterministic P2002 through the default path is thrown on attempt 1 |
| `schema.prisma:127` "Three separate FKs" | Comment → six (no SQL change; verify `migrate diff` stays empty) |
| `reference-links.ts:121–122` "four FKs" / "three billing accounts" | Comment → seven entries (six GL + one step code) |
| `Close.tsx:41` `kind: string` | Client-safe `ReadinessGapKind` union in `src/lib/gl-constants.ts`; `gl-mapping.ts` and `Close.tsx` both import it |
| Readiness `year >= 2000` floor | Shared `MIN_CLOSE_YEAR` constant in `gl-constants.ts`, used by `period.ts:14` and `close/route.ts:22`; add the missing upper bound (≤ 9999). The floor itself is correct (it exists for `Number(null) === 0` AND `Date.UTC`'s 0–99 → 1900s mapping — keep both reasons in the comment) |
| Empty no-op export | **Fix.** Short-circuit BEFORE `allocateNumber`: `if (lines.length === 0) throw new HttpError(400, "Nothing to export — this period has no unexported postings")`. Today's path burns a permanent export number and stores an indistinguishable empty batch row + header-only CSV + empty register PDF per click. The 400 lands before any write, preserving "consumes no number when the save fails". Update `gl-export.test.ts:229–230` (second export: postings 0 → now rejects naming nothing-to-export) |
| Register `money()` blank-for-zero | **No change** — deliberate register style, noted on the issue |
| `Close.tsx` per-row gap count | **No change** — the server 409 is the guard; a per-row readiness fetch would pre-empt it at N× the cost |
| `close-month-end.mjs` `p-3` locator | Cheap stabilization only if trivial (a `data-testid` on the period row); otherwise leave, it is an E2E-internal fragility |

## Task 6 — #132: retention health in a shell-only sidecar

Recon settled the design space: a field inside `backup-status.json` factually CANNOT survive —
`writeStatus` (backups.ts:388) serializes a four-field literal with no read-merge, and read-merge
is the property CLAUDE.md and backups.ts:5–9 explicitly forbid. So: **a second file,
`retention-status.json`, written ONLY by `scripts/backup.sh`**, which re-attempts retention every
night; the Node manual path never touches it, so the issue's failure mode is impossible by
construction.

- `backup-constants.ts`: `RETENTION_STATUS_FILENAME`; `backup-paths.ts`: `retentionStatusPath(dir)`
  (mirror of `statusPath`, stays a pure leaf).
- `backup.sh`: after the prune block, write `{ lastRunAt, ok, error }` (temp-then-rename, same
  style) — every run that reaches retention. The existing #120 main-status behavior is UNCHANGED
  (a retention failure still writes `ok:false` + `exit 1`); the sidecar is additional evidence,
  not a replacement.
- Reader: a tolerant `parseRetentionStatus` beside `parseStatus`; `evaluateHealth` gains ONE branch
  after the `!i.status.ok` branch: a readable sidecar with `ok:false` → `state: "failed"`, reason
  "The last backup succeeded, but the nightly retention cleanup is failing: <error> — old archives
  are accumulating." **Absence or corruption of the sidecar contributes nothing** — this is a
  deliberate, documented exception to file-level absence-is-failure: the MAIN status file's absence
  rule already covers "the nightly never ran", the sidecar self-refreshes every night, and reading
  absence as failure would red every existing install for up to 24h mid-upgrade. State this in the
  code comment.
- Filename drift guard: clone the 4-line `BACKUP_STATUS_FILENAME` guard
  (`backup-script.test.ts:180–183`) for the new literal. `retention-status.json` fails
  `isArchiveName`, so listing/pruning ignore it — extend the existing "ignores the status file…"
  pin (`backup-health.test.ts:105–113`) to name it explicitly.
- Tests (RED first): the issue's exact scenario — nightly writes retention-fail, a successful
  manual `doBackup` overwrites the MAIN status green, health is STILL red with the retention
  reason; sidecar ok:true → green; absent → green; corrupt → green (documented); the #120 script
  describe (backup-script.test.ts:132–171) additionally asserts the sidecar is written false on a
  failing `find` and true on a clean run. The suite never shells to a host `pg_dump` (standing
  rule) — the script tests already drive `backup.sh` with a doctored PATH; reuse that harness.

## Task 7 — #95: the two tripwires

Both use the established gate technique; the structural template is
`template-assignments.test.ts:550–611` (already a deleteCustomer pairing, one writer over), and
the canonical comment shape is `quote-links.test.ts:546–662`. New file
`tests/quote-delete-races.test.ts`.

**A — deleteCustomer ↔ createQuote.** Gate: Read Committed, holds the `quote_number_next` Setting
row FOR UPDATE (create the counter row explicitly after `truncateAll()` — quote-links.test.ts:599's
trap). `createQuote` (free-text lines ONLY, so the part read never runs and deleteCustomer's parts
guard stays at zero — the `customers.test.ts:453` fixture shape) fixes its snapshot at the
customer liveness read (quotes.ts:409), blocks at `allocateNumber`; the real `deleteCustomer`
commits (quote count 0); release. `createQuote` retries via `retryAllocation` (40001 absorbed —
the #115 wrinkle), and the fresh attempt sees the customer dead → 400. Assert the INVARIANT, not
the status: zero live quotes pointing at the customer, customer soft-deleted; the request
rejected. Comment records: (1) the RED procedure — pin `deleteCustomer`'s transaction to Read
Committed and the test goes green-both-commit with a live quote on a deleted customer; (2) **the
immutability dependency**: the guard counts rows whose `customerId` never changes because
quotes.ts:1277 refuses re-points — relax that and an `updateQuote` re-point lands on a
just-counted customer WITHOUT even being Serializable unless the payload also carries lines
(`assignsFk`, quotes.ts:1269).

**B — deletePart ↔ attachPart.** Gate: Read Committed, holds the QUOTE row FOR UPDATE (attachPart
blocks at `claimQuote`, quotes.ts:1369, with its snapshot already fixed). The real `deletePart`
commits (no live order/quote lines reference the part); release; `attachPart` reads the part on
its stale snapshot, writes `QuoteLine.partId`, and SSI aborts it — no retry wrapper on
`attachPart`, so assert HttpError 409 AND the invariant (no live quote line carries the dead
part). RED procedure in the comment: pin `deletePart` to Read Committed.

House rules that bit before: fixtures raw-prisma; per-file `asSystem`; 20 000 ms gate timeouts;
`setTimeout(…, 200)` after starting the blocked racer; never `vi.spyOn` a delegate.

## Sequencing and process

Order: Task 1 (#139/#140, the bug class) → Task 2 (#73/#80) → Task 3 (#88) → Task 4 (#93) →
Task 5 (#90) → Task 6 (#132) → Task 7 (#95). TDD per task — every RED watched failing for the
right reason and recorded in the implementer report. Per-task review (task-reviewer agent) with
fix rounds until Approved. Gates from `erp/` only. E2E in background near the end (UI is touched:
ShipmentDetail, BatchDetail, Close.tsx). PR closes all nine (`Closes #…` ×9), attribution in the
PR body, then the Codex rounds to green.

Docs owed with the merge: HANDOFF header + §6/§9, backlog doc Group E section, spec §15 only if a
ruling is amended (none expected — all four rulings are already recorded).

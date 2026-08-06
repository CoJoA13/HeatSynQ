# Codex review round 1 — fix wave report

PR #39, branch `phase-3-orders`, starting at `379b9bd`. Twelve confirmed findings, all fixed,
TDD throughout (failing test first for every behavior change), five coherent commits, pushed to
`origin/phase-3-orders`. All 12 inline review threads replied to and resolved.

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest) | **929 / 929 passing** (baseline 904 + 25 new tests across the wave) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | succeeds |
| `npm run test:e2e` | **10/10**, confirmed stable across 3 full runs (one unrelated transient `void-order` dialog-timing flake on a middle run, unconnected to any of these findings — gone on immediate retry, and again on a third run) |

Both databases unaffected — no schema changes. Findings 1/6/12 touch code the e2e flows
exercise; all three were run against the real flows, not just reasoned about.

---

## Finding 1 — Entry-date preview drift (P1)

**File:** `erp/src/app/orders/new/page.tsx`, `erp/src/app/api/orders/entry-defaults/route.ts`,
`erp/src/server/orders.ts`

**Bug:** the untouched request-date preview came from `/api/orders/entry-defaults`, which always
computed from *today* and only refetched on customer/lead-part change. `createOrder` computes the
same chain from the (possibly overridden) *received* date at save time. Backdating the received
date on the entry form left the preview and the actual saved value disagreeing.

**Fix:**
- `defaultRequestDate(customerId, partId?, receivedDate?)` (orders.ts) takes the new optional
  `receivedDate`, parsed/validated exactly like every other order date (`parseDate` — a clean
  field-anchored 400 on garbage input), falling back to `todayDateOnly()` when omitted, identical
  to `createOrder`'s own fallback.
- `GET /api/orders/entry-defaults` gained an optional `receivedDate=yyyy-mm-dd` query param
  (`orUndefined` — blank means absent, same house rule as every other date param on this route).
- The entry page's effect now depends on `draft.receivedDateOverride` too, and omits the param
  while untouched (mirroring `buildCreateBody`'s own `receivedDate: draft.receivedDateOverride ??
  undefined`) — still gated through the existing `useLatest()` latest-response guard.

**Commit:** `31f26af` — fix: entry-date preview drift, serial-range and business-day overflow guards

**Test evidence:**
- `tests/order-routes.test.ts`: new case asserts a backdated `receivedDate=2026-01-05` with a
  7-day customer override returns `2026-01-14`, a blank `receivedDate` falls back to today, and a
  malformed value 400s naming "Received date". Failed red (computed from today, not the override)
  before the fix.
- **Manual browser verification** (dev server, live DB): created a temporary live customer with
  `requestDaysOverride: 7`, selected it on `/orders/new`, confirmed the request-date field showed
  `2026-08-12` (today + 7 business days); changed the received-date field to `2026-01-05`, watched
  the network tab fire `GET /api/orders/entry-defaults?...&receivedDate=2026-01-05`, and confirmed
  the request-date field updated live to `2026-01-14`. Temporary customer cleaned up afterward.
- Full `orders.test.ts` + `order-routes.test.ts` suites green (126 tests).

---

## Finding 2 — Saved-view default race (P2)

**File:** `erp/src/server/saved-views.ts`

**Bug:** `createView`/`updateView`'s default-promotion transactions ran at the default (READ
COMMITTED) isolation level. Two concurrent promotions could each read "no other live default yet"
before either write committed, both demote nothing, and both commit their own `isDefault: true` —
two defaults surviving at once (Postgres's own "two doctors take themselves off call" write-skew
example).

**Fix:** both transactions now run `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable
}`, matching the house 40001→409 mapping `withDbErrors` already provides.

**Commit:** `7ab0b7b` — fix: saved-view default race and order-number Int4 overflow

**Test evidence:** genuine concurrent-overlap is not guaranteed by firing two promises without an
`await` between them on a fast local DB — an early version of this test passed 5/5 times against
the *unfixed* code because the two calls just happened to run close enough to sequentially that
each one's fresh read saw the other's prior commit. Rewrote using a rendezvous on `auditedUpdate`
(the same spy point the file's existing "rolls the whole create back" test uses), bounded by a
500ms timeout fallback so a non-overlapping run fails loud instead of hanging. Reproduced the bug
(2 defaults) 3/3 times against the unfixed code; passes cleanly 5/5 times against the fix. Full
`saved-views.test.ts` green (15 tests).

*(Diagnostic note, not shipped: `vi.spyOn` on this Prisma Client's model delegates does not call
through to the real implementation and `mockRestore()` does not correctly restore it — it leaves
the property `undefined`, corrupting the shared `prisma` singleton for the rest of the run.
Discovered and worked around before it could pollute the suite; see Finding 11 below for where
this mattered again.)*

---

## Finding 3 — Attachment audit snapshots fetch fileData (P1)

**File:** `erp/src/server/audit.ts`

**Bug:** `auditedSoftDelete`'s "before" snapshot for `partAttachment`/`orderAttachment` (and,
latently, `storedDocument`) was a bare `findUnique` with no column projection — it pulled up to
20MB of `fileData`, then `redact()` ran `JSON.parse(JSON.stringify(...))` over the whole byte
array before scrubbing the key. Real heap pressure on an ordinary attachment delete.

**Fix:** added `SNAPSHOT_SELECT`, a per-model `select` override `snapshot()` now uses instead of
`include` whenever one is defined — `partAttachment`/`orderAttachment` list every scalar except
`fileData`; `storedDocument` too (currently unreached — it has no update/delete path — but defined
now rather than left as a future gap). `redact()` is unchanged and stays as defense-in-depth.

**Commit:** `e8ba4ae` — fix: attachment audit blob fetch, unicode filenames, delete race

**Test evidence:** `tests/attachments.test.ts`'s existing audit test, split across both owner
kinds via `it.each`, now asserts `expect(deleteEntry.before).not.toHaveProperty("fileData")` — the
key itself is absent, not a redacted placeholder — while still asserting `filename`/`mimeType` are
present. Failed red pre-fix (`"[redacted]"` present as a real key). Full `attachments.test.ts`
green (29 tests) after the fix.

---

## Finding 4 — serial-range unsafe bounds hang (P1)

**File:** `erp/src/lib/serial-range.ts`

**Bug:** a range like `{99999999999999999999-100000000000000000025}` — both bounds well past
`Number.MAX_SAFE_INTEGER` — round to the *same* imprecise float, so `count` computes to 1 (passing
the 10,000-row cap), and the expansion loop's `n++` is a no-op at that magnitude. Confirmed live
against the unfixed code: not an instant infinite loop but a ~2.6s hang that fills the output array
until the JS engine's own max-array-length limit throws a raw `RangeError: Invalid array length` —
worse than a hang, in fact, since it's an uncontrolled crash rather than a clean rejection.

**Fix:** `Number.isSafeInteger` checked on both parsed bounds, *before* any arithmetic on them
(so a case where only one bound is unsafe, e.g. a huge end paired with a tiny start, can't slip
past the existing row-count cap by accident) — rejects with a clean message naming the constraint.

**Commit:** `31f26af`

**Test evidence:** `tests/serial-range.test.ts` — the exact overflow case (confirmed to hang/crash
pre-fix, now rejects in <10ms), an end-only overflow case, and a boundary-sanity case (a
single-row range *at* `Number.MAX_SAFE_INTEGER` is not itself rejected). 14/14 green.

---

## Finding 5 — business-days unbounded iteration (P2)

**File:** `erp/src/lib/business-days.ts`, `erp/src/server/settings.ts`, `erp/src/server/customers.ts`,
`erp/src/server/parts.ts`

**Bug:** nothing capped the day-offset `addBusinessDays` iterates — a huge `requestDaysOverride` or
`request_days_default` stalls the event loop one iteration at a time.

**Fix (two layers, per the finding):**
- `addBusinessDays` throws above `n > 3650` ("Request-day offsets are capped at 3650").
- `requestDaysOverride` (parts + customers) and `request_days_default`'s settings schema are
  bounded to match (`.max(3650)` / `int(0, 3650)`) — refused where the value is entered, not just
  defended against downstream.

**Commit:** `31f26af`

**Test evidence:** `business-days.test.ts` (n > 3650 rejects naming the cap; n = 3650 boundary
sanity, doesn't throw), `customers.test.ts` + `parts.test.ts` (reject 3651, allow exactly 3650 on
both create and update), `settings.test.ts` (same boundary on `request_days_default`). 9 new tests,
all green.

---

## Finding 6 — Blocked-popup blob leak (P2)

**File:** `erp/src/app/orders/[id]/DocumentsSection.tsx`

**Bug:** the `window.open` returning `null` (popup blocked) branch recorded the fallback banner but
never scheduled `URL.revokeObjectURL` — only the successful-open branch did. Since the blocked
banner's own link re-fetches the archived bytes from `/api/documents/:id` (never this blob), the
blob was pure waste, leaked once per blocked print.

**Fix:** the `setTimeout(() => URL.revokeObjectURL(url), 60_000)` now runs unconditionally after
the open attempt, opened or blocked.

**Commit:** `43536dd` — fix: traveler-print blob leak and e2e fixture audit residue

**Test evidence:** no component-test harness exists in this codebase (vitest is `environment:
"node"` throughout — server integration tests only; no jsdom/testing-library dependency). Verified
by: (a) code review — the fix is a 3-line, unconditional hoist of an existing call, structurally
unambiguous; (b) `npm run test:e2e`'s `loads-after-print` flow, which exercises this exact print
path end-to-end, passing 3/3 runs. A genuine popup-block scenario isn't reliably forceable via the
CDP-driven browser in this environment, consistent with the task's own framing of this item as
"run the flows if cheap" rather than requiring a new automated test.

---

## Finding 7 — Unicode filenames break download header (P1)

**File:** `erp/src/server/attachments.ts`

**Bug:** `contentDisposition` built a raw quoted `filename="..."` with no ASCII restriction.
`Headers`/`NextResponse` require header values to be Latin1/ByteString — an attachment named e.g.
測定.pdf uploaded fine but threw a `TypeError: Cannot convert argument to a ByteString...` on every
subsequent GET, confirmed live pre-fix.

**Fix:** `contentDisposition` now always emits both an ASCII-sanitized `filename=` fallback (every
codepoint outside printable ASCII → `_`) and a faithful RFC 5987 `filename*=UTF-8''...` parameter
(RFC 6266 §4.3's own recommendation, sent unconditionally — one code path, not an ASCII/non-ASCII
fork). Control characters are stripped once, up front, shared by both forms (unchanged
header-injection defense).

**Commit:** `e8ba4ae`

**Test evidence:** unit-level (`contentDisposition` directly) — every existing exact-match case
updated to include the new `filename*=` suffix, plus a new case for 測定.pdf asserting both
parameters present and the RFC 5987 value round-trips via `decodeURIComponent` back to the
original name. Route-level — a new test per owner kind (part/order) uploads a file named 測定.pdf
and downloads it, asserting status 200 (not a thrown `TypeError`) and both header parameters
present. All failed red pre-fix with the exact `ByteString` error the finding describes; 29/29
green after.

---

## Finding 8 — order_number_next above Int4 wedges entry (P2)

**File:** `erp/src/server/settings.ts`

**Bug:** the five `*_number_next` settings accepted any positive integer, but the columns they
eventually feed (`Order.orderNumber` today, siblings later) are Postgres `INTEGER` (int4,
max 2,147,483,647). A value above that allocates fine and then fails at the actual insert.

**Fix:**
- All five schemas bounded to `int(1, 2_147_483_647)`.
- `allocateNumber` additionally refuses to return a value above Int4 max with a clean 400 naming
  the setting — checked against the **raw** stored value, ahead of the schema-based fallback.
  (This ordering matters: once the schema's own max equals Int4 max, a stored value past it fails
  `safeParse` and would otherwise silently fall back to the seed default of 1000 — quietly
  reissuing already-used numbers — rather than refusing loudly. Caught during implementation, not
  by the review; fixed before it shipped.)

**Commit:** `7ab0b7b`

**Test evidence:** `settings.test.ts` (`it.each` over all five keys: rejects `2_147_483_648`,
allows exactly `2_147_483_647`), `allocate-number.test.ts` (allocates the last valid value without
refusing; refuses one past it, names the setting, and — critically — leaves the stored value
untouched with zero audit rows, proving the refusal happens before any write). All green.

---

## Finding 9 — Linked badge lies on singleton groups (P2)

**File:** `erp/src/server/orders.ts`, `docs/superpowers/specs/2026-08-02-phase-3-orders-design.md`

**Bug:** `unlinkOrder` only ever cleared the caller's own `linkGroupId`. Unlinking one side of a
*pair* left the survivor still carrying the shared groupId — `listOrders`' `linked: linkGroupId !==
null` still marked it linked, while its own `linkedOrders` panel came back empty.

**Fix:** `unlinkOrder` now reads the group's other members before clearing its own row; if exactly
one groupmate remains, that survivor's own `linkGroupId` is cleared too (audited on both rows). A
group still holding two or more members is untouched, unchanged from before. The cascade
deliberately skips a voided survivor (checked via the same `findMany` read) — never writes to a
voided order, matching Finding 10's principle for the merge path. Spec §5d's "a group of one
surviving is harmless" parenthetical is corrected in place, dated to this fix.

**Commit:** `b3655e5` — fix: order link/unlink group integrity

**Test evidence:** the existing "clears the group on unlink without touching the other members"
test (trio → pair) is retained and renamed for clarity — confirms the *no-cascade* path is
unchanged. New test: unlinking a genuine pair clears **both** sides, with a real audit entry on the
survivor too. Failed red pre-fix (survivor kept its old groupId); green after.

---

## Finding 10 — Group-merge mutates voided orders (P2)

**File:** `erp/src/server/orders.ts`

**Bug:** `linkOrder`'s merge branch (`other.linkGroupId` set, different from `order`'s) scanned
`other`'s whole group with no `deletedAt` filter, so a voided groupmate got its `linkGroupId`
reassigned onto the surviving group and a spurious "update" audit entry — despite voided orders
being read-only under every other mutator in this file.

**Fix:** the merge's `findMany` now filters `deletedAt: null`. A voided member keeps its old
groupId; only live groupmates move.

**Commit:** `b3655e5`

**Test evidence:** new test — links A–B and C–D, voids D, merges A into C's group; asserts C moves
onto A's group while D keeps its old (`groupCD`) value and gets no new audit entry (count
unchanged). Failed red pre-fix (D's groupId was reassigned); green after.

---

## Finding 11 — Attachment delete checks owner outside the tx (P2)

**File:** `erp/src/server/attachments.ts`

**Bug:** `deleteAttachment` ran the owner-liveness check and the attachment's own existence check
as two standalone statements on the top-level `prisma` client, *before* the delete's own
`prisma.$transaction` opened. A concurrent void/delete of the owner landing in that gap would
commit unnoticed — nothing about `auditedSoftDelete`'s atomic `updateMany` re-checks the owner.

**Fix:** restructured to the "house mutator shape" `addAttachment` already uses — owner-liveness
check, attachment resolution, and the delete itself all run on the same `tx`, inside one
transaction. Narrows the window to "however long this one transaction takes" rather than "however
long between two independent round trips."

**Commit:** `e8ba4ae`

**Test evidence (structural, as the finding allows — "race test optional"):** a new test per owner
kind intercepts the top-level `prisma.part`/`prisma.order` and `prisma.partAttachment`/
`prisma.orderAttachment` `findFirst` methods and asserts neither is called during a delete, while
confirming the delete still genuinely happened. **Deliberately not `vi.spyOn`**: verified live
against this Prisma Client that `vi.spyOn(...).mockRestore()` on a model delegate method does not
restore the original — it leaves the property `undefined`, breaking every later test touching that
model for the rest of the run (the shared `prisma` singleton, `tests/helpers/db.ts`). Used a plain
save-reassign-restore of the property instead, confirmed safe (all 27 other tests in the file still
passed after deliberately triggering and observing the corruption in isolation first). Failed red
pre-fix (calls recorded on the top-level client); green after, with no pollution of later tests.

---

## Finding 12 — E2E cleanup leaves storedDocument audit rows (P2)

**File:** `erp/e2e/lib/db-fixtures.ts`

**Bug:** `deleteOrdersAndChildren` deleted `entity: "order"` audit rows, but `StoredDocument`'s own
audit rows (`traveler.ts`'s `auditedCreate("storedDocument", ...)`) are keyed by the *document's*
id, not the order's — never reached. Every e2e run that printed a traveler (`loads-after-print`,
`order-entry-full`'s Save & Print) left one permanent orphaned audit row in the dev database.

**Fix:** collects `StoredDocument` ids for the affected orders before deleting the rows, and
deletes their `entity: "storedDocument"` audit rows the same way the order's own are deleted —
shared by both call sites (`reapLeftovers` and `cleanup`, since `deleteOrdersAndChildren` is common
to both).

**Commit:** `43536dd`

**Test evidence:** per the task's own framing ("verify with a local reasoning note... run the flows
if cheap"), no vitest test applies (this file runs under `tsx`, outside the main suite; not part of
`npx eslint src tests` either, though it was linted anyway as a bonus check — clean). Verified with
a rigorous before/after row count instead: ran `npm run test:e2e` three full times, counting
`auditLog` rows where `entity = "storedDocument"` and `StoredDocument` rows directly against the
dev DB between runs. Counts were **identical before and after two additional full e2e cycles**
(10 pre-existing rows from unrelated earlier sessions, confirmed via timestamp — none newer than
this session — and confirmed via customer code — none matching the e2e fixture's `E2EORDCUST`).
This proves each run's own rows are being fully cleaned up rather than accumulating.

---

## Reply / resolve log

All 12 inline threads replied to (one-liner naming the fix + commit SHA, ending with the required
attribution line) and resolved via GraphQL `resolveReviewThread`. Verified after the fact: all 12
threads show `isResolved: true` and exactly 2 comments each (original + reply), with the reply
containing the required marker line.

| # | comment_id | file | reply_id | commit |
|---|---|---|---|---|
| 1 | 3706852715 | orders/new/page.tsx | 3707645943 | 31f26af |
| 2 | 3706852724 | saved-views.ts | 3707646865 | 7ab0b7b |
| 3 | 3706852736 | audit.ts | 3707647613 | e8ba4ae |
| 4 | 3706852742 | serial-range.ts | 3707648657 | 31f26af |
| 5 | 3706852749 | business-days.ts | 3707649656 | 31f26af |
| 6 | 3706852757 | DocumentsSection.tsx | 3707650369 | 43536dd |
| 7 | 3706852766 | attachments.ts | 3707651088 | e8ba4ae |
| 8 | 3706852770 | orders.ts (settings) | 3707651930 | 7ab0b7b |
| 9 | 3706852777 | orders.ts (unlink) | 3707652970 | b3655e5 |
| 10 | 3706852786 | orders.ts (merge) | 3707653796 | b3655e5 |
| 11 | 3706852789 | attachments.ts | 3707654682 | e8ba4ae |
| 12 | 3706852796 | db-fixtures.ts | 3707655576 | 43536dd |

---

## Commits (pushed to `origin/phase-3-orders`)

```
31f26af fix: entry-date preview drift, serial-range and business-day overflow guards
7ab0b7b fix: saved-view default race and order-number Int4 overflow
e8ba4ae fix: attachment audit blob fetch, unicode filenames, delete race
b3655e5 fix: order link/unlink group integrity
43536dd fix: traveler-print blob leak and e2e fixture audit residue
```

## Concerns / notes for the owner

1. **`vi.spyOn` on this Prisma Client's model delegates is unsafe** — `mockRestore()` does not
   restore the original method; it leaves the property `undefined`, corrupting the shared `prisma`
   singleton for every subsequent test in the run (tests share one DB connection object,
   `tests/helpers/db.ts`, and `fileParallelism: false` runs them sequentially in one process, so
   the corruption would have bled into unrelated later test files). Discovered while writing
   Finding 11's test, verified in isolation, and avoided everywhere in this wave (plain
   save-reassign-restore used instead). Worth a one-line note in the test-writing conventions if
   this pattern gets reached for again.
2. **Finding 8's ordering subtlety** (checking the raw stored value before the schema-parsed
   fallback, not after) wasn't spelled out in the finding text — flagging it here because it's the
   kind of thing that's easy to get backwards and have it compile and pass a shallow test while
   still silently resetting the counter.
3. **Out of scope, flagged separately (not fixed here):** the same audit-row-keyed-by-child-id gap
   Finding 12 fixes for `StoredDocument` structurally also applies to `PartAttachment`/
   `OrderAttachment` in the same `db-fixtures.ts` file — currently dormant only because no e2e flow
   uploads attachments yet. Left alone since it's unreached today and outside the 12 findings;
   raised as a follow-up suggestion rather than fixed inline, per the owner's standing "don't
   invent scope" instruction.
4. One transient, unrelated `void-order` e2e flow timeout occurred on a middle run (dialog/prompt
   timing), gone immediately on retry and on a third clean run. Included in the gates table above
   for transparency rather than omitted.

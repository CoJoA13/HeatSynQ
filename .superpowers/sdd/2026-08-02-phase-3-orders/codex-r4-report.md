# Codex review round 4 — fix wave report

PR #39, branch `phase-3-orders`, starting at `6c0ae10` (the tip of round 3's fix wave). Nine
confirmed findings, all fixed, TDD throughout (a failing test first for every behaviour change),
nine commits — one per finding, plus one docs commit — pushed to `origin/phase-3-orders`. All nine
inline review threads replied to (short-SHA in each reply) and resolved via GraphQL
`resolveReviewThread`.

Per the task's standing warnings: no `vi.spyOn` on Prisma delegates anywhere in this wave — every
interception is a plain save-reassign-restore in a `try/finally` (the `attachments.test.ts`
precedent, extended here to `prisma.$transaction` itself). No new PDF byte-comparison was needed,
so the `/Count` marker technique did not come up; the existing print-race tests were re-run
unchanged.

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest) | **1010 / 1010 passing** (baseline 961 + 49 new tests across the wave) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | succeeds |
| `npm run test:e2e` | **10/10** |
| `prisma migrate status` | clean on both `erp` and `erp_test` (16 migrations; one new, applied to both) |

Schema change this wave: `Order.clientRequestId String? @unique` (finding 5) via a hand-written
migration (`20260804010000_order_client_request_id`, TTY-less recipe — Prisma 7's `migrate dev`
refuses in this non-interactive shell), applied to both databases, `prisma generate` re-run,
`migrate status` confirmed clean on both. The phase 3 spec (§4 `model Order` plus the sweep-
exemption note beside `orderNumber`) is updated to match.

---

## Finding 1 — bound uploads BEFORE parsing (P1)

**File:** `erp/src/server/http.ts`, `erp/tests/attachments.test.ts`

**Bug:** the 20 MB cap ran only in `addAttachment`, on `file.data.byteLength` — i.e. only after
`req.formData()` had already buffered the entire request body into memory. The cap bounded what
could be STORED and left what could be ALLOCATED unbounded.

**Fix:** `assertDeclaredUploadSize(req)` runs first in `parseUploadFile`. Digits-only parse of
`Content-Length` (`Number("")` is 0 and `Number("0x10")` is 16, either of which would let a
meaningless header stand in for a declaration); over `MAX_UPLOAD_BODY` (21,000,000 — deliberately
above the 20 MB per-file cap, because the declared length covers the whole multipart envelope) →
**413**; absent or malformed → **400** naming the header. Refusing an undeclared body is
deliberate: without a declaration there is no bound to check, and "buffer it and see" is the thing
being prevented. Every browser sets it on a multipart POST.

**Commit:** `860012a`

**Test evidence:** `tests/attachments.test.ts`, both owners. The over-declaration case posts three
bytes of an allowed type — it would 200 under the old code and under any post-parse check, so the
declared size is the only thing a pre-parse guard can possibly notice — and asserts 413 plus an
empty attachment list. Three undeclared/malformed cases (missing, "lots", "-1") assert 400 naming
`Content-Length`. Eight failures before the fix.

**Note carried into the PR reply:** full streaming enforcement — counting bytes as they arrive and
aborting mid-stream, which is what catches an UNDER-declared body — remains filed as **issue #38**.
This closes the trivially-exploitable honest-declaration and undeclared cases.

**Collateral:** `uploadReq` in the test file now sets `content-length` by hand. Measured, not
assumed: undici's `new Request(url, { body: formData })` leaves the header null and streams the
body, unlike a browser, so without this every request the suite builds would look undeclared.

---

## Finding 2 — attachment writes must pair with deletePart's Serializable scan (P2)

**File:** `erp/src/server/attachments.ts`, `erp/tests/attachments.test.ts`

**Bug:** `deletePart` (parts.ts) runs Serializable precisely so a child added mid-delete cannot
outlive its parent — the F2 pairing `addPartSpec`/`addPartInspection`/`addPartBreak` already hold
up from their end. Attachments joined the delete cascade in R3 finding 5 without joining that
pairing: their transactions ran at the default isolation, where a disjoint
`INSERT INTO "PartAttachment"` conflicts with nothing `deletePart` does. The cascade could snapshot
the live attachments, soft-delete exactly those, and commit, while a concurrent upload — whose
owner check legitimately saw a live part on its own older snapshot — inserted bytes that ended up
LIVE under a deleted part: unreachable behind every guard afterwards, and absent from the parent's
history.

**Fix:** `addAttachment` and `deleteAttachment` both run Serializable, uniformly for BOTH owners.
The order owner already serializes through `claimOrder`'s row lock, so it is belt-and-braces
there — but a per-owner isolation split would be one more thing to remember correctly at every
future call site, and `withDbErrors` already maps 40001/P2034 to the retryable 409 on both paths.

**Commit:** `d03a9dc`

**Test evidence:** two tests, both red before the fix.
- **Structural:** `prisma.$transaction` is intercepted and its options recorded; `addAttachment`
  and `deleteAttachment` each open exactly one transaction, at Serializable, for each owner
  (`undefined` before).
- **Behavioural, with the interleaving FORCED rather than left to chance.** The holder reproduces
  `deletePart`'s read/write set on the part (live-part check, live-attachment cascade scan, then
  the part's own soft delete) in one Serializable transaction, and takes `SELECT … FOR UPDATE` on
  the Part row first. That is what makes it deterministic: a concurrent INSERT into
  `PartAttachment` must take FOR KEY SHARE on the referenced Part row for its foreign key, and FOR
  KEY SHARE conflicts with FOR UPDATE — so the REAL `addAttachment` gets its owner check through
  (the part is genuinely still live then) and is pinned at exactly the moment the finding
  describes, after the check and before the insert, until the delete commits. The 200 ms
  `Promise.race` confirms the pin (traveler.test.ts precedent). The assertion is the invariant, not
  a particular loser: any rejection must be a mapped 404/409, and afterwards there must be **no
  live attachment under the deleted part**. Before the fix that count was 1.

---

## Finding 3 — manual load qty Int4 bound (P2)

**File:** `erp/src/server/order-loads.ts`, `erp/src/server/orders.ts`

**Bug:** the auto-split path's qty already carried the Int4 bound (R2 finding 3), but the MANUAL
load editor bounded qty only below (`min(1)`). `Load.qty` is a Postgres `INTEGER`, so anything past
2,147,483,647 was an unmapped 22003 numeric overflow escaping the transaction as a 500 rather than
this schema's own field-anchored 400.

**Fix:** `.max(INT4_MAX)` on `LOAD_ITEM.qty`. `INT4_MAX` is now exported from orders.ts rather than
duplicated — same column ceiling, different door.

**Commit:** `5bb41f5`

**Test evidence:** `tests/order-loads.test.ts` — 2,147,483,648 rejects as a `ZodError` (before the
fix it was a `PrismaClientKnownRequestError`, which the failure output named); the ceiling itself
still round-trips, so the bound is the column's, not an arbitrary one.

---

## Finding 4 — MAX_LOADS on manual replacement (P2)

**File:** `erp/src/server/order-loads.ts`

**Bug:** `MAX_LOADS` was enforced only on the auto-split path (`runSplitLoads`), so a hand-built
array could set a load count no split would ever produce — one INSERT per row inside a single
Serializable transaction.

**Fix:** `REPLACE_LOADS = z.array(LOAD_ITEM).min(1).max(MAX_LOADS, MAX_LOADS_MESSAGE)`, the ceiling
named in the message ("An order cannot have more than 10,000 loads") — a refusal has to say what
the limit is.

**Commit:** `5bb41f5`

**Test evidence:** 10,001 rows rejects as a `ZodError` whose readable message contains "10,000",
and the order's existing three loads are untouched (the cap is reached before the transaction
opens). Verified discriminating by reverting the `.max()` and re-running.

---

## Finding 5 — the 409 retry can double-create from two tabs (P1)

**Files:** `erp/prisma/schema.prisma`, `erp/prisma/migrations/20260804010000_order_client_request_id/`,
`erp/src/server/orders.ts`, `erp/src/lib/idempotent-save.ts`, `erp/src/app/orders/new/page.tsx`,
`erp/tests/partial-unique-sweep.test.ts`

**Bug:** two tabs resume the SAME autosaved draft and both Save. The save is Serializable and
`allocateNumber` is a write-write conflict, so the loser aborts with 40001 → the retryable 409 —
and the entry page retries it automatically, correctly, because that 409 is the documented "wrote
nothing, consumed no number" outcome. That retry was, to the server, a brand-new request: it
allocated the next number and created a SECOND order for one operator action. `orderNumber` being
unique never helped, since the retry legitimately allocates its own.

**Fix, in four parts.**

- **Schema.** `Order.clientRequestId String? @unique`. Nullable, so historic rows and any caller
  that sends no nonce are unaffected (Postgres NULLs never collide in a unique index — omitting the
  nonce opts out rather than conflicting). Plain unique, deliberately NOT live-rows-only: a voided
  order keeps its request id forever, exactly as it keeps its number, because handing the nonce
  back to a retry is precisely the duplicate the column exists to stop. The sweep exemption sits
  beside `Order.orderNumber` with that rationale written out. Hand-written additive migration
  (TTY-less recipe), applied to both DBs, client regenerated.
- **Server.** `CREATE` accepts optional `clientRequestId: z.string().uuid().optional()` — `uuid()`
  rather than a free string so a caller cannot pin a constant and silently make every save a replay
  of its first. `createOrder` stores it on the row. On P2002 for THAT column it fetches the existing
  order and returns `{ order, warnings: [], deduped: true }`. The transaction body moved into
  `saveNewOrder` so the replay catch wraps one call instead of threading through a 100-line body;
  the catch sits inside `withDbErrors`' callback and outside the transaction, so the failed attempt
  has fully rolled back and the winner is committed and readable by the time it runs. Anything that
  is not this exact collision falls straight through to `withDbErrors` unchanged.
- **Discriminating the collision — measured, not assumed.** `meta.target` is EMPTY on this stack.
  Under Prisma 7's pg driver adapter a P2002 arrives as
  `meta = { modelName, driverAdapterError: { cause: { originalCode: "23505", constraint: { fields: ['"clientRequestId"'] }, originalMessage } } }`,
  with no `target` key at all — which is also why `db-errors.ts`'s own P2002 branch always falls
  through to its `conflictField` fallback. `isDuplicateClientRequestId` reads `meta.target` first
  (so it keeps working if an adapter ever populates it), then the adapter's `constraint.fields`,
  then the driver message; field names arrive quoted, hence substring rather than equality. Getting
  this wrong permissively would turn a numbering bug into a silent wrong-order response, so the
  check names the column rather than assuming "the only unique on Order". The first implementation
  used `meta.target` alone and failed the tests — the probe that found the real shape is what
  produced the comment.
- **Client.** `OrderDraftState` gains `clientRequestId`; `blankDraft()` mints a `crypto.randomUUID()`
  when a fresh form mounts, and `normalizeDraft` KEEPS whatever a resumed draft carries (minting
  only for a pre-existing draft with none, or an unusable value) — that keeping is the entire
  mechanism. `buildCreateBody` sends it, and `handleSave` now goes through
  `submitWithConflictRetry(body, submitOnce)`, which resends the SAME object by reference.
  Rebuilding the body for the retry would mint a new nonce and recreate the duplicate. A deduped
  success arrives with no warnings and therefore takes the existing straight-to-the-order navigate
  path; `deduped` is additive, so every existing caller reading `{ order, warnings }` is untouched.

**Commit:** `c6c99cc` (plus `1921f7e` for the spec)

**Test evidence:** `tests/orders.test.ts` — same nonce twice creates ONE order and the second call
returns the first with `deduped: true` and one number consumed; a fresh save carries no `deduped`
key at all (`Object.keys` pinned, so the response contract is unchanged for old callers); different
nonces are two orders; omitting the nonce leaves behaviour byte-identical (two orders, both NULL);
two concurrent saves plus the loser's 409 retry settle on exactly one order; a non-uuid rejects; and
a voided order still owns its request id, so a replay returns the voided order rather than a new
one. `tests/idempotent-save.test.ts` covers the client half, including the reference identity of
the retried payload (the property that makes the whole thing work) and `normalizeRequestNonce`'s
keep/mint matrix. Five of the service tests failed before the fix.

---

## Finding 6 — hub whole-order mutation responses can apply out of order (P2)

**Files:** `erp/src/lib/use-latest.ts`, `erp/src/app/orders/[id]/page.tsx` + all five sections

**Bug:** every hub action replaces the whole `order` state, so overlapping calls raced and the
winner was whichever response arrived last. A slow line edit answering after a fast bulk replace
put the page back to a state the server had already moved past — and not merely as stale display:
the sections' bulk-grid overlays compose against those rows, so a reverted row set also drags their
pending edits into `detectOrphans`' churn path.

**Fix:** `makeMutationGate` / `useMutationGate` alongside `makeLatestGate`. A ticket is taken at
DISPATCH and a completion is applied only if nothing newer has been applied. `makeLatestGate` is
deliberately NOT reused: it keeps only the newest ISSUED ticket, which would discard an early
finisher's result even when it is the only one that ever arrives — fine for a fetch-into-state,
wrong for a save whose response is the only report of a write that happened.

`applyMutation` now takes the request as a THUNK (`(run: () => Promise<OrderMutationResult>) =>
Promise<void>`, exported as `ApplyMutation` so the five sections share one type), because a ticket
taken after the caller's own `await` would order responses by arrival — the bug, not the fix. All
ten call sites converted; rejections still pass straight through to each caller's own catch, and
each caller's follow-up work (`grid.reset()`, `onError(null)`, `clearDraft`) is unchanged.
`load()`'s full refresh shares the same sequence rather than a private counter, so a refresh and a
mutation cannot each be "newest" on their own counter and clobber each other.

**Commit:** `b3498d1`

**Test evidence:** `tests/use-latest.test.ts` — in-order completions all apply; an earlier request
that finishes first still applies and the later one applies over it; a completion older than the
newest already applied is ignored (the finding's shape); a re-applied ticket is ignored; stragglers
stay ignored across several rounds.

---

## Finding 7 — {1-10000} serial expansion is quadratic (P1)

**Files:** `erp/src/lib/bulk-grid.ts`, `erp/src/app/orders/[id]/SerialsSection.tsx`

**Bug:** the hub's per-line serial grid expanded a range by calling `addRow` once per serial, and
`addRow` appends with `setAdded((cur) => [...cur, row])` — a fresh copy of the whole array per row.
A legal `EC{1-10000}` (serial-range.ts's own `MAX_EXPANSION`) therefore did ~50 million element
copies across 10,000 separate state updates, on the main thread, inside one keystroke's handler.

**Fix:** `appendRows` (pure: one pass over one copy, a client id per row, never mutates its input)
and `addRows` on the hook (one state update; an empty batch schedules no re-render at all).
`SerialsSection`'s `addRange` uses it. **Checked the sibling habit:** the entry page's
`OrderLineCard.addRange` was ALREADY a single `onChange` with the whole batch spread in — no fix
needed there, and it is now pinned as such so the habit cannot come back on either side.

**Commit:** `33fbc64`

**Test evidence:** `tests/bulk-grid.test.ts` — `appendRows` ordering/immutability/empty-batch, plus
a full 10,000-serial expansion in one call with 10,000 distinct client ids. Since a per-row loop
would produce an identical result and differ only in cost, the call-site property is checked at the
source (the `partial-unique-sweep` precedent): `SerialsSection`'s `addRange` must contain `addRows(`
and must not contain `addRow(`, and `OrderLineCard`'s must contain exactly one `onChange(`. Verified
discriminating by stashing the section change and re-running.

---

## Finding 8 — collectTravelerData reads escape the print transaction (P2)

**Files:** `erp/src/server/traveler.ts`, `erp/src/server/part-process-steps.ts`,
`erp/src/server/part-inspections.ts`, `erp/src/server/customer-addresses.ts`

**Bug:** `collectTravelerData` ran its six reads plus three settings lookups against the top-level
`prisma` client while `printTraveler`'s transaction held a connection of its own. Under concurrent
prints that is a pool-starvation shape — with a pool of N, N simultaneous prints can each hold one
connection and wait for one only another holder can release. It also quietly undercut R3 finding
1's claim: the reads that decide what the PDF says were not taken in the snapshot the claim was
taken in.

**Fix:** `readTravelerData(db, orderId, settings, loadNumber)` reads EVERYTHING through `db`.
`getOrder` → `readDetail(db, …)`; the parts/customer queries take `db`; `listAddresses`,
`listPartInspections`, `getRevision` and `getRevisionContentUnchecked` each gained a trailing
`db: Prisma.TransactionClient = prisma` parameter, so every existing caller is unchanged.
`travelerSettings()` reads the traffic thresholds and the three company settings BEFORE the
transaction opens — the `createOrder` precedent, and safe because settings are read-only and are
not order state. `collectTravelerData(orderId, loadNumber)` survives as the standalone entry point
(the `getOrder`/`readDetail` split, applied here), so the preview path and every test call site are
untouched. The reads are sequential rather than `Promise.all`'d: on one connection they serialize
regardless, and issuing them concurrently is exactly what makes `@prisma/adapter-pg`'s `performIO`
overlap calls on a single connection and emit node-postgres' deprecation warning (the threshold
`tests/helpers/setup.ts` documents for `readDetail`'s relation loads).

**Commit:** `d60043d`

**Test evidence:** the task allowed "restructure and document" here, but the claim turned out to be
directly assertable with a technique the suite already uses. `tests/traveler.test.ts` intercepts
`prisma.$transaction` to maintain a depth flag and the top-level delegates for nine models, records
`{ where, insideTx }` per call, and asserts (a) the settings reads WERE recorded, outside the
transaction — proving the interception works and the reads really are pre-transaction by design —
and (b) **zero** calls with `insideTx`. Twelve before the fix. The two existing print-race tests
were re-run and pass unchanged, as were the four suites covering the helpers whose signatures moved
(106 tests).

---

## Finding 9 — removed lead line's pending validity check can overwrite the new lead's (P2)

**Files:** `erp/src/app/orders/new/OrderLineCard.tsx`, `erp/src/app/orders/new/page.tsx`,
`erp/src/lib/lead-validity.ts`

**Bug:** the lead-part process-steps check is an async fetch fired from that line's own card, and
its verdict is a single piece of parent state. A report arriving after the card unmounted — the
line was removed, or removing an earlier line promoted a different card to lead — described a part
no longer being ordered, and Save was enabled or blocked on it. The card's own `useLatest` gate
cannot see this: it is per-card, so an unmounted card's in-flight ticket is still "current" from its
own gate's point of view.

**Fix, both halves as specified.**
- The card's effect returns a cleanup that bumps its latest-gate, so every outstanding ticket
  becomes non-current and a post-unmount resolution reports nothing — the same "report nothing" the
  `.then`/`.catch` guards already implement for a superseded check.
- `onLeadValidity` now reports `(lineId, ok)`. The parent stores `{ lineId, ok }` and derives the
  verdict at render through `resolveLeadValidity(report, draft.lines[0]?.id ?? null)`, which returns
  `null` for a report from any other line, or when there is no lead line at all. An "unknown"
  verdict stays `null` rather than collapsing to `false`, so it still never blocks Save on its own.

**Commit:** `95992d5`

**Test evidence:** `tests/lead-validity.test.ts` covers the pure parent read — no report yet, the
current lead's own true/false verdict, a report from a line that is no longer the lead (the
finding's shape), no lead line at all, and an unknown verdict from the current lead.

**Choice recorded, as the task asked.** The parent's id-keyed read is what is tested; the card's
unmount cleanup is not directly asserted. vitest runs `environment: "node"` and this codebase has no
component-test harness (the standing reason `computeOrphanChurn` and `makeLatestGate` were extracted
in the first place), so an unmount cannot be simulated without introducing one — which would be a
larger change than the fix. The half that is assertable without a harness is asserted; the other is
a four-line effect cleanup whose correctness is visible at the call site, and the two are
independent guards, so either alone closes the common case.

---

## Concerns / notes for the next round

1. **`db-errors.ts`'s P2002 branch reads `err.meta?.target`, which is always undefined on this
   stack** (measured while fixing finding 5 — see the shape quoted above). It therefore always
   falls through to `opts.conflictField ?? "value"`. Pre-existing and mostly harmless because every
   caller that cares supplies `conflictField`, but a caller that does not gets "A <entity> with that
   **value** already exists" instead of naming the column. `readableFkField`'s `err.meta?.constraint`
   looks like the same shape mismatch (P2003). Not touched here — out of scope for these nine
   findings, and worth its own look.
2. **The `Content-Length` guard refuses chunked uploads.** Deliberate and documented, and no browser
   is affected, but a non-browser client (`curl -T`, some CLI tooling) that streams without
   declaring a length now gets a 400 naming the header. If that ever needs to work, issue #38's
   streaming enforcement is the fix, not relaxing this.
3. **Deduped responses carry no warnings**, per the task's specified shape. In the two-tab case the
   winning tab saw them; the losing tab navigates straight to the order without a credit-hold or
   serialization notice. Recomputing them on the replay path is possible (the resolved parts are
   available) if the owner would rather the second tab saw them too.
4. **`saveOrder`'s optimistic local `setOrder`** (Overview/Notes) does not take a mutation ticket —
   it is a synchronous local echo of what the user typed, not a response. An older in-flight
   response can still momentarily overwrite that echo before the newer response lands and corrects
   it. Pre-existing, converges correctly, and outside finding 6's scope, but it is the one remaining
   place on that page where state is set without an ordering ticket.

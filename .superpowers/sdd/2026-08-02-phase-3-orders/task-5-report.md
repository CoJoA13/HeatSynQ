# Task 5 report — Orders service: edits, void, linked orders

Branch: `phase-3-orders`. Commit: `af4ddba` — `feat: order edits, void with reason, linked orders`.

Files touched (only these two — nothing else in scope):
- `erp/src/server/orders.ts` (647 → 1024 lines)
- `erp/tests/orders.test.ts` (1030 → 1624 lines)

## 1. What was implemented

Ten new exports on `erp/src/server/orders.ts`, added below the existing create/read/list/export
flow under a new `// Edits, void, and linked orders (Task 5 ...)` section comment:

- `updateOrder(id, input)` — PATCH of `poNumber`/`vsOrderNumber`/`receivedDate`/`requestDate`/
  `targetDate`(nullable)/`notes`. `.strict()`, all fields `.optional()`, so an omitted key is a
  true no-op and `targetDate: null` explicitly clears it.
- `addLine(orderId, input)` — rider at `position = max+1`, reusing `LINE` (the exact schema
  `createOrder` validates lines with) and `resolveLineParts` (the exact live/active/
  belongs-to-customer check `createOrder` runs).
- `updateLine(orderId, lineId, input)` — qty/weight only; `partId`/`revisionNumber` have no key in
  the patch shape at all, so `.strict()` itself is the immutability guard.
- `removeLine(orderId, lineId)` — position 1 (the lead) 400s with the exact message; any other
  line closes the position gap behind it via ascending per-row updates (the `removeStep`
  precedent, `part-process-steps.ts`).
- `replaceContainers(orderId, input)` / `replaceCharges(orderId, input)` — bulk delete-then-
  recreate at positions 1..n. `replaceContainers` runs `assertRefExists("containerType", …)` per
  distinct incoming `typeId`, same registered-FK pattern `createOrder` already runs.
- `replaceSerials(orderId, lineId, input)` — bulk delete-then-recreate of ONE line's serials,
  1..n; in-payload duplicates are named and refused before the transaction opens.
- `voidOrder(id, reason)` — reason trimmed + required in the service; `auditedSoftDelete`.
- `linkOrder(id, otherId)` / `unlinkOrder(id)` — same-customer enforced, self-link refused, adopts
  the other side's existing `linkGroupId` or mints a fresh `crypto.randomUUID()` for both.

Every mutator shares the brief's exact shape: `withDbErrors({entity:"Order"})` → Serializable
`$transaction` → `findFirst({id, deletedAt:null})` (404 "Order not found" — catches unknown AND
voided ids identically) → `auditedUpdate("order", id, doIt, {tx})` (or `auditedSoftDelete` for
void). No manual audit-payload construction was needed anywhere in this task — `order` was
already in `AuditableModel`/`SNAPSHOT_INCLUDE` (Task 1/4), and its `SNAPSHOT_INCLUDE` already
pulls every child collection, ordered, with live names joined — the automatic before/after
snapshot `auditedUpdate` takes is sufficient for all ten mutators.

## 2. Decisions made where the brief was silent or ambiguous

**Warnings scope.** `loadsMismatchWarnings(order: OrderDetail)` is a new helper, recomputed from
the order's *current* state (not "did this call change qty/weight") — so `updateOrder` (which
never touches qty/weight) still reports a true mismatch left over from an earlier `addLine`, and
`updateLine` reverting a qty edit reports `[]` again rather than remembering it once didn't. I
deliberately did **not** fold `buildWarnings`' serialization/credit-hold checks into this — the
brief scopes Task 5's warning surface to the loads-mismatch string only ("Warnings on qty/weight
edits: ..."), and `removeLine`/`replace*` return bare `OrderDetail` with no room for a warnings
array at all, which only makes sense if the loads editor (Task 6) is the durable place those
other warnings resurface on read.

**Label offset for `addLine`.** `resolveLineParts`, `duplicateSerialError`, and `createSerials`
each gained an optional `base` parameter (default `0`, so every existing `createOrder` call site
is byte-identical). Without it, `addLine`'s single-line array would always report "Line 1" in a
rejection — misnaming whichever part actually sits at the order's real position 1 (the lead) —
since `resolveLineParts` derives its label purely from the array index. `addLine` passes
`position - 1` as `base` so a rejected rider is named by its real position.

**`linkOrder` audits both sides.** The interfaces block says "Both audited as order updates" —
I read that as one audit entry per order, not one entry naming both, matching `deleteCustomer`'s
own cascade-audit precedent (`customers.ts`: one `auditedSoftDelete` call per affected row). Two
sequential `auditedUpdate` calls inside the same transaction, so either order's own history shows
the link and both commit or roll back together.

**`linkOrder`'s group-adoption rule is exactly what's written, not what I'd guess is "more
correct".** The brief and the design spec (§5d) both say only "adopts the OTHER side's existing
`linkGroupId`, else mints a fresh one for both" — neither mentions checking `id`'s own existing
group first. A caller linking an *already-grouped* order to a *groupless* one will have that
order's `linkGroupId` overwritten to a fresh mint rather than pulling the groupless order into its
existing group, which could orphan other members of the first group. I implemented the literal
rule from both authoritative docs rather than inventing the "smarter" merge behavior — **flagged
below as a concern**, not silently patched.

**Bulk-replace input shape.** The three `replace*` functions take `input: unknown` per the
brief's literal signatures. I made each a bare `z.array(<ITEM>)` (no wrapping object), following
the one existing "bulk PUT a list" precedent in this codebase, `setPartFieldValues`
(`part-field-values.ts`: `const VALUES = z.array(VALUE_ITEM)`). `CONTAINER_ITEM`/`SERIAL_ITEM`/
`CHARGE_ITEM` were extracted from `CREATE`'s previously-inline shapes so `createOrder` and the
three replace mutators validate off one literal each, not two hand-kept-identical copies.

**`replaceSerials`'s duplicate message.** Not given verbatim by the brief (only "rejects
in-payload duplicates" is specified). I used `Serial "X" is entered twice` — no line-label prefix,
since the caller already named the line via `lineId`, unlike `createOrder`'s multi-line
`duplicateSerialError`, which has no other way to say which line.

## 3. TDD evidence

**RED** — `npx vitest run tests/orders.test.ts` immediately after writing all 36 new tests and the
import list (before touching `orders.ts`):

```
Test Files  1 failed (1)
     Tests  36 failed | 61 passed (97)
```

Every failure was `TypeError: (0 , updateOrder) is not a function` (or `addLine`/`updateLine`/…) —
failing for the right reason, not a typo in the test itself.

**GREEN** — same command after implementing all ten functions in one pass:

```
Test Files  1 passed (1)
     Tests  97 passed (97)
```

No fix-up round was needed between RED and GREEN beyond the implementation itself — every
assertion (including the concurrency race, first try) passed as written.

### Full gates (all four, post-implementation)

```
npm test            → Test Files 65 passed (65) / Tests 742 passed (742)   [706 baseline + 36 new]
npx tsc --noEmit     → clean, no output
npx eslint src tests → clean (one warning found and fixed: unused `customer` destructure
                        in the addLine "404s an unknown order" test — see below)
npm run build        → succeeds, standalone build produced
```

The one lint warning (`'customer' is assigned a value but never used` at the original
`tests/orders.test.ts:1146`) was caught on the first `eslint` run, fixed by dropping the unused
destructure, and re-verified clean.

**Race-test stability**: `replaceContainers: races a concurrent containerType delete` was re-run
3 additional times in isolation (`vitest run … -t "never leaves a live container"`) — 10 looped
attempts each run, ~630ms, passed every time. Its own loop (10 iterations) is the timing-robustness
device the `customers.test.ts` reciprocal-parent-cycle precedent uses for the same reason: the
interleaving is timing-dependent, so a single attempt could pass even against a regressed guard.

## 4. Test coverage against the brief's Step-1 list, one bullet at a time

| Brief bullet | Test(s) |
|---|---|
| scalar PATCH audits a real diff | `updateOrder > PATCHes … and audits a real diff` (asserts `entry.before.poNumber`/`entry.after.poNumber`) |
| customer/lead immutability, `.strict()` | `updateOrder > rejects an unrecognized key` (customerId, status); `updateLine > changes qty/weight … never partId or revisionNumber` |
| rider add → position max+1 | `addLine > adds a rider at position max+1 …` |
| rider remove closes gaps, ascending | `removeLine > closes the position gap …` |
| removing the lead 400s, exact message | `removeLine > refuses to remove the lead line with the exact message` |
| qty edit warning, clears on match | `updateLine > returns the loads-mismatch warning … clears it once sums match again` |
| replaceSerials atomic swap + in-payload dupe | `replaceSerials > atomically swaps …`; `replaceSerials > rejects an in-payload duplicate … and writes nothing` |
| replaceContainers vs concurrent deleteReference | `replaceContainers: races a concurrent containerType delete > never leaves a live container …` |
| void: reason required, exact message | `voidOrder > requires a non-blank reason` |
| void: auditedSoftDelete entry carries reason | `voidOrder > soft-deletes with the trimmed reason on the audit entry …` |
| voided order 404s from every mutator | `every mutator refuses a voided order > 404s update, every line op, every replace op, void again, link and unlink` (all 10 functions, one test) |
| voided still getOrder-readable / hidden from listOrders unless includeVoided | folded into the `voidOrder > soft-deletes …` test |
| link: same-customer 400 | `linkOrder / unlinkOrder > refuses linking orders from two different customers` |
| link: self-link 400 (interfaces block) | `linkOrder / unlinkOrder > refuses linking an order to itself` |
| link: joins existing group | `linkOrder / unlinkOrder > mints a fresh group for two groupless orders; a third joins by linking the already-grouped one` |
| link: unlink clears | `linkOrder / unlinkOrder > clears the group on unlink without touching the other members` |
| link: linkedOrders excludes self | asserted inside the "mints a fresh group…" test |

Additional tests beyond the binding list (basic happy-path/404/validation coverage for
functionality the Step-1 list didn't itemize but the interfaces block requires): `updateOrder`
date validation and 404, `targetDate` omit-vs-null; `addLine` cross-customer rejection, 404, audit
content; `updateLine`/`removeLine`/`replaceSerials` unknown-line-id 404s; `removeLine` serial
cascade; `replaceContainers`/`replaceCharges` happy path, empty-list clearing,
`assertRefExists` rejection; `linkOrder` voided-other-side 404, unknown-id-either-side 404.

## 5. Self-review

- **Every brief test bullet present** — table above, all 17 rows covered.
- **Voided-404 coverage on every mutator** — one consolidated test exercises all 10 exported
  functions against a single voided order; each assertion is a separate `expect(...)` line (not a
  loop) so a future failure names exactly which mutator broke.
- **Audit content asserted, not just entry existence** — 3 tests read `before`/`after` fields
  directly (`updateOrder`'s poNumber diff, `addLine`'s new-line-in-after-snapshot, `voidOrder`'s
  reason) using the same `readAudit()` idiom `customers.test.ts` established, imported fresh into
  this file.
- **No scope creep** — `git diff --stat` shows exactly the two files the brief named. No routes,
  no loads/draft/saved-view/search surface, no schema changes. Confirmed permissions (`mustDo`,
  `mustCan`) are deliberately absent from every new function — that's Task 9's job per the
  architecture doc, and the brief's "no routes" instruction.
- **Pristine output** — `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, and `npm run build`
  all green with zero warnings after the one lint fix.
- **File-size concern flagged, not acted on** — `erp/src/server/orders.ts` is now **1024 lines**,
  past the brief's own "~900 lines, note it as a concern rather than splitting unilaterally"
  threshold. I did not split it. The ten Task 5 mutators are self-contained in one clearly
  section-commented block (lines ~669–1024) and share zero private state with the create/read/list
  flow above beyond the already-existing helpers (`readDetail`, `trafficSettings`, `lineLabel`,
  `resolveLineParts`, `createSerials`, `assertRefExists`), so a future split along the
  create-flow/edit-flow seam (matching spec §8's own "the planner may split children into a
  sibling module if the file grows past taste" allowance) would be mechanical if the owner wants
  it — but that's a decision for whoever reviews the whole branch, not something I should do
  unilaterally mid-task.

## 6. Concerns to carry forward

1. **`linkOrder`'s group-adoption rule can orphan an existing group.** As designed (and as both
   the brief and spec §5d literally say): linking `id` (already in group G with other members) to
   `otherId` (groupless) mints a **fresh** group for the pair rather than pulling `otherId` into
   G — silently detaching `id` from G's other members, who keep pointing at a group `id` no longer
   matches. This is not a bug in my implementation; it's the literal algorithm both authoritative
   documents specify, with no mention of checking `id`'s own existing group first. Worth a
   deliberate owner ruling before Task 12/14 build a linking UI on top of it — the alternative
   rule ("adopt whichever side already has a group; if both have DIFFERENT groups, that's an
   actual group-merge operation") is more defensible but was not what was asked for, and Phase 3
   is explicitly "reference-only" for this feature.
2. **`orders.ts` at 1024 lines.** Noted above — flagging per the brief's own instruction rather
   than splitting unilaterally.
3. **`reference.ts`'s `deleteReference` doc comment says "all FOUR registered FK writers"** for
   containerType/glAccount/etc., but `createOrder` (Task 4) already made `containers[].typeId` a
   fifth, and `replaceContainers` (this task) makes it effectively the same writer extended to the
   edit path. That comment predates Task 4 and was already stale before this task started — left
   untouched as out-of-scope for `orders.ts`-only work, flagging here so it doesn't get lost.

## 7. Environment notes

Node 26 via `nvm use 26`; Postgres 18 container already running and healthy at session start;
`npx prisma generate` was needed once (generated client directory existed but was incomplete for
this fresh checkout) before any command worked. Baseline before this task: 706 passing. After:
742 passing (706 + 36 new, 0 removed, 0 skipped).

## Fix round 1 — union link semantics (owner ruling)

Review verdict: **Approved**. Concern #1 (`linkOrder`'s group-adoption asymmetry, §6 above) went
to the owner, who ruled 2026-08-02: **linking always unions the two sides' groups**, superseding
spec §5d's original literal wording (which is exactly what my first pass implemented — see §2
above, "I implemented the literal rule from both authoritative docs rather than inventing the
'smarter' merge behavior"). One fix round, scoped to `linkOrder` only; `unlinkOrder` is unchanged
per the ruling.

### What changed

**`erp/src/server/orders.ts` — `linkOrder` rewritten for union semantics.** Old logic: `groupId =
other.linkGroupId ?? crypto.randomUUID()`, always audited both `id` and `otherId` unconditionally.
New logic resolves one of four mutually-exclusive cases from `(order.linkGroupId,
other.linkGroupId)`:

1. **Neither grouped** → mint one fresh `crypto.randomUUID()`; both `id` and `otherId` move onto
   it (unchanged from before).
2. **Exactly one side grouped** (either direction) → the groupless side joins the grouped side's
   existing `linkGroupId`. Only the groupless side is written/audited — the already-correct side
   gets no audit entry (before===after would be junk, the `setPartFieldValues`/`updateStep`
   "skip identical values" precedent).
3. **Both grouped, different groups** → `id`'s group is the documented survivor; every order
   carrying `other`'s old `linkGroupId` (found via `tx.order.findMany({where:{linkGroupId:
   other.linkGroupId}})`, `otherId` itself included, voided members included too — a group stays
   coherent regardless of void status, matching `readDetail`'s own "voided siblings still list"
   precedent) is moved onto `id`'s groupId and audited.
4. **Both already in the same group** → new guard, 400 `"Those orders are already linked"`,
   checked before the case dispatch above (`order.linkGroupId !== null && order.linkGroupId ===
   other.linkGroupId`).

A single `for (const memberId of toUpdate) await auditedUpdate(...)` loop replaces the old
unconditional pair of `auditedUpdate` calls — `toUpdate` is exactly the set of rows whose value
changes in each branch, so "audit every order whose linkGroupId changes" (the instruction) and
"no junk audit rows for unchanged values" (the established codebase rule) fall out of the same
list rather than needing separate handling.

No changes to `unlinkOrder`, to any other Task 5 mutator, or to the four unrelated `linkOrder`
guard tests (different-customer 400, self-link 400, voided-other-side 404, unknown-id-either-side
404) — none of those depend on the group-adoption algorithm.

**`erp/tests/orders.test.ts`** — replaced the one test that encoded the old (now-wrong) behavior
("mints a fresh group for two groupless orders; a third joins by linking the already-grouped
one") with six tests:

- `mints a fresh group for two groupless orders` — case 1, trimmed to just the base case.
- `audits both sides of a simple link with the real before/after linkGroupId` — closes the
  review's minor #1: reads `readAudit("order", …)` on **both** `a` and `b` after a simple link and
  asserts the actual `before.linkGroupId`/`after.linkGroupId` values (previously only `getOrder`
  functional checks existed, no audit-content assertion for linking at all).
- `the groupless side joins the OTHER side's existing group — both directions — without orphaning
  its groupmates` — case 2, both directions in one test: A-B already linked; link A→C (id
  grouped, otherId groupless) asserts C joins **and B is untouched**; then link D→A (id groupless,
  otherId grouped) asserts D joins **and B and C are still untouched**. This is the exact
  regression the owner's ruling exists to prevent.
- `merges two distinct groups into one when both sides are already grouped` — case 3: A-B and C-D
  linked into two separate groups first, then link A→C, then reads back all four orders and
  asserts every one landed on `groupAB` (the documented survivor).
- `400s re-linking two orders already in the same group, in either direction` — case 4, both
  argument orders.

Net test count in this file: 97 → 101 (+4: one test removed, six added). `docs/superpowers/specs/
2026-08-02-phase-3-orders-design.md` §5d gained the exact amendment sentence the coordinator
specified, appended immediately after the original §5d paragraph (not replacing it, so the history
of what changed and why stays visible in the doc itself).

### Test evidence

```
npx vitest run tests/orders.test.ts
  Test Files  1 passed (1)
       Tests  101 passed (101)     [97 + net 4]

npm test        → Test Files 65 passed (65) / Tests 746 passed (746)   [742 baseline + net 4]
npx tsc --noEmit → clean, no output
npx eslint src tests → clean, no output
npm run build    → succeeds
```

No RED/fix-up cycle was needed beyond the initial rewrite: the implementation was written first
(the four-branch dispatch was traced by hand against all five `(order.linkGroupId,
other.linkGroupId)` combinations before writing any code — null/null, set/null, null/set,
set/set-equal, set/set-different), then all six tests passed against it on the first run.

### Concerns

None new. Concern #2 (file size) and #3 (stale `reference.ts` comment) from the original report
are unchanged in kind by this fix round, just larger in degree — `orders.ts` is now **1061 lines**
(was 1024; +37 from the longer doc comment and the four-branch dispatch replacing the old
one-line ternary). Still not split, per the brief's "note it as a concern rather than splitting
unilaterally" instruction, and still worth a look at the next whole-branch review.

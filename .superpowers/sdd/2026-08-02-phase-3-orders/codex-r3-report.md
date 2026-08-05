# Codex review round 3 — fix wave report

PR #39, branch `phase-3-orders`, starting at `2515e1b` (the tip of round 2's fix wave). Six
confirmed findings, all fixed, TDD throughout (failing test first for every behavior change), six
commits — one per finding, each independently reviewable — pushed to `origin/phase-3-orders`. All
six inline review threads replied to (short-SHA in each reply) and resolved via GraphQL
`resolveReviewThread`.

Per the task's own warning: `vi.spyOn` on this Prisma Client's model delegates is unsafe in this
suite (does not call through, does not restore correctly). None of this wave's fixes needed a stub
— every concurrency test (finding 1's three) uses a genuine second transaction holding a real row
lock (the `part-process-steps.test.ts` / round-2 print-vs-void holder pattern), reused and extended
rather than reinvented.

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest) | **961 / 961 passing** (baseline 953 + 8 new tests across the wave) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | succeeds |
| `npm run test:e2e` | **10/10** |
| `prisma migrate status` | clean on both `erp` and `erp_test` (one new migration, applied to both) |

Schema change this wave: `StoredDocument` gains `@@index([orderId])` (finding 4) via a
hand-written migration (`20260803223338_stored_document_order_index`, TTY-less recipe — Prisma 7's
`migrate dev` refuses in this non-interactive shell) — applied to both databases, `prisma generate`
re-run, `migrate status` confirmed clean on both. Spec doc
(`docs/superpowers/specs/2026-08-02-phase-3-orders-design.md` §4) updated to match — the index was
a spec gap, fixed inline, no amendment ceremony.

---

## Finding 1 — child edits race the traveler archive (P2)

**Files:** `erp/src/server/traveler.ts`, `erp/src/server/orders.ts`, `erp/src/server/order-loads.ts`,
`erp/src/server/attachments.ts`

**Bug:** `printTraveler` took `SELECT … FOR UPDATE` on the Order row only around its final archive
commit; `collectTravelerData` (the read that decides what the PDF says) and `renderPdf` (~100 ms)
both ran BEFORE any lock existed. Every child mutator (`replaceLoads`, `addLine`,
`replaceContainers`, and siblings) resolved its order with a plain, unlocked `findFirst`. An edit
could commit entirely inside that unlocked window, and the archive that followed would still see
"not voided" (the only thing the old claim re-checked) and happily archive the stale, pre-edit
snapshot it had already rendered.

**Fix:** one shared helper, `claimOrder(tx, orderId)` (orders.ts) — a raw `SELECT … FOR UPDATE`
plus the ordinary client read, generalizing the `workingRevision` row-lock precedent
(part-process-steps.ts). Used as the order-resolution step in every order-family mutator
(orders.ts's `updateOrder`/`addLine`/`updateLine`/`removeLine`/`replaceContainers`/
`replaceSerials`/`replaceCharges`/`voidOrder`/`linkOrder`/`unlinkOrder`, order-loads.ts's
`replaceLoads`/`resplitLoads`, attachments.ts's order-owner writes) and — critically —
`printTraveler` itself, which is now restructured to claim FIRST, then read/render/archive, all
inside the one held transaction. `linkOrder` claims its two sides in a fixed (sorted-by-id) order,
not argument order, to rule out a cross-transaction deadlock (40P01) that argument-order claiming
on two concurrent `linkOrder(A,B)`/`linkOrder(B,A)` calls would introduce — `db-errors.ts` has no
mapping for 40P01, so an unmitigated deadlock there would have surfaced as an unmapped 500, the
exact class of bug finding 2 fixes elsewhere.

**Commit:** `c796bae`

**Test evidence — three new tests, all holder-pattern, reusing round 2's exact shape:**
- `tests/order-loads.test.ts`: holds the Order row, starts `replaceLoads`, asserts it stays
  unsettled past a 200 ms window, releases, confirms it then lands. (Investigation note: this
  specific assertion also happens to hold on the pre-fix code, incidentally — `applyLoads`'s
  two-phase negative-park rewrite double-touches each surviving Load row, and Postgres's FK
  referential-integrity check on a row's *second* touch within one transaction takes a
  `FOR KEY SHARE`-class lock on the referenced Order row, which collides with the holder's
  `FOR UPDATE` for an unrelated reason. Kept as a regression pin on the *deliberate* mechanism
  regardless — the two genuinely discriminating tests are the pair below.)
- `tests/traveler.test.ts`, **"edit wins"**: holder claims the row, signals, waits, then — still
  holding the claim — collapses the order's 14 loads to 1 and commits; `printTraveler` is only
  started once the holder confirms its claim. Verified via a temporary `git stash` of just
  `traveler.ts` that this fails pre-fix (`expected 14 to be 1`: the archived PDF's own
  `/Type /Pages /Count` marker, since `renderPdf` is not byte-deterministic across separate calls
  — a second finding worth flagging for anyone writing PDF-content tests here) and passes post-fix.
- `tests/traveler.test.ts`, **"print wins"**: holder stands in for a print that already won the
  claim race and archived pre-edit bytes; a concurrent `replaceLoads` blocks until it releases,
  then lands, and the archived document is confirmed byte-identical to the pre-edit render. (This
  ordering holds on both pre- and post-fix code — the bug specifically requires the opposite
  interleaving — kept as coverage for the ordering the task asked for.)

---

## Finding 2 — container Int4 overflow (P2)

**File:** `erp/src/server/orders.ts`

**Bug:** `CONTAINER_ITEM`'s `count`/`qty` had no upper bound; a value above 2,147,483,647 passed
zod, reached the nested create or `replaceContainers`, and failed with an unmapped Postgres range
error (`INTEGER` overflow) — an unhandled 500 instead of the field-anchored 400 every other bad
input on this endpoint gets.

**Fix:** `.max(2_147_483_647)` on both fields (one `INT4_MAX` constant, orders.ts).

**Commit:** `f63605d`

**Test evidence:** `tests/orders.test.ts` — over-range `count` and over-range `qty` each produce a
`ZodError` whose `issues[0].path` names the exact field (`["containers", 0, "count"]` /
`["containers", 0, "qty"]`); confirmed no order row is left behind either way.

---

## Finding 3 — zero-weight loads can't round-trip (P2)

**Files:** `erp/src/app/orders/[id]/LoadsSection.tsx`, `erp/src/server/order-loads.ts`

**Bug:** cumulative-rounding auto-splits legitimately produce 0-weight loads whenever a row also
carries a qty (`load-split.test.ts`'s own counter-example: `totalQty=5, totalWeight=0.03`, 1-piece
cap → `[0.01, 0, 0.01, 0, 0.01]`). Both the client-side save check and the server's `LOAD_ITEM`
schema rejected `weight === 0` unconditionally, so that legal split could never be re-saved once
loaded into the bulk editor.

**Fix, both layers (sibling habit):** `decimalField(12, 2, { min: "nonnegative" })` replaces
`"positive"` for `weight`; a `superRefine` still refuses a weight-only row (`qty` null) at exactly
zero. `LoadsSection.tsx`'s client check mirrors the same split: `qty === null` still requires
`weight > 0`, `qty !== null` only rejects a negative weight.

**Commit:** `bcae2f0`

**Test evidence:** `tests/order-loads.test.ts` — the exact `[0.01, 0, 0.01, 0, 0.01]` split
round-trips through `replaceLoads` unchanged; a weight-only zero-weight row still 400s (`ZodError`);
a negative weight on a qty-bearing row still 400s.

---

## Finding 4 — StoredDocument has no orderId index (P2)

**Files:** `erp/prisma/schema.prisma`, new migration, spec doc

**Bug:** every order detail read checks document existence by `orderId`
(`DETAIL_INCLUDE.documents`), and the archive endpoint filters/orders by `orderId` too
(`listDocuments`) — this permanent, append-only table had no supporting index.

**Fix:** `@@index([orderId])`. TTY-less migration recipe (`migrate diff --from-config-datasource
--to-schema=prisma/schema.prisma --script`), hand-written into
`prisma/migrations/20260803223338_stored_document_order_index/migration.sql`, applied to both `erp`
and `erp_test` via `migrate deploy`, `prisma generate` re-run. Spec §4's `StoredDocument` block
gains the same line.

**Commit:** `1488169`

**Test evidence:** none needed for an index by itself (no behavior change); `migrate status` clean
on both databases is the check, confirmed both immediately after and again in the final gate pass.

---

## Finding 5 — deletePart orphans attachments (P2)

**File:** `erp/src/server/parts.ts`

**Bug:** `deletePart`'s cascade soft-deleted specifications, inspections, and price breaks but not
`PartAttachment` — those rows stayed live (`deletedAt: null`) yet permanently unreachable behind
the live-part guard every attachment operation requires (`assertOwnerVisible`), and the parent's
deletion never showed up in the attachment's own audit history.

**Fix:** `partAttachment` joins the `Promise.all` fetch and the `auditedSoftDelete` loop, identical
shape to the three existing children. Voided-order side of attachments (order-owned, not
part-owned) deliberately untouched — orders keep their attachments readable when voided, by design,
per round-1's own adjudication.

**Commit:** `90bcfe6`

**Test evidence:** extended the existing `tests/parts.test.ts` "cascades children in one
transaction" test — adds an attachment via the real `addAttachment` service call before deleting,
asserts its `deletedAt` is set and its own audit log carries a `"delete"` entry reasoned `"parent
part deleted"`, in the same transaction as the specs/inspections/breaks assertions already there.

---

## Finding 6 — serialization warning needs an unrelated catalog grant (P2)

**Files:** `erp/src/server/orders.ts`, `erp/src/app/orders/[id]/SerialsSection.tsx`,
`erp/src/app/orders/[id]/page.tsx`

**Bug:** a user with `orders.view` but not `parts.view` gets no serialization warning:
`SerialsSection` derived `serializationRequired` from a separate parts-catalog fetch the hub never
even attempts without `parts.view`, so `partsById` came back empty and every line read as "not
required."

**Fix:** `serializationRequired` now rides on `OrderDetail`'s line `part` payload
(`DETAIL_INCLUDE.lines.include.part.select` + `OrderLineDetail.part`'s type, orders.ts) —
independent read access, same gate as the rest of the order hub (`orders.view`).
`SerialsSection.tsx` reads `line.part.serializationRequired` directly; the now-dead `partsById`
plumbing (the `useMemo`, the prop, the fetch's now-stale comment) removed from `page.tsx` and
`SerialsSection.tsx` rather than left orphaned.

**Commit:** `6c0ae10`

**Test evidence:** `tests/orders.test.ts` — `order.lines[i].part.serializationRequired` asserted
both on `createOrder`'s own response and on a separate `getOrder` read (the hub's actual fetch), for
a flagged rider and an unflagged lead.

---

## PR comment replies + thread resolution

All six inline `comment_id`s replied to via
`gh api repos/CoJoA13/HeatSynQ/pulls/39/comments/ID/replies`, each one line naming the fix plus its
commit's short SHA, ending with the required attribution line. All six threads then resolved via
GraphQL `resolveReviewThread`, confirmed `isResolved: true` for each:

| comment_id | finding | reply short-SHA | thread resolved |
|---|---|---|---|
| 3707980403 | 1 — traveler-print race | c796bae | ✅ |
| 3707980408 | 2 — container Int4 | f63605d | ✅ |
| 3707980412 | 3 — zero-weight loads | bcae2f0 | ✅ |
| 3707980415 | 4 — StoredDocument index | 1488169 | ✅ |
| 3707980421 | 5 — deletePart cascade | 90bcfe6 | ✅ |
| 3707980424 | 6 — serialization warning | 6c0ae10 | ✅ |

## Concerns / notes for the record

- **`renderPdf` is not byte-deterministic across separate calls** with byte-identical input
  (confirmed via a throwaway diagnostic: two renders of the same `TDocumentDefinitions` differed in
  length and in a compressed stream's bytes). Not a bug in this PR's scope, but it means any future
  test wanting to assert "the archived traveler shows X" cannot compare rendered PDF bytes across
  two separate `renderPdf` calls — either compare stored bytes to themselves (already the pattern
  in every pre-existing traveler test) or check a stable, uncompressed structural marker (this
  wave's new tests use the PDF's own `/Type /Pages /Count N` page-tree object for exactly that
  reason).
- **`git commit -- <pathspec>` gotcha caught mid-wave**: an early attempt to commit finding 1 with
  explicit trailing file paths silently ignored the careful `git add -p` partial staging and
  committed each listed file's full current working-tree content instead (Git's documented
  behavior: pathspec args to `commit` "record the current content of the listed files without
  regard to the state of the index"). Caught immediately by diffing the resulting commit, fixed
  with a `git reset` (soft, nothing pushed yet) and redone correctly (bare `git commit -m` off the
  already-built index, no trailing paths, for every commit after). Final six commits verified to
  reconstruct byte-for-byte the same cumulative diff as the original unsplit working tree.
- CI (`ci` check on the PR) was still running at push time; polled separately and confirmed
  **pass** (3m20s) before this report was finalized.

# Task 7 implementer report — rollback-drain on the mutation-gate pages + the stale-closure pair

Branch `group-d-stale-loads`, commits `1886d14` (helper + test), `5a6acae` (Part A), `4f9bb41`
(Part B); report committed separately. Exactly the six briefed files plus the shared lib helper
and its test — no other files touched (the concurrent implementer's working-tree changes to
`progress.md` and `CertificationsSection.tsx` were excluded via explicit-pathspec commits).

## Helper decision

**Shared `src/lib/` leaf: `drainOtherKeys(queue, ownKey)` in `erp/src/lib/drain-queue.ts`.**
The drain is character-identical across all four pages (each keeps its queue in the same
`Map<string, Promise<unknown>>` shape), it is dependency-free (no React, no src/server — the
field-blocker-panel.ts leaf shape, so no `"use client"` directive either), and making it a leaf
let the contract be pinned by pure deferred-driven tests — which the brief licensed only for the
lib-helper option. Four page-local copies would have been four chances for the loop below to be
"simplified" away in a later edit.

One deliberate strengthening over the brief's single `Promise.allSettled` sentence: the helper
**re-snapshots until the other keys' chain tails are stable**. A sibling save dispatched WHILE
the drain sits on `allSettled` extends its key's chain, and a GET released on the old tail alone
could still be served before that new save commits — the exact reversion being fixed. This is the
same window Task 2's review R1 caught in the save-scope reload ("the park is itself a save
window", commit `8cffa3f`); closing it here up front avoids the same finding in review.
Termination is the save-scope argument verbatim: chains only extend on user actions. The own key
is excluded on every iteration — the failing save's catch runs INSIDE its own chain, so awaiting
that tail is awaiting yourself.

## Per-change table

### Part A — the rollback-drain (all four: drain slots between the failure and the §5.13 rollback `load()`; the existing reload-before-setError order untouched)

| # | File | The hole | The fix | Line refs (post-change) |
|---|------|----------|---------|-------------------------|
| 1 | `erp/src/app/orders/[id]/page.tsx` | `saveOrder`'s catch fires the rollback `load()` on the newest ticket while a sibling key's PATCH is in flight — the GET can be served pre-commit, reverting the sibling's write on screen (its response then drops as older-ticketed) | `await drainOtherKeys(queue.current, key)` before the recovery `load()`. `travelerPrinted` monotonic merge, warnings handling, blur-save guard all untouched | :22 (import), :330–339 (catch) |
| 2 | `erp/src/app/invoicing/[id]/InvoiceDetail.tsx` | Same hole in `patchHeader`'s catch (same queue shape) | Same drain | :28 (import), :563–571 (catch) |
| 3 | `erp/src/app/shipping/[id]/ShipmentDetail.tsx` | Same hole in `patchHeader`'s catch (same queue shape) | Same drain | :19 (import), :485–493 (catch) |
| 4 | `erp/src/app/certs/[id]/CertDetail.tsx` | TWO holes: no serial queue at all — so two same-field notes PATCHes (double-blur) could also commit out of order server-side (the audit's :223 last-write-wins) — plus the same rollback-vs-sibling race in `patchNotes` and `saveReadings` | Added the per-key queue (the InvoiceDetail shape; key = `Object.keys(patch).sort().join(",")` for notes). `saveReadings` joins the same queue under `readings:${requirementId}` keys — two blocks still save in parallel, each block serializes with itself, and the prefix keeps block keys out of the notes-field key space. Both catches drain other keys before their rollback loads; `saveReadings`'s existing drain→load→bumpReset→setError order preserved with the drain slotted first | :16/:22 (imports), :226–240 (queue + serial), :242–265 (patchNotes), :267–293 (saveReadings) |

CertDetail's `serial` is a `useCallback` (empty deps; the queue is a ref) rather than its
siblings' plain function — `saveReadings` is itself a `useCallback` passed to `RequirementBlock`
and must list `serial` as a dep, which a per-render plain function would defeat.

### Part B — the stale-closure pair (render-updated loader refs; ref written in a no-dep effect because `react-hooks/refs` forbids a render-time write)

| # | File | The hole | The fix | Line refs (post-change) |
|---|------|----------|---------|-------------------------|
| 5 | `erp/src/app/parts/page.tsx` | `add()`'s awaited `load` and PasteGrid's `onDone` close over the `query` as of dispatch — a search/show-inactive change during the await means the refetch re-asks the OLD query with the NEWEST ticket, defeating the gate (table disagrees with controls) | `loadRef` updated every render; `add()` awaits `loadRef.current()` and `onDone` calls `void loadRef.current()`. Task 4's `invalidateSetupBanner()` calls preserved exactly, still before the reload (#124/#131 ordering) | :62–68 (ref), :91 (add), :172 (onDone) |
| 6 | `erp/src/app/invoicing/InvoicingList.tsx` | `createInvoices`' post-run reload captures `loadInvoices` (closes over the filter query) at click time; the sequential POST loop can run long, so the reload re-asks the stale query with the newest ticket | `loadInvoicesRef`, awaited inside the existing `Promise.all` — the §5.13 reload-before-report ordering (reload settles before `setTicked`/`setCreateErrors`) is unchanged. `loadCandidates` has no query axis — left as-is per the brief; tick-set handling and the customers error channel untouched (filed as issues) | :137–146 (ref), :168 (reload) |

## RED table

`erp/tests/drain-queue.test.ts` (the save-scope.test.ts deferred recipe), written and run RED
first (module-not-found on `@/lib/drain-queue` — watched fail before the helper existed), then
green after implementation. 6 cases:

| Case | Pins |
|------|------|
| resolves immediately on an empty queue | no spurious wait |
| skips the own key — never awaited | the no-deadlock contract (own chain stays pending forever; a deadlock is a test timeout) |
| waits out another key's in-flight chain | the core ordering: drain pending until the sibling settles |
| waits out siblings while still skipping the pending own key | both properties together |
| a rejecting sibling releases the drain | `allSettled`, never `all` — drain resolves, doesn't reject |
| re-drains a chain extended during the wait | the park-window loop (the strengthening above) |

## Gates

Run from `erp/`:

| Gate | Result |
|------|--------|
| `npx vitest run tests/use-latest.test.ts tests/drain-queue.test.ts` | ✅ 2 files, 13 tests passed |
| `npx tsc --noEmit` | ✅ exit 0 |
| `npx eslint src tests` | ✅ exit 0 |

## Reviewer-attention notes

- **The drain loop is deliberately stronger than the brief's one-line spec** (see Helper decision)
  — if the reviewer reads the loop as scope creep: it is the Task 2 R1 finding pre-applied, and it
  is pinned by the last test case.
- **Residual, accepted:** a sibling save dispatched AFTER the drain returns but before the
  rollback GET's ticket is taken is still safe — the drain's resolution and `load()`'s synchronous
  `mutations.next()` sit on one microtask chain, and a user event (macrotask) cannot interleave.
  A save dispatched after the ticket is taken carries a NEWER ticket and wins at the accept gate
  by construction. So no window remains on this path.
- **CertDetail behavior change beyond the drain:** notes PATCHes now serialize per field and
  readings PUTs per block where before everything was unqueued. This is the brief's explicit
  instruction (the audit's :223 same-field finding) but it is a real ordering change: a second
  blur on the same field now waits for the first PATCH. Cross-field/notes-vs-readings parallelism
  is preserved (distinct keys).
- **Not touched, deliberately:** the pages' OTHER follow-up loads (voidAction/discard/print
  recovery loads) are not §5.13 rollbacks of an optimistic apply and are outside the audited
  hole; Task 6's docs-list gates in three of the four detail pages are untouched; InvoicingList's
  tick-set mid-run clobber and error-channel displacement stay filed as issues (Task 9).
- **E2E:** not run here per the task's explicit gate list (Group D runs the mandatory
  `npm run test:e2e` at the branch level before merge — these are UI files, so that run matters).

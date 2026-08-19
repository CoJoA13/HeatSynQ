# Task 1 — #149, the typed-text overlay — implementer report

Branch `group-h2-client-state`. Four code commits in the brief's internal order (leaf + suite
first, then the two integrations), plus this report.

## Commits

| SHA | What |
|---|---|
| `2c614d7` | `test:` pin the scalar edit-guard contract (11 tests, green against the untouched leaf) |
| `708d0c7` | `feat:` the keyed variant — `onFocusCell`/`mergeRows` + 11 TDD'd tests (red confirmed first: all 11 failed against the unmodified leaf, the scalar 11 stayed green) |
| `f491e85` | `fix:` customers address/contact integration |
| `9dd3d2c` | `fix:` orders hub `useEditGuard` adoption |

## (a) The leaf — `erp/src/lib/use-edit-guard.ts` + NEW `erp/tests/use-edit-guard.test.ts`

**Design: one shared focus slot, two registrations.** The slot gained a `cell`
(`{ rowId, field } | null`) beside the existing `key`; `onFocusField` sets `key` and clears
`cell`, `onFocusCell` the reverse, `onBlurSave` clears both. That keeps the single-focused-slot
model literally (the DOM has one focused element) AND gets the cross-variant displacement for
free: a page using both (customers) can never have a scalar and a cell "protected" at once.
`mergeRows` is `merge`'s exact logic per-cell — same string lens, same untouched-vs-dirty split,
same re-snapshot of the no-op guard on the untouched branch — keyed by row **id** (stable across
the reorders/insertions a fresh payload carries), never index. A focused row absent from the
payload (deleted server-side) or a `field` absent from the row takes the payload as-is: there is
no row left to carry the cell, and resurrecting one would show data the server no longer has.

**Additivity.** `merge`/`onFocusField`/`onBlurSave` bodies are unchanged except the slot's
`cell: null` writes (behaviorally invisible to scalar consumers — `cell` is only ever read by
`mergeRows`). `EditGuard` gains two members; grep-verified that nothing but `makeEditGuard`
constructs the type, so no consumer needed touching. The seven pre-existing consumers are
byte-untouched (CertDetail, ShipmentDetail, InvoiceDetail, BatchDetail, parts/[id]/page,
parts/[id]/IdentitySection untouched entirely; customers/[id] changed only under (b)).

**Suite** (22 tests, pure leaf, no DB, synchronous — the `use-latest.test.ts` shape; faked
focus/blur events carry only `target.value`). Scalar block pins: wholesale landing with no/blank
focus, `cur === null`, focused+dirty survival, focused-untouched re-snapshot (asserted via the
subsequent blur being a no-op), blur releasing the slot, single-slot displacement,
`onFocusField(null)` as blur-guard-only, the no-op/trim/commit-signature contract, the string
lens, and a focused key absent from the payload. Keyed block: the same battery per-cell, plus
id-not-index matching under reorder, the disappearing row, a locally-missing row, cross-variant
slot displacement in both directions, and blur commit/release for cells.

## (b) Customers — `erp/src/app/customers/[id]/page.tsx`

- `applyDetail` now routes `setAddresses`/`setContacts` through `editGuard.mergeRows`
  (functional updates, beside the existing `setC` merge).
- The cells' plain `noteFocus` (`editGuard.onFocusField(null)`) is replaced by
  `noteFocusCell(rowId, field)` at all 8 sites — address name/street/city/state/zip keyed by
  `a.id`, contact name/email/phone by `ct.id`. The helper name changed with the semantics, so a
  future cell can't silently bind the un-keyed guard by habit.
- The :335 comment block now documents the closed gap; the editGuard declaration comment (:131)
  notes the row arrays' keyed route. `saveScope` integration (:136-144) and the scalar guard on
  `c` untouched.

## (c) Orders — `erp/src/app/orders/[id]/page.tsx`

- The pre-guard `focusedValue` ref machinery is replaced by `useEditGuard`: `noteFocus` is now a
  key-taking factory (`editGuard.onFocusField(key)`, the parts/[id]/IdentitySection shape) and
  `onBlurSave` delegates to the guard — the no-op diff against the at-focus value is preserved
  (it is the guard's own blur contract), so blur-save semantics are unchanged.
- `load()`'s `setOrder` and `applyMutation`'s `setOrder` both route through `editGuard.merge`
  inside their **unchanged** `mutations.accept(ticket)` branches; `editGuard` joined both
  `useCallback` dep arrays (stable identity — `useState` lazy init — so no re-creation).
- **The travelerPrinted monotonic preserve survives verbatim**: the ternary
  (`prev?.travelerPrinted && !fresh.travelerPrinted ? { ...fresh, travelerPrinted: true } : fresh`)
  computes `next` first, and `merge(prev, next)` composes over it. The two preserves cannot
  collide: merge only ever touches the one focused TEXT field, never a boolean.
- Covered inputs registered: `poNumber`, `vsOrderNumber`, `customerJobNo` (Overview), `notes`
  (Notes). The onChange-saving date inputs register nothing — trigger, not target — and their
  behavior is unchanged. The mutation-gate/drain machinery (`serial`/`inFlight`/
  `drainOtherKeys`/rollback ordering) is untouched. `onPrinted`'s local flag flip (:653) is a
  local fact, not a server detail — left un-merged deliberately.

## Deviations / interpretation calls

1. **`saveOrder`'s optimistic patch (:328) is NOT wrapped in `merge`.** The brief says to thread
   merge into "`saveOrder`'s optimistic patch/rollback (:328/:349)". The rollback (:349) is a
   `load()`, which now merges. The optimistic patch itself stays the plain spread, matching the
   customers/parts `save()` precedent exactly (neither merges its optimistic set): it spreads
   over `cur` touching only the just-blurred field (or an unfocusable date input's), so the
   focused sibling's text is untouched by construction — and the blur that dispatches a save
   clears the slot synchronously first, so no reachable state differs. A comment at the patch
   documents this. Reviewer may want to confirm this reading.
2. **The customers cell fields are passed as string literals** (`"name"`, `"street"`, …) rather
   than a `keyof`-constrained helper — `onFocusCell`'s `field` is `string` by design, matching
   `onFocusField`'s existing `string` key, and the cells' rows are two different types sharing
   the guard.
3. The pinning commit (`2c614d7`) was committed green-first by design — pins, not TDD; the keyed
   commit's red was observed before implementing (11 failed / 11 passed).

## Gates (all from `erp/`, scratch DB `erp_scratch_h2t1`, created → migrated → dropped)

| Gate | Result |
|---|---|
| `npm test` (with `DATABASE_URL` **and** `DATABASE_URL_TEST` pointed at the scratch DB — `tests/helpers/setup.ts` maps the former from the latter) | **200 files, 3344 tests, all passed** (run at branch HEAD including Tasks 2/3's landed commits) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| E2E | not run — group-level, controller's job (brief) |

## For the reviewer to probe

- The shared-slot displacement (`onFocusField` ↔ `onFocusCell`) is the one place the scalar
  code path was touched (the `cell: null` writes) — the scalar pins in the suite's first block
  are the evidence it is behavior-neutral.
- `mergeRows`' untouched-branch re-snapshot keeps the cell registered while updating `atFocus`
  — mirrors the scalar branch; a blur after a server-value landing must stay a no-op.
- In the orders `applyMutation`, merge runs INSIDE the accept branch, so a dropped stale ticket
  still applies nothing — the gate's contract is unchanged.
- ~~The disappearing-row branch leaves the slot registered~~ — **resolved in fix round 1**
  (`9d58d2a`, below): the branch now releases the slot. The original dismissal here was
  inverted, per the reviewer: soft-delete is precisely what lets a same id leave and RE-ENTER
  the visible payload (reactivation, an includeInactive refetch), and "fresh ids on recreate"
  only covers hard recreate, which isn't the reachable path.

## Fix round 1 (2026-08-19, review round 1 — Spec ✅, Approved, one Minor)

**Finding (Minor):** `mergeRows`' disappearing-row branch kept the cell registration alive.
Once the payload applies, the cell's input unmounts with **no React blur**, and only
guard-REGISTERED focus/blur replaces the slot — checkboxes, selects, and buttons never touch
it — so the stale registration survived until the next guarded field was entered. A same-id
row re-entering a later payload (a supported flow under soft-delete) then compared its server
value against the dead `atFocus` snapshot, read as dirty-since-focus, and blocked server truth
on every merge indefinitely. The ~:129 comment's "the next focus or blur anywhere replaces it"
was also wrong for the same reason.

**Fix (`9d58d2a`, TDD):** RED test first — the three-payload trace (cell registered dirty →
row leaves the payload → same id re-enters → the NEXT refresh must land wholesale; red at the
third step, where the stale snapshot made the untouched cell read dirty; observed 1 failed /
22 passed). Then the implementation: the `!incomingRow` branch sets
`focused = { key: null, cell: null, atFocus: "" }` before returning the payload as-is —
clearing is strictly safer, since the input is guaranteed to unmount once the payload applies,
so there is nothing left to protect. The `!(field in incomingRow)` case deliberately does NOT
clear: that row — and its focused input — are still live, so the registration stays for the
blur no-op guard. Comments corrected at the branch, in the leaf header, and on the `mergeRows`
type doc.

**Gates:** `npx vitest run tests/use-edit-guard.test.ts` — 23/23 green; `npx tsc --noEmit`
clean; `npx eslint src tests` clean.

## Codex round 1 (PR #154 — P1, verified by the controller)

**Finding (P1):** the `9d58d2a` clear-on-absence was right WITHIN a collection but destructive
ACROSS collections. `applyDetail` (customers/[id]/page.tsx) merges addresses THEN contacts
through ONE guard slot, and a focused contact's rowId is by definition absent from the
ADDRESSES array — the unscoped release read that absence as a deletion and dropped the
registration before the contacts merge ran, so a dirty contact cell was overwritten wholesale
(the exact #149 defect, re-opened). In the other direction, a focused address survived its own
merge but lost its registration to the contacts merge: the next payload clobbered it, and blur
fired a spurious commit (onBlurSave compared the field against the cleared slot's
`atFocus: ""`). The pre-fix-round code was accidentally safe — absence left the slot alone;
`9d58d2a` made absence destructive without scoping it.

**Fix (`cc0e946`, TDD):** the collection joined the cell's identity —
`onFocusCell(collection, rowId, field)` / `mergeRows(collection, cur, incoming)` — and
`mergeRows` acts on the slot (protecting OR releasing) only when `f.cell.collection ===
collection`, passing through untouched otherwise, payload and slot both. RED first: three
cross-collection tests against the new signature (observed 3 failed / 23 passed against the
unscoped implementation) — (a) a dirty contact cell survives an addresses-then-contacts double
merge, (b) an unrelated collection's merge leaves the registration AND the blur no-op intact
(the spurious-commit half), (c) the `9d58d2a` within-collection release still holds with the
collection argument. Then the leaf implementation, the existing keyed tests migrated to the
new arity (generic collection `"rows"`), and the single consumer updated: the customers page
passes `"addresses"`/`"contacts"` at both `mergeRows` calls and all 8 `noteFocusCell` sites —
the page helper narrows `collection` to the union `"addresses" | "contacts"` so a future cell
cannot pass a name applyDetail's merges do not use. Leaf header, both type docs, and the page
comments state the scoping rule. One commit (leaf + test + page): the signature change and its
only consumer must land together for every commit to compile.

**Gates:** `npx vitest run tests/use-edit-guard.test.ts` — 26/26 green; `npx tsc --noEmit`
clean; `npx eslint src tests` clean. Not pushed — the controller pushes after both Codex fixes
land.

## Codex round 2 (PR #154 — P2, controller-broadened to the scalar half)

**Finding (P2):** `merge`/`mergeRows` MUTATED the guard slot from inside functional setState
updaters (the untouched-branch re-snapshot, plus the keyed release). Updaters must be pure:
Strict Mode double-invokes them with the same prev — call 1's re-snapshot made call 2 judge the
untouched field dirty, preserving stale data the user then blurred into a spurious commit — and
React 19's concurrent rebasing can re-run updaters in production. The scalar half was
pre-existing across all seven consumers since Phase 4; the orders adoption extended it.

**A second hazard found while working the prescribed design through** (reported to the
controller): the prescribed companion overwrote `atFocus := incoming` right after the setState —
but React can also DEFER an updater past the companion call (guaranteed for the 2nd/3rd
dispatch in one handler — customers' `applyDetail` issues three), and the deferred updater then
reads the already-transitioned `atFocus` and judges an untouched field dirty: the same bug
through the other door. Neither "note after" nor "note before" is safe with a single mutable
snapshot, because React fixes neither the order nor the count of updater runs.

**Fix (`d599ec1`, TDD):** all prescribed constraints kept, with one structural upgrade making
the decision ordering-proof: the slot holds a per-focus-session **snapshot SET** (the at-entry
value plus every server value a companion notes), and "untouched" is set MEMBERSHIP — the
field's text is a value the box was GIVEN, not one the user typed. The set only grows within a
session, so `merge`/`mergeRows` (now strictly read-only) return identical results whether an
updater runs before its companion, after it, once, or twice. `noteMerged(incoming)` /
`noteMergedRows(collection, incoming)` add the focused key/cell's payload value; `noteMergedRows`
keeps round 1's collection scoping and owns the release-on-absence (running exactly once,
outside any updater). `onBlurSave` no-ops on ANY session snapshot and passes the NEWEST one as
`commit`'s `atFocus` argument — the int-field rollback callers now restore the last value the
box was actually given rather than a stale at-entry value.

**Blur-semantics analysis — where it differs from the controller's:** (1) untouched fields:
identical to before. (2) A dirty field's typed text: still commits. (3) Revert-to-server-value:
now a no-op — the improved edge, as prescribed. (4) One divergence: a DIRTY field reverted to
exactly the AT-ENTRY value — the prescribed overwrite would COMMIT it (atFocus had moved to the
server value); the set keeps the original snapshot, so it stays a NO-OP, which is the exact
pre-round-2 behavior (pinned since the first commit). Both readings are defensible (committing
would sync the box with the server; no-op matches "the user ended where they began"); the set
preserves the shipped behavior rather than changing it as a side effect of a purity fix.

**Call sites (all 13 apply sites across the 7 consumers):** every merged setState gained its
companion beside it — inside the mutation-gate accept branch where one gates the apply (a
dropped stale payload is never applied, so it is never noted; CertDetail, ShipmentDetail,
InvoiceDetail, BatchDetail, orders' `load`) — and customers' `applyDetail` pairs all three.
Orders' `applyMutation` notes the PRE-ternary `fresh` with a comment stating why that is exact
(the travelerPrinted ternary alters only a boolean, never a guard-registered text field). The
pairing discipline is documented in the leaf header: a functional-updater merge is always
followed by its companion with the same payload.

**TDD:** RED observed first — 10 new purity/ordering/blur tests + the migrated release test:
11 failed / 25 passed against the mutating implementation; the new battery covers double
invocation (scalar and keyed), note-before-updater (both variants), two deferred refreshes in a
row, dirty-preserve under every ordering, the revert edges, and companion-owned scoping +
release. 36/36 after.

**Gates:** `npx vitest run tests/use-edit-guard.test.ts` — 36/36 green; `npx tsc --noEmit`
clean; `npx eslint src tests` clean. Not pushed — the controller runs the full suite + E2E and
pushes.

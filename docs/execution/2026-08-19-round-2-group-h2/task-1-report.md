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
- The disappearing-row branch leaves the slot registered (comment in the leaf explains: React
  fires no blur for an unmounting input; the next focus/blur anywhere replaces the slot). If the
  same row id later REAPPEARS in a payload while the slot still holds it, the cell would compare
  against a stale `atFocus` — reachable only by delete-then-recreate-with-the-same-id between
  two payloads with zero intervening focus/blur, which soft-delete id semantics make practically
  impossible; noted for completeness.

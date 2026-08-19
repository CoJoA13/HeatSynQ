# Task 5 — #33, the bounded decomposition slice (owner-ruled) — implementer report

Branch `group-h-polish`. Four commits, two independent halves, plus the issue #33 close-out.
The create/edit service split is **deferred** per the 2026-08-19 kickoff ruling and recorded on
the issue; #33 stays open, retitled to the remaining scope.

## Commits

| SHA | What |
| --- | --- |
| `39788bc` | test(board): unit suite for the `board-columns` leaf (18 cases, previously zero coverage) |
| `7143589` | refactor(board): board page → four presentational components in `src/app/board-parts/` |
| `57d0ab4` | refactor(orders): board reads → `src/server/order-board.ts` behind a re-exporting barrel |
| `e27043d` | refactor(orders): `isDuplicateClientRequestId` → `db-errors.ts`, retiring the orders↔shippers cycle |

## Half A — componentization + the missing unit suite

**Unit suite** (`erp/tests/board-columns.test.ts`, pure — no DB, the `business-days.test.ts`
pattern): pins `defaultViewConfig` (spec-order columns, empty filters, orderNumber-desc, fresh
objects per call — the lazy-useState-initializer contract), `normalizeViewConfig`
(recover-don't-trust: non-object → full default; unknown/duplicate/malformed column entries
dropped with first-occurrence-wins; never-mentioned columns appended visible so a new column
can't vanish from an old view; `visible !== false` semantics; per-field filter fallback; status
list filtered; stale `sort` falls back — including a real column key with no sortKey — and `dir`
is "asc" only on the exact string; a save-shape round-trip), and `buildOrderQuery`
(empty-keys-omitted — the default board emits exactly `sort=orderNumber&dir=desc` — search
trimmed/omitted, comma-joined status, `includeVoided=1` only when on, full representative
round-trip via `URLSearchParams`).

**Component extraction map** (`erp/src/app/page.tsx` 427 → 260 lines; JSX moved, never state):

| New file (`src/app/board-parts/`) | From page.tsx (old lines) | Exports | Props |
| --- | --- | --- | --- |
| `SavedViewsBar.tsx` | 263–301 (views bar + save panel) | `SavedViewRow` type | 5 values + 8 callbacks |
| `FilterBar.tsx` | 303–370 (filters, Export link, Columns toggle) | `CustomerOption` type | filters/customers/`Gate`/queryString/columnsOpen + 3 callbacks |
| `ColumnPicker.tsx` | 372–394 | — | columns + 2 callbacks (page keeps the `columnsOpen &&` guard) |
| `BoardTable.tsx` | 396–424, plus `renderCell` (215–242) and `sortArrow` (147–150) | `BoardRow` mirror type | rows/visibleDefs/sort + `onToggleSort`/`onOpenOrder` |

The page keeps every `useState` (all 10), both mount effects, the `viewsReady` fetch gating, the
`use-latest` ticket discipline on `load` (success AND failure landings), all handlers
(`updateFilters`/`toggleStatus`/`toggleSort`/`applyView`/`saveView`/`setSelectedDefault`/
`deleteSelectedView`/`toggleColumnVisible`/`moveColumn`), the `visibleDefs` derivation, the
router, and the header/error-banner JSX. The three display-row types moved beside the component
that renders each (with their original comments) and are imported back for the page's state.
`renderCell`/`sortArrow` are pure functions of props, so they moved with the table. Zero behavior
change; no new state, effects, or fetches in any component.

## Half B — verbatim service moves behind a barrel

**Byte-parity evidence** — each region extracted from the pre-move `orders.ts`
(`git show` of the prior HEAD) and `diff`ed against its new home:

| Region (old orders.ts lines) | Destination | diff result |
| --- | --- | --- |
| `BoardRow` + `OrderFilter` (99–118, 20 lines) | `order-board.ts` | **identical** |
| `Traffic` + `trafficSettings` (530–541, 12 lines) | `order-board.ts` | identical except 2 mechanical deltas (below) |
| `BOARD_SELECT` → `exportOrders` (944–1093, 150 lines: `SORTABLE`, `orderByFor`, `dateRange`, `searchWhere`, `boardWhere`, `listOrders`, export `BOARD_COLUMNS`, `exportOrders`) | `order-board.ts` | **identical** |
| `parseDate` function (230–236, 7 lines) | `order-board.ts` (**copied**, not moved) | **identical** |
| `isDuplicateClientRequestId` function (611–621) | `db-errors.ts` | body **identical**; doc-comment deltas below |

Mechanical deltas, in full:
- `type Traffic` → `export type Traffic` (orders.ts imports it back for `readDetail`'s signature);
  its doc comment's "this file's own mutators" → "orders.ts's own mutators" (accuracy in the new home).
- `isDuplicateClientRequestId`'s doc comment: "db-errors.ts's own P2002 branch" → "this file's
  P2002 branch" (self-reference in the new home) plus an appended provenance paragraph naming the
  #33 move; every pre-existing rationale sentence kept verbatim.
- `parseDate` in `order-board.ts` carries a new one-line doc comment naming the per-service-copy
  precedent (`shippers.ts:103` has carried its own copy since Task 8); the function body is the
  verbatim 7 lines.

**The barrel.** `orders.ts` re-exports every public name moved —
`export { listOrders, exportOrders, trafficSettings } from "./order-board"`,
`export type { BoardRow, OrderFilter } from "./order-board"`, and
`export { isDuplicateClientRequestId } from "./db-errors"` — so all 13 routes, all 36+ consuming
test files, `order-loads.ts` and `traveler.ts` are untouched and keep pinning behavior through
their existing `@/server/orders` paths. `order-board.ts` is pure reads (no claim, no
Serializable, no allocation — its header says so and forbids adding one); its imports are
`db`/`errors`/`excel`/`settings` + two `src/lib` leaves, so the graph is a clean DAG:
routes → orders → order-board, no cycle.

**The cycle retirement.** `shippers.ts` and `invoices.ts` now import
`isDuplicateClientRequestId` from `./db-errors` (each a one-line merge into their existing
db-errors import + deletion of the `./orders` import). That removes the `shippers.ts → orders.ts`
return edge, so the documented orders↔shippers runtime cycle — previously surviving on the
hoisted-function rule — is gone; `orders.ts → shippers.ts` (`shipmentBlockers`) is
one-directional now. Cycle comments updated in the same commit: `orders.ts`'s header,
`shippers.ts`'s Task 10 banner (~1654) and its `createShipper` doc comment, and
`order-locks.ts`'s header (comment only), each recording the retirement and warning that a new
`shippers.ts → orders.ts` import would re-open it.

## Deviations and judgment calls

1. **`trafficSettings`/`Traffic` moved with the board reads** (not in the ruling's named symbol
   list). Forced: `listOrders` calls `trafficSettings`, and leaving it in `orders.ts` would have
   made `order-board.ts` import `orders.ts` back — a brand-new orders↔order-board runtime cycle
   in the very change meant to retire one (against Phase 4 lesson 3). Both are pure reads; the
   function's own doc comment was written for the board ("the board computes a light for every
   row"). Re-exported through the barrel, so `order-loads.ts`/`traveler.ts` are untouched.
2. **`parseDate` copied, not moved** — the `dateRange` builder needs it, but so does orders.ts's
   own save path; the repo's precedent for exactly this (shippers.ts) is a per-service copy.
3. **`shippers.ts`/`invoices.ts` touched** beyond the task's literal file list: two mechanical
   import-line switches plus the adjacent comment blocks documenting the now-retired cycle.
   Without them the stated purpose of the db-errors move ("breaks the shippers→orders and
   invoices→orders import-cycle edges") would not be realized — a re-export still loads the
   barrel module, so the runtime edge only breaks at the import site.
4. **Stale doc pointers deliberately left** (outside the touch list; all still functionally true
   via the barrel): `src/lib/board-columns.ts`'s two "orders.ts's `SORTABLE` map" comments,
   `src/app/api/orders/query.ts`'s header naming orders.ts for `OrderFilter`,
   `tests/db-errors.test.ts:137`'s "(orders.ts)" precedent pointer, and the `BoardRow
   (src/server/orders.ts)` mirrors in `ShipmentDetail.tsx`/`NewShipment.tsx`. One-word fixes for
   a later pass if the group wants them.
5. **`voidOrder`/`linkOrder`/`unlinkOrder` not moved** — optional in recon, outside the minimal
   slice per the ruling. No invariant comment block (#115 retry, §5.14 SSI) was touched; no
   mutator changed by so much as an import.

## Gates (all from `erp/`, foreground)

| Gate | Result |
| --- | --- |
| `npm test` | **198 files / 3310 tests passed** (427.8s, shared `erp_test` — no scratch DB needed) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |

Per-commit targeted runs also passed along the way (`orders.test.ts` 139 after the barrel;
`db-errors`/`shippers`/`invoices` 121 after the cycle commit; the new suite 18).

**E2E deliberately not run** (group-level wave next, per the brief). Board flows for that wave to
exercise: board search/scan, status + customer + date filters, saved-view create/apply/default/
delete, column show/reorder, the Export-to-Excel link (built from the same queryString as the
table's fetch), and row-click navigation to `/orders/[id]`.

## Issue #33 close-out

Deferral comment posted (commit list + the recon evidence: shared zod schemas,
`resolveLineParts`/`createSerials`/`resolveQuoteLinks`, the §5.14 SSI pairing, no test pinning
module boundaries) and the issue retitled to
"Decompose orders.ts at the create/edit seam (deferred past the acceptance month; board slice
landed)". The issue remains OPEN for the create/edit scope.

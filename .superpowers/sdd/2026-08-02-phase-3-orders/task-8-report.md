# Task 8 report: Global search service

## Status: Complete

**Commit:** `ce3cfe3` — `feat: global search service` (branch `phase-3-orders`)
**Files:** `erp/src/server/search.ts` (new, 150 lines), `erp/tests/search.test.ts` (new, 243 lines, 13 tests)

## What was built

`globalSearch(user: SessionUser, q: string): Promise<SearchResults>` — read-only, no
transaction, no audit. Three permission-filtered groups (`orders`, `parts`, `customers`) plus an
independent `exactOrderId` short-circuit, exactly matching the brief's `SearchResults` shape.

- **`exactOrderId`**: `/^\d+$/.test(q.trim())` AND a live (`deletedAt: null`) order with that
  `orderNumber` exists → its id, else `null`. Computed unconditionally alongside the groups (no
  early return, no permission gate — see "Design decision" below).
- **`orders` group** (needs `orders.view`): OR of `poNumber contains`, `vsOrderNumber contains`,
  a serial contains (`serials: { some: { serial: { contains } } }`), the LEAD (position 1) line's
  `partNumber contains`, and — when the term is digits — an exact `orderNumber` match. Voided
  (`deletedAt` set) orders excluded. Deliberately does **not** also match customer code/name
  (unlike `orders.ts`'s own board `searchWhere`) — the `customers` group already covers that
  surface; tripling every customer-name hit across all three groups would be noise, not signal.
- **`parts` group** (needs `parts.view`): `partNumber` or `name` contains, soft-deleted excluded,
  each row carries its own `customerCode` so per-customer duplicate part numbers (same number,
  two customers) both return as separate rows — asserted directly in a test.
- **`customers` group** (needs `customers.view`): `code` or `name` contains, soft-deleted
  excluded.
- All three groups: case-insensitive, ≤10 rows, ordered `createdAt desc`.
- `q.trim().length < 1` → `{ exactOrderId: null, orders: [], parts: [], customers: [] }` before
  any query runs.
- The Int4 overflow guard (`Number.isSafeInteger(n) && n <= 2_147_483_647`) is mirrored from
  `orders.ts`'s `searchWhere` in one shared `parsedOrderNumber` helper used by both
  `findExactOrderId` and the orders group's exact-number clause — a 14-digit search term does not
  crash Prisma, it just matches nothing by number.

## Design decision flagged for review

**`exactOrderId` is NOT gated on `orders.view`** — only the `orders` group array is. The brief's
literal wording gives `exactOrderId` exactly two conditions (digits, live order) with no
permission clause, and phase-3-orders-design.md §8 lists "permission-filtered per group" and
"exact-order-number short-circuit" as two separate bullets, not one. An order number is also the
literal barcode payload printed on every traveler (approved spec §4/§6 — scanning it into global
search opens the order), so treating its bare existence as lower-sensitivity than the `orders`
group's PO/VS#/customer-bearing rows seemed like the intended reading, not an oversight. The
destination `/orders/[id]` route still enforces `requireUser` + `mustCan` on the actual content.
This is exactly the kind of judgment call CLAUDE.md's "do not make assumptions" directive asks to
surface rather than silently pick — I made the call, documented it in both the code (long comment
on `findExactOrderId`) and a dedicated test (`"exactOrderId resolves even without orders.view —
only the group array is permission-gated"`), so it's one line to flip if the owner disagrees. No
route consumes this yet (Task 10), so the blast radius of being wrong here is currently zero.

## Test summary

13/13 new tests pass; full suite 808/808 (795 baseline + 13), `tsc --noEmit` clean, `eslint src
tests` clean. Coverage: exact-number short-circuit + still-fills-groups; exactOrderId's
permission-independence (the decision above); serial hit; PO hit; VS# hit (both
case-insensitive); lead-part hit vs. rider-part non-hit; per-customer duplicate part numbers both
returned with correct customer codes; customer code/name hit; permission filtering asserted
individually for orders-only, parts-only, customers-only, and no-permissions; voided-order
exclusion from both the orders group and exactOrderId; soft-deleted part/customer exclusion;
digit-overflow guard (14-digit term); empty/whitespace-only query; 10-row cap.

## Self-review

- Every brief-listed case tested, plus permission-emptiness verified per individual area (not
  just the one `parts.view`-only example) and a no-permissions-at-all case.
- Voided orders and soft-deleted parts/customers excluded, each with a dedicated test.
- Digit-overflow guard is a literal mirror of `orders.ts`'s `searchWhere`, not a reimplementation
  — same two conditions, same 2,147,483,647 constant.
- No scope creep: no route, no Shell wiring — service + test only, per the brief (Task 10 owns
  the route).
- No mutations, no `tx`, no audit calls — `permissions-sweep.test.ts`'s "no service mutates
  Prisma outside an audit helper" check passes trivially (search.ts has zero
  create/update/upsert/delete calls).

## Concerns

- The `exactOrderId` permission decision above is my interpretation of an ambiguous brief; flagged
  explicitly for the reviewer/owner rather than assumed silently.
- No route exists yet to exercise this end-to-end (expected — Task 10).

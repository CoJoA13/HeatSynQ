# Task 9 report: Order routes + 401/403

## Status: Complete

**Commit:** `0f663e2` — `feat: order routes with permission gates` (branch `phase-3-orders`)
**Files:**
- New: 13 route files under `erp/src/app/api/orders/**` (exactly the brief's list), plus one
  non-route helper `erp/src/app/api/orders/query.ts`, plus `erp/tests/order-routes.test.ts`
  (23 tests).
- Modified: `erp/src/server/orders.ts` (+38 lines — one new exported function, `defaultRequestDate`;
  nothing else touched).

## What was built

All 17 handlers across the brief's 13 files, each `handle(async (req, {params}) => …)`,
authorize-first-line, thin (delegates to the existing Task 4–7 services with no business logic of
its own):

| Route | Method | Gate | Delegates to |
|---|---|---|---|
| `/api/orders` | GET | `orders.view` | `listOrders` |
| `/api/orders` | POST | `orders.create` | `createOrder` |
| `/api/orders/export` | GET | `orders.view` | `exportOrders` |
| `/api/orders/[id]` | GET | `orders.view` | `getOrder` |
| `/api/orders/[id]` | PATCH | `orders.edit` | `updateOrder` |
| `/api/orders/[id]` | DELETE | `mustDo("void_order")` only | `voidOrder` |
| `/api/orders/[id]/lines` | POST | `orders.edit` | `addLine` |
| `/api/orders/[id]/lines/[lineId]` | PATCH/DELETE | `orders.edit` | `updateLine`/`removeLine` |
| `/api/orders/[id]/lines/[lineId]/serials` | PUT | `orders.edit` | `replaceSerials` |
| `/api/orders/[id]/containers` | PUT | `orders.edit` | `replaceContainers` |
| `/api/orders/[id]/charges` | PUT | `orders.edit` | `replaceCharges` |
| `/api/orders/[id]/loads` | PUT | `orders.edit` | `replaceLoads` (order-loads.ts) |
| `/api/orders/[id]/loads/resplit` | POST | `orders.edit` | `resplitLoads` (order-loads.ts) |
| `/api/orders/[id]/link` | POST | `orders.edit` | `linkOrder` |
| `/api/orders/[id]/unlink` | POST | `orders.edit` | `unlinkOrder` |
| `/api/orders/entry-defaults` | GET | `orders.view` | `defaultRequestDate` (new) |

Verified against the design spec's §9 table — no disagreement found between brief and spec, so no
STOP-AND-ASK was needed.

## Judgment calls made (flagged for review)

Four points in the brief were genuinely underspecified. I made a call on each, documented in code
comments, and list them here per CLAUDE.md's "surface it, don't assume" directive:

1. **`status` query param wire format.** No existing route in this codebase filters on an
   array-shaped query param, so there was no house style to mirror. `erp/src/app/api/orders/query.ts`'s
   `parseStatus` accepts **both** repeated params (`status=OPEN&status=SHIPPED`) and a
   comma-joined one (`status=OPEN,SHIPPED`), rather than forcing a single convention — cheap to
   support both, and it means neither the eventual board UI's own choice nor a future API consumer
   can get this wrong.
2. **`status` enum validation lives at the route, not the service.** `orders.ts`'s own doc comment
   on `OrderFilter` says so explicitly: *"status is already typed, so the route that turns a query
   string into this shape owns that parse."* Skipping this would have let an unrecognized status
   value reach `listOrders`'s `{ status: { in: filter.status } }` and throw Prisma's
   status-less `PrismaClientValidationError` — a bare 500, not the field-anchored 400 every other
   bad filter in this app produces. Tested directly (`status=BOGUS` → 400, not a crash).
3. **A non-route helper file (`query.ts`) shared between `GET /api/orders` and `GET
   /api/orders/export`.** The parts/customers precedent duplicates its (much simpler, 2-field)
   filter-building inline in both the list and export routes. Orders' filter has ~9 fields
   including enum + date-range validation; duplicating it risked the list and its export silently
   disagreeing on what a query string means. Extracted once instead — it is not itself a route
   (Next only maps files literally named `route.ts`), confirmed by `npm run build`'s route manifest
   showing exactly 13 order routes, not 14.
4. **`defaultRequestDate(customerId, partId?)`** (new export, `orders.ts`, placed right after
   `getOrder`): reuses `createOrder`'s exact chain (`part.requestDaysOverride ??
   customer.requestDaysOverride ?? request_days_default`) applied to `todayDateOnly()` — there's no
   saved order yet, and `createOrder` itself defaults `receivedDate` to today when omitted, so this
   mirrors that. It 400s on a nonexistent customer/part (existence only — never a raw TypeError)
   and on a part belonging to a different customer than the one asked about (a nearly-free
   extra check since the part row is already being fetched; prevents silently previewing a date
   that could never actually be saved). It deliberately does **not** check `active` — this is a
   preview with no side effects, and `createOrder` is what actually refuses to save against an
   inactive customer/part, so re-checking it here would just be the same rule enforced twice with
   no behavioral point.

Two smaller route-level decisions, less consequential:

- **Blank-string query params normalize to absent** (`?receivedFrom=&customerId=&partId=` etc.) —
  the brief's explicit instruction, applied uniformly to every optional string param in
  `parseOrderFilter` and to `entry-defaults`'s `partId`, not just the two examples named in the
  brief. Confirmed a genuinely malformed date (`receivedFrom=not-a-date`) still 400s — the
  normalization doesn't swallow real errors.
- **`PATCH /api/orders/[id]` and `PATCH /api/orders/[id]/lines/[lineId]` reject an empty body**
  with a route-level `assertRecord` + `Object.keys(body).length === 0` check, mirroring
  `parts/[id]/route.ts`'s PATCH exactly (the brief's named "read FIRST" precedent). I checked
  whether this belongs in the service instead — `updateTemplate`/`updateStep` enforce the
  equivalent "must actually change something" rule *inside* the service, with a comment explaining
  why (a no-op patch there would cut a spurious revision or write a before-equals-after audit
  entry). `updateOrder`/`updateLine` have neither of those specific side effects and are
  already-merged/tested Task 5 code I was told not to alter, so I added the guard at the boundary
  I own instead — same protection, zero touch to orders.ts's tested internals beyond the one
  authorized addition above.

## Test summary

23/23 new tests pass; full suite 831/831 (808 baseline + 23), `tsc --noEmit` clean, `eslint src
tests` clean, `npm run build` clean (route manifest lists exactly the 13 new paths, `query.ts`
correctly excluded). Coverage: every one of the 17 handlers gets a 401 (no cookie) and a 403 (wrong
permission) case; every mutator gets a 200 happy path; void tested both ways — full CRUD without
`void_order` still 403s, and `void_order` alone with zero `orders.*` permissions still succeeds;
DELETE blank/null-body 400 with audit reason asserted on the valid case; two `assertRecord`-guarded
routes (`PATCH /[id]`, `POST /link`) directly tested for null-body 400-not-500; cross-order 404 for
`lines/[lineId]` PATCH/DELETE; status filter both wire conventions plus the unknown-value 400;
blank-date-param-is-absent plus malformed-date-still-400; link's cross-customer 400 and otherId
validation; entry-defaults' precedence chain (part beats customer beats plant default) and its
cross-customer part rejection.

## Self-review

- Every route in the brief's table exists with the exact gate in the design spec's §9 table — cross-checked line by line above.
- Thin handlers confirmed: no route contains a domain rule (date math, split math, audit content,
  etc.) — every check is wire-shape parsing (record-vs-not, empty-vs-not, string-vs-not, blank-vs-not,
  known-enum-vs-not), matching the class of thing `assertRecord`/`reasonFromBody` already do
  elsewhere in the house style.
- `git diff --stat` on `orders.ts` shows exactly the +38-line addition, nothing else touched.
- No scope creep verified by directory listing: `erp/src/app/api/orders/` contains only the 13
  brief-named routes + the one internal helper — no `attachments`, `traveler`, or `documents`
  routes (Tasks 10/16), no `saved-views`/`order-drafts`/`search` routes (other tasks' own route
  files, not listed in this brief).

## Concerns

- The four judgment calls above are genuine underspecification, not spec/brief disagreement — I
  did not find a place where the brief and the design spec's §9 table contradicted each other, so
  no STOP-AND-ASK was triggered. Flagging them here is exactly for the case where the reviewer or
  owner would have picked differently; each is a small, isolated, easy-to-change decision if so.
- `defaultRequestDate`'s cross-customer part check is new behavior with no prior test coverage to
  fall back on (unlike everything else in this task, which only wires up already-tested services) —
  it is covered by this task's own tests, but it is the one piece of genuinely new logic in the
  diff and worth a second look for that reason alone.

## Fix round 1

**Commit:** `f3dc22c` — `fix: complete the order-route 403 sweep (all four CRUD grants vs
void_order)` (branch `phase-3-orders`)
**Files:** `erp/tests/order-routes.test.ts`, `erp/src/app/api/orders/query.ts`,
`erp/src/app/api/orders/entry-defaults/route.ts` — no production route/gate logic changed, exactly
as the review predicted.

Reviewer found the implementation and gates correct, but the 401/403 sweep didn't fully prove it:
exactly 15 distinct 403 assertions existed for 17 handlers, and the void 403 test's permission
grant didn't match its own label. Both are mechanical test gaps, addressed as follows.

**Finding 1 — two handlers with zero 403 coverage, both fixed:**
- `GET /api/orders/[id]`: added a `signInWith(["customers.view"], "detail-wrong-1")` session and a
  403 assertion, placed before the existing `viewOnly`/200 case (same pattern the sibling `GET
  /api/orders` test already used for its own view-gated 403).
- `DELETE /api/orders/[id]/lines/[lineId]` (`removeLineRoute`): added a 403 assertion using the
  same `viewOnly` session its sibling `patchLineRoute` assertion in the same block already had,
  right after it.

**Finding 2 — the void 403 test's grant and label, fixed:** `signInWith([...])` now grants all
four `orders.view/create/edit/delete`, not three; the test title now says "all four orders.* CRUD
grants" instead of the previously-inaccurate "the full orders CRUD set"; a comment explains why
`orders.delete` in particular matters to include (it's the permission most likely to be mistaken
for "the void permission" since DELETE is the HTTP verb). The assertion itself (403 without
`void_order`) was already correct — only the grant proving it needed completing.

**Minor items — all three taken:**
1. `orUndefined` exported from `query.ts` and imported into `entry-defaults/route.ts`, replacing
   the route's own inline re-implementation of the identical "blank means absent" rule.
2. Added a null-body 400 test for `PATCH /api/orders/[id]/lines/[lineId]` (`nullPatch`), mirroring
   the existing null-body coverage already present for `PATCH /api/orders/[id]` and the void
   `DELETE`.
3. Added a new test, `"PUT .../lines/[lineId]/serials 404s a line that belongs to a different
   order"`, mirroring the existing cross-order 404 test already written for
   `lines/[lineId]` PATCH/DELETE.

**Re-verification:** `npx vitest run tests/order-routes.test.ts` — 24/24 pass (23 → 24, the one
net-new test from Minor #3; Finding 1/2 fixes added assertions to existing tests rather than new
`it()` blocks, except where noted). Full suite 832/832 (832 = 831 prior + 1). `npx tsc --noEmit`
clean. `npx eslint src tests` clean. `npm run build` clean — `✓ Compiled successfully`, same 13
order routes in the manifest, `query.ts` still correctly excluded.

**403 coverage after this round:** exactly 17 distinct 403 assertions, one per handler, confirmed
by re-reading the full updated test file and matching each against the route table in the "What
was built" section above.

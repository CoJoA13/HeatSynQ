# Task 10 report: Aux routes — drafts, saved views, search

## Status: Complete

**Commit:** `21da01d` — `feat: draft, saved-view, and search routes` (branch `phase-3-orders`)
**Files:**
- New: `erp/src/app/api/order-drafts/route.ts`, `erp/src/app/api/saved-views/route.ts`,
  `erp/src/app/api/saved-views/[id]/route.ts`, `erp/src/app/api/search/route.ts` (exactly the
  brief's four files), plus `erp/tests/aux-routes.test.ts` (13 tests).
- Modified: nothing. No service file, schema, or `tests/order-routes.test.ts` touched.

## What was built

| Route | Method | Gate | Delegates to |
|---|---|---|---|
| `/api/order-drafts` | GET | `requireUser` only (own row, `user.id`) | `getDraft` |
| `/api/order-drafts` | PUT | `requireUser` only (own row, `user.id`) | `putDraft` |
| `/api/order-drafts` | DELETE | `requireUser` only (own row, `user.id`) | `clearDraft` |
| `/api/saved-views` | GET | `orders.view` (own rows) | `listViews` |
| `/api/saved-views` | POST | `orders.view` (own rows) | `createView` |
| `/api/saved-views/[id]` | PATCH | `orders.view` (own rows) | `updateView` |
| `/api/saved-views/[id]` | DELETE | `orders.view` (own rows), no reason | `deleteView` |
| `/api/search` | GET `?q=` | `requireUser` only | `globalSearch(user, q)` |

Verified against design spec §9's route table (lines 479–481) — exact match, no disagreement
with the brief, no STOP-AND-ASK needed.

Every handler follows the Task 9 idiom: `handle(async (req, {params}) => …)`, `const user =
requireUser()` bound to a variable (never a bare discarded call — required by
`permissions-sweep.test.ts`'s "every API route calls requireUser" regex, which only accepts
`mustCan/mustDo(requireUser())` or `= requireUser()`), ctx always passed. Zero business logic in
any handler — every check is either a permission gate or `assertRecord`.

## Judgment calls made (flagged for review)

1. **`{ ok: true }` for void-returning writes** (`PUT`/`DELETE /api/order-drafts`, `DELETE
   /api/saved-views/[id]`). Neither the brief nor the design spec specifies a response body for
   these — `putDraft`/`clearDraft`/`deleteView` all return `Promise<void>`. Mirrors the existing
   house idiom exactly (`orders/[id]/route.ts`'s void DELETE, `parts/[id]/breaks/[breakId]/route.ts`'s
   PATCH/DELETE).
2. **No `assertRecord` before `createView`/`updateView`.** Both call their own `.strict()` zod
   schema (`CREATE.parse`/`EDIT.parse`) as the very first line, and zod throws a clean `ZodError`
   (→ `handle`'s 400 branch) for a non-object/array/null body without ever touching
   `Object.keys` — so there's no raw-TypeError risk to guard against here. Mirrors
   `orders/route.ts`'s POST (`createOrder(await req.json())`, no `assertRecord`) rather than
   `orders/[id]/route.ts`'s PATCH (which *does* use `assertRecord`, but only because it needs
   `Object.keys(body).length === 0` for its own empty-body rule — a check `updateOrder` doesn't
   do that `updateView` also doesn't need). `assertRecord` **is** used on `PUT /api/order-drafts`
   because that route inspects `body.payload` itself before delegating.
3. **`GET /api/order-drafts` returns `getDraft`'s result unwrapped** (`null` or `{payload,
   updatedAt}`) — no envelope, matching how `saved-views` and every list/get route in this
   codebase returns its service's shape directly rather than nesting it under a named key (order
   routes nest under `{order: …}` only because `createOrder`/`updateOrder` themselves return
   `{order, warnings}` — that shape comes from the service, not a route-level convention).
4. **A PUT body missing the `payload` key entirely** (`{}` rather than `{payload: …}`) is not
   rejected with a 400 — it flows through as `putDraft(id, undefined)`, which the service already
   treats as "store JSON null" (`payload == null` branch, existing tested behavior in
   `order-drafts.ts`). The brief's instruction was exactly "assertRecord the envelope, pass
   `body.payload` through" with no presence check named, so I did not add one.

None of these are spec/brief disagreements — all four are places the brief left an implementation
detail open and an existing precedent already decided it.

## Test summary

13/13 new tests pass; full suite 845/845 (832 baseline + 13); `npx tsc --noEmit` clean; `npx
eslint src tests` clean; `npm run build` clean (route manifest lists exactly `/api/order-drafts`,
`/api/saved-views`, `/api/saved-views/[id]`, `/api/search` alongside the pre-existing routes, exit
0, no warnings).

Coverage, mapped to the brief's Step 1 list:
- Drafts: 401 on all three verbs with no cookie; a zero-role-grant session still gets 200 on all
  three (locks in "no permission gate" as a regression-testable fact, not just an absence of a
  `mustCan` call); a full PUT→GET→DELETE round trip; a non-object PUT body → 400; and the named
  isolation case — user A's PUT is invisible to user B's GET, extended to also prove B clearing
  their own draft never reaches A's row, exercised through the routes (real cookies, real
  `signInWith` sessions) rather than by calling the service directly.
- Saved views: 401/403 on GET and POST; a GET-only-sees-own-rows sanity check; 401/403 on PATCH
  and DELETE; the named 404-not-403 case for both PATCH and DELETE against another user's (real,
  permission-holding) session, plus a missing-id case taking the identical 404; DELETE exercised
  with no `reason` in the body at all.
- Search: 401 with no cookie; the named case — a `parts.view`-only session gets `orders: []`
  through the route while still getting real `parts` hits (proves the route hands the *real*
  session user to the service rather than a reconstruction, since a fabricated/partial user
  object couldn't reproduce this exact split); one additional full-access case showing every group
  fills when the caller holds all three `*.view` grants.

## Self-review

- Every brief bullet re-checked against the file (see "What was built" table) — all four files,
  all methods, gates exact.
- Drafts: grepped the route file — zero occurrences of `mustCan`/`mustDo`; every query/mutation
  keyed on `user.id` from `requireUser()`, never a query param or body field named `userId`.
- Search: `globalSearch(user, q)` — `user` is the identifier bound directly from `requireUser()`,
  never spread/reconstructed into a new object; confirmed by `tsc` (a hand-built partial object
  would not satisfy `SessionUser`'s type, including the nested `role.permissions`/`overrides`
  shape `can()` reads).
- `git status`/`git show --stat HEAD` confirm exactly 5 files touched: the 4 brief-named routes
  and the 1 brief-named test file. No `src/server/**` file, `schema.prisma`, or
  `tests/order-routes.test.ts` in the diff.
- `npm run build`'s route manifest cross-checked line by line: exactly the 4 new paths added to
  the prior 13-orders-plus-rest set, nothing extra (no `attachments`/`traveler`/`documents` —
  other tasks' routes).

## Concerns

- Judgment calls #2 and #4 above mean saved-views' PATCH/POST have no *dedicated* aux-routes test
  proving a non-object body 400s cleanly there (unlike drafts' PUT, which does have one) — the
  underlying mechanism (zod's `.parse` throwing `ZodError` for non-object input) is exercised
  elsewhere in the suite (`orders/route.ts` POST's own null-body test) and is inherent to
  `saved-views.ts`'s already-merged, already-tested `CREATE`/`EDIT` schemas, but I did not add a
  redundant route-level copy of that assertion here since the brief's Step 1 list didn't call for
  it and the two services aren't Task 10's to re-verify.
- No reviewer pass has happened yet on this task; this report reflects only my own self-review.

## Fix round 1

**Commit:** `7646f44` — `fix: PUT order-drafts requires the payload key — a missing key must
never wipe a draft` (branch `phase-3-orders`)
**Files:** `erp/src/app/api/order-drafts/route.ts`, `erp/tests/aux-routes.test.ts` — no other
route or service file touched.

**Reviewer finding (Important) — confirmed real, exactly the edge flagged as Concern/judgment
call #4 above:** `PUT /api/order-drafts` with `{}` (the `payload` key absent, not `null`) was
silently stored as `putDraft(id, undefined)`, which the service's existing `payload == null`
branch treats as "store JSON null" — a 200 that wipes a real, previously-saved draft with no
error. Ruled against spec §12's "a crash or closed tab loses nothing": the concrete trigger is
`JSON.stringify({ payload: undefined })` in a future autosave client, which drops the key
entirely rather than sending it as `null`.

**Fix:** `erp/src/app/api/order-drafts/route.ts`'s PUT handler now checks key presence, not just
record-shape, immediately after `assertRecord(body)`:

```ts
if (!("payload" in body)) throw new HttpError(400, "payload is required");
```

`HttpError` added to the existing `@/server/http` import (already re-exported there; no new
dependency). An explicit `{ payload: null }` still passes the `in` check and flows through to
`putDraft` unchanged, preserving "explicit null still means store-null" — the DELETE endpoint
remains the one true "clear on purpose" path, PUT now never clears by accident.

**Tests added to `erp/tests/aux-routes.test.ts`** (both in the `order-drafts routes` describe
block, right after the existing non-object-body test):
1. `"PUT with an empty body (no `payload` key) is 400 and never wipes an existing draft"` — PUTs
   a real payload first, then PUTs `{}`, asserts 400 with `error` matching `/payload is
   required/`, **then re-GETs and asserts the original payload is still there** — that last
   assertion is the actual regression check; a status-code-only test would have passed even
   before the fix touched the stored row's *content*, only its *status code*.
2. `"PUT with an explicit `{ payload: null }` still succeeds — that is a deliberate store-null"`
   — PUTs a real payload, then PUTs `{ payload: null }`, asserts 200, then asserts the stored
   payload really is `null` — documents the surviving contract so a future tightening of the
   presence check can't accidentally ban explicit nulls too.

I verified both tests are load-bearing before committing: temporarily reverted the route fix
alone (removed the `if` line, left the tests in place) and reran — test 1 failed exactly as
expected (`expected 200 to be 400`), confirming it fails without the fix rather than passing
vacuously. Restored the fix (diffed byte-identical against the pre-revert version) and reran
clean before continuing.

**Minor taken:** added one non-object-body test to the `saved-views routes` describe block
(`"POST with a non-object JSON body is 400, not 500 (the service's own zod parse)"`), covering
the zod-throws-cleanly-through-the-route path the original report's Concerns section flagged as
untested. Only POST, per the reviewer's "one is enough" — PATCH takes the identical code path
through the identical `.strict()` zod schema shape (`EDIT.parse` vs `CREATE.parse`), so a second
copy would assert the same mechanism twice.

**Re-verification:**
- `npx vitest run tests/aux-routes.test.ts` — 16/16 pass (13 → 16: the two draft tests + one
  saved-views test).
- Full suite: 848/848 (845 baseline + 3 new).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.

(`npm run build` not re-run this round — not part of this fix's contract; the change is a single
route-level conditional plus one added import, and the prior round's build already covered the
route manifest.)

**Report path:** `/home/cojoa13/Desktop/HeatSynQ/.superpowers/sdd/task-10-report.md`

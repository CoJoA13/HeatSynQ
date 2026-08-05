# Task 15 Report: Delete-guard extensions + request-day overrides UI

**Branch:** `phase-3-orders`
**Commit:** `84d5264` — `feat: live orders block part/customer deletion; request-day overrides`
**Baseline:** HEAD `4f5d48f` (Tasks 1–14 merged, suite 872)
**Result:** suite 879 (872 + 7 new), tsc clean, eslint clean, build clean

## What was implemented

### 1. Live-order delete guards

**`deletePart`** (`erp/src/server/parts.ts`) now refuses inside its existing Serializable
transaction when a live order carries a line — lead or rider, no distinction — referencing the
part:

```ts
const orders = await tx.order.count({ where: { deletedAt: null, lines: { some: { partId: id } } } });
if (orders > 0) throw new HttpError(400, `That part is used by ${orders} live order(s)`);
```

Counting `Order` rows (not `OrderLine` rows) means the count already agrees with the deduped
blocker list even if a part appears on two lines of the same order. A voided order (`deletedAt`
set) does not count. This is a wholly new guard — `deletePart` previously had none; it only
cascaded its own children (specs/inspections/price breaks).

**`deleteCustomer`** (`erp/src/server/customers.ts`) gets a new, independent guard added *after*
its existing live-parts count, *before* the address/contact cascade:

```ts
const orders = await tx.order.count({ where: { customerId: id, deletedAt: null } });
if (orders > 0) throw new HttpError(400, `That customer still has ${orders} live order(s)`);
```

This is deliberately a **direct** scan on `Order.customerId`, independent of the parts guard: an
order can outlive every part it references (because parts could already be soft-deleted through
some path other than `deletePart`'s own new guard — e.g. data older than this change), so a
customer with zero live parts can still be blocked by a live order. The existing
`"That customer still has N part(s)"` message and its test are untouched — this task only adds a
sibling check with its own message.

### 2. Discoverable blocker lists (BlockerPanel shape)

New `partOrderBlockers(partId)` (parts.ts) and `customerOrderBlockers(customerId)` (customers.ts),
both returning the existing `Blocker` shape (`{ entityLabel, name, id, href }`), named exactly the
way `reference-links.ts`'s pre-existing `orderContainer -> containerType` entry already names an
Order blocker elsewhere in the app: `"#1042 · ACME"`, linking to `/orders/[id]`.
`partOrderBlockers` dedupes by order id (a part could appear on two lines of one order).

New routes, mirroring the customers precedent exactly:
- `GET /api/parts/[id]/blockers` — new, parts never had one
- `GET /api/parts/[id]/blockers/export` — new, xlsx via the same 3-column shape every other
  blockers-export route uses
- `GET /api/customers/[id]/blockers` — **changed** to return the union of
  `customerPartBlockers` + `customerOrderBlockers`, so the panel always shows everything blocking
  the delete, not just whichever guard threw first
- `GET /api/customers/[id]/blockers/export` — same union, in the xlsx

I deliberately did **not** fold this into the generic `findBlockers`/`REFERENCE_LINKS` registry
(`src/lib/reference-links.ts`). That registry's sweep test only scans FKs targeting a
`ReferenceKind` (Material/Terms/GLAccount/…), which Part/Customer are not, so nothing there
required touching; and `customerPartBlockers` already has its own bespoke, differently-ordered
implementation (by `partNumber`, not `id`) that a generic-registry migration would have put at
risk. Two small bespoke functions, matching the existing bespoke-function precedent, were the
lower-risk and more surgical choice.

### 3. UI wiring

- **`erp/src/app/parts/[id]/page.tsx`**: added the `blocked`/`BlockerPanel` state and wiring
  (the `customers/[id]/page.tsx` `removeCustomer()` precedent) — matched on `"live order(s)"`,
  fetches `/api/parts/${id}/blockers` on refusal, renders `<BlockerPanel>`. Parts had *no* prior
  blocked-delete handling at all, so this is new, not an extension.
- **`erp/src/app/customers/[id]/page.tsx`**: widened the existing match condition from
  `"still has" && "part(s)"` to `"still has" && ("part(s)" || "live order(s)")` so an orders-only
  refusal (zero live parts) still opens the panel.

### 4. `requestDaysOverride` — expose an existing column

**No schema change.** `requestDaysOverride Int?` already existed on both `Part` and `Customer`
(consumed by `orders.ts`'s `part.requestDaysOverride ?? customer.requestDaysOverride ??
request_days_default` chain since an earlier task) — it was simply never exposed through the
create/update zod schemas, `SELECT`, or the UI. This task:
- Added `requestDaysOverride: z.number().int().min(0).nullable().optional()` to `parts.ts`'s
  shared `FIELDS` (used by both CREATE and UPDATE) and to `customers.ts`'s `CREATE` (UPDATE is
  `CREATE.partial()`).
- Added it to both `SELECT` projections and `PartRow`/`CustomerRow`.
- Added a labeled number field to both detail pages: `IdentitySection.tsx` right after "Load
  weight" (mirroring `loadQty`'s exact int-parse-before-send pattern, since this is a real
  `z.number().int()`, not a `decimalField`), and `customers/[id]/page.tsx`'s Commercial section
  right after "Finance charge rate", with the label "Request days override" and the helper text
  "Blank uses the plant/customer default." (part page) / "Blank uses the plant default." (customer
  page, since there's no part-override to fall back to from that screen).
- Audit diffs need no `SNAPSHOT_INCLUDE`/`AuditableModel` change — `part`/`customer` are already
  `undefined` there (bare `findUnique`, which captures every scalar column automatically).
- Added the column to both list-export routes (`api/parts/export`, `api/customers/export`),
  which required updating two existing tests that asserted an exact xlsx header row
  (`parts-paste-export.test.ts`, `customer-paste.test.ts`).

### 5. Rider: LoadsSection.tsx orphan warning (T14 review finding)

`LoadsSection.tsx` now renders `{grid.orphanWarning && <p className="mb-2 rounded bg-amber-50 p-2
text-sm text-amber-800">{grid.orphanWarning}</p>}` right after its `<h2>`, identical markup to the
other three grid sections. The section's own doc comment and `bulk-grid.ts`'s "Loads is immune"
comment both claimed Loads never needed this because `applyLoads` updates rows in place — true for
same-length saves, but `applyLoads` **hard-deletes** trailing rows when a save shrinks the array
(this section's own remove, or a Re-split landing on fewer loads), so a pending edit against one of
those now-gone ids orphans exactly like it would under the delete-then-recreate sections. Both
comments were rewritten to describe the shrink-path exception rather than leaving a now-false
"never" claim in the code.

## Design decisions worth flagging

1. **Sequential guards, not one combined message.** `deleteCustomer` still throws whichever guard
   (children → parts → orders) trips first, one at a time — the pre-existing
   `"still has 2 part(s)"` test asserts that *exact* string with parts>0/orders=0, so I did not
   merge the two counts into one message. "Both lists in the refusal" is satisfied at the
   **panel** level instead: the blockers fetch always returns the union of parts + orders,
   regardless of which guard's message actually fired, so nothing blocking the delete is ever
   hidden from the user once they open the panel.
2. **Order-blocker naming reuses an existing convention, not new code.** The `"#N · CODE"` format
   and `/orders/[id]` href already existed in `reference-links.ts` for the unrelated
   `orderContainer -> containerType` link; I reused the same textual convention by hand in the two
   new bespoke functions rather than depending on that file.
3. **Test isolation trick**: to test deleteCustomer's order-guard independent of its (unrelated,
   pre-existing) parts guard, one test directly soft-deletes the referenced part via raw Prisma
   (bypassing `deletePart`, with a comment explaining why) to simulate the only way that state can
   arise post-Task-15: data older than this guard, or any path other than `deletePart` itself.

## Tests added (7 new, suite 872 → 879)

- `tests/parts.test.ts`:
  - `deletePart` refused by a live order on either the lead or a rider line; blocker row shape
    exact-matched; voided order unblocks both parts.
  - `requestDaysOverride` round-trips create/update/null, rejects negative (`ZodError`) on both
    create and update.
  - Update audit diff shows `requestDaysOverride` before/after.
- `tests/customers.test.ts`:
  - `deleteCustomer` refused by a live order with **zero** live parts (part soft-deleted out of
    band); blocker row shape exact-matched; `customerPartBlockers` confirmed empty in that state;
    a second scenario proves voided unblocks both `deletePart` and `deleteCustomer`.
  - `requestDaysOverride` round-trip + negative rejection.
  - Update audit diff.
- `tests/parts-routes.test.ts`: new 401/403/200 + xlsx content-type/disposition test for the new
  `blockers`/`blockers/export` routes (mirrors the customers-routes precedent).
- `tests/customer-routes.test.ts`: extended the existing blockers-route test to also create an
  order and assert the **combined** part+order list, in order.
- `tests/parts-paste-export.test.ts` / `tests/customer-paste.test.ts`: updated the two
  exact-header-row assertions to include the new "Request days override" column.

## Verification

- `npm test` — 72 files, **879 passed**, 0 failed.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — clean, both new part routes (`/api/parts/[id]/blockers`,
  `/api/parts/[id]/blockers/export`) present in the route manifest.
- **Live browser verification** (dev server, admin/admin, scratch customer+part created and then
  removed from the dev DB afterward): confirmed on both the Customer and Part detail pages that
  the "Request days override" field renders in the right section with the right helper copy,
  saves a positive integer (persisted in Postgres), and rejects a negative value with a visible
  `requestDaysOverride: Too small: expected number to be >=0` banner while leaving the stored value
  unchanged. (One dead end during this pass: the browser-automation harness intermittently failed
  to deliver real focus to a clicked element — reproduced identically against the pre-existing,
  unmodified `loadQty` field, confirming it was an environment quirk and not a regression; a
  fresh `focus()` + verified-`isTrusted` event sequence worked reliably once identified.)

## Self-review checklist (from the task)

- Both entities' guards symmetric — yes: both refuse on a live order, both ignore voided,
  both expose a same-shaped `Blocker[]` list and export.
- Voided-unblocks tested both directions — yes, in both `parts.test.ts` and `customers.test.ts`.
- Override fields on both pages, sibling habit — yes, same look/behavior on both, visually
  confirmed.
- Blocker rows link correctly — yes (`/orders/[id]`), asserted in 4 different tests (2 service,
  2 route) plus visually confirmed the label/section render.
- Rider one-liner in — yes, same commit, plus the one dependent doc-comment in `bulk-grid.ts`
  that would otherwise have gone stale.
- No scope creep — new files are limited to the two new parts-blockers routes (necessary for
  parity with the customers shape the brief points at); no unrelated business logic touched.

## Files touched

- `erp/src/server/parts.ts`, `erp/src/server/customers.ts`
- `erp/src/app/api/parts/[id]/blockers/route.ts` (new),
  `erp/src/app/api/parts/[id]/blockers/export/route.ts` (new)
- `erp/src/app/api/customers/[id]/blockers/route.ts`,
  `erp/src/app/api/customers/[id]/blockers/export/route.ts`
- `erp/src/app/api/parts/export/route.ts`, `erp/src/app/api/customers/export/route.ts`
- `erp/src/app/parts/[id]/page.tsx`, `erp/src/app/parts/[id]/IdentitySection.tsx`
- `erp/src/app/customers/[id]/page.tsx`
- `erp/src/app/orders/[id]/LoadsSection.tsx`, `erp/src/lib/bulk-grid.ts`
- `erp/tests/parts.test.ts`, `erp/tests/customers.test.ts`, `erp/tests/parts-routes.test.ts`,
  `erp/tests/customer-routes.test.ts`, `erp/tests/parts-paste-export.test.ts`,
  `erp/tests/customer-paste.test.ts`

## Concerns for the owner / next reviewer

None blocking. One judgment call worth a second look: the customer's combined-blocker-list
routing (parts ∪ orders) is a genuine behavior change to an existing endpoint — if a future
caller ever depended on `/api/customers/[id]/blockers` returning *only* parts, this would surprise
them. I found no such caller (grepped for every consumer of that route), and the UI is the only
one, but flagging it explicitly since it's the one place this task widened an existing contract
rather than adding a new one.

# Task 13 Report: Shipping list page

Status: **DONE**

Commit: `e6af10d` — `feat(ui): shipping list page` on `phase-4-certs-shipping`.

## What was implemented

- `erp/src/app/shipping/page.tsx` — thin server component that renders `<ShippingList />`. No
  data fetching of its own (matches the codebase-wide precedent that every existing page.tsx is
  itself either a client component or a bare wrapper; no page in this repo currently calls
  `requireUser()` server-side — Phase 1's "client components against guarded APIs" approach), so
  there is nothing for it to authorize itself.
- `erp/src/app/shipping/ShippingList.tsx` — the client list screen (spec §11 "Shipping list"
  paragraph):
  - Columns: packing-list no (`shipperNumber`), customer (`CODE · name`), ship date, orders
    covered (comma-joined `orderLabels`), carrier, qty/weight totals, freight amount, BOL no, and
    a "voided" badge when `deletedAt` is set.
  - Filters: search-as-you-type (no debounce, the customers/parts-page precedent), a customer
    dropdown (gated on `customers.view` via `gate()` from `permission-ui.ts`, disabled + titled
    when the caller lacks it — the orders-board precedent), a ship-date `from`/`to` range, and an
    `includeVoided` checkbox defaulting **off**.
  - Excel export as a plain link to `/api/shippers/export` carrying the same query string as the
    list fetch (the customers-page / orders-board precedent).
  - `useLatest` from `src/lib/use-latest.ts` gates **both** the success and the rejection path of
    the load — a superseded request's late-arriving success or failure can never clobber a newer
    result (issues #5/#15).
  - **No `.catch(() => {})` anywhere.** A failed `/api/shippers` call sets `error` and renders a
    red banner; `rows` is left untouched (not silently swapped for `[]`), and the "No shipments"
    empty-state text is suppressed while an error is showing so a real failure can never be
    mistaken for a legitimately empty list.
- `erp/src/components/Shell.tsx` — **not modified.** Both the "Shipping" (`/shipping`, area
  `shipping`) and "Certifications" (`/certs`, area `certs`) nav entries, and both permission
  areas in `permission-constants.ts`, have existed since Phase 1 (`f00d2cca`, 2026-07-29) —
  confirmed via `git blame`. The task brief's "goes live" phrasing describes the effect of this
  page now existing behind that nav entry, not a text change to Shell.tsx itself. Left the file
  untouched, which keeps it fully out of the merge with Lane B as intended.

## Tests

`erp/tests/shipping-list.test.ts` — 8 tests, service-level filter coverage per the brief:
customer filter, ship-date range (`from`, `to`, and both together), `includeVoided` defaulting
off (implicit and explicit), and search matching each of packing-list number, BOL number, order
number, and customer code, plus a negative check that search doesn't cross customers.

### TDD evidence

`listShippers`'s filter contract (`shipperListWhere`/`shipperSearchWhere` in
`src/server/shippers.ts`) was already fully built in Task 9 — its own header comment says so
("Listing, export and the order-hub view (task-9-brief.md Step 4)... search over the
packing-list number, BOL number, order number and customer code"), and `shipper-children.test.ts`
already had partial coverage (customer filter, basic search, includeVoided) before this task. So
Step 2 ("run to verify failure") did **not** produce a RED result for the service layer — I ran
the new test file immediately after writing it and all 8 passed on the first try:

```
✓ tests/shipping-list.test.ts (8 tests) 725ms
Test Files  1 passed (1)
     Tests  8 passed (8)
```

This is expected, not a shortcut taken: this task's actual new code is the page/component, which
per the brief has no dedicated automated test (page is exercised by Task 20's E2E). The test file
is genuinely useful as characterization/regression coverage of the exact filter contract the new
page leans on (dedicated coverage of BOL-number and packing-list-number search specifically,
which the earlier partial coverage didn't exercise), but there was no bug to TDD out of the
service — it was already correct. I did not fabricate a failing state to satisfy the letter of
Step 2.

### Final gate results

```
npm test        → 92 files, 1278 tests passed (full suite, not just the new file)
npx tsc --noEmit → clean
npx eslint src tests → clean
npm run build    → succeeds; /shipping listed as a static route (○)
```

## Browser verification

Ran `npm run dev` via the Browser pane's preview tooling, signed in as `admin`/`admin`, and drove
`/shipping` directly (not just via the nav link).

- **Empty state**: with no shipments seeded, the table renders its header row and a centered
  "No shipments" placeholder — no crash, no infinite spinner.
- **Real data**: seeded one customer/order/shipment through the actual `createOrder`/
  `createShipper` service functions (a throwaway `tsx` script run against the dev DB, deleted
  afterward — not part of the commit) and confirmed the row rendered with every column correct:
  `1000 | DEMOC · Demo Shipping Customer | 2026-08-04 | 1028-1 | (blank carrier) | 25 | 12.5`.
- **Customer filter**: selecting the seeded customer from the dropdown fired
  `GET /api/shippers?customerId=<id>` and correctly scoped the table to that customer's row only
  (confirmed via the dev-server request log).
- **Search**: typing `9999` produced "No shipments"; typing `1000` (the packing-list number)
  found the row again — confirmed via `GET /api/shippers?search=9999` and `?search=1000` in the
  server log.
- **Ship-date range**: setting `from` to `2026-08-05` (one day after the seeded shipment's
  2026-08-04 ship date) correctly excluded it; resetting `from` back to `2026-08-04` brought it
  back — confirmed by `GET /api/shippers?from=2026-08-05` and the before/after row list. This also
  incidentally proved the list renders more than one customer's data correctly, since the shared
  dev DB had a second row (`987654 · ZZLANEB1`) seeded independently by Lane B's concurrent
  session on the same Postgres container — both rows coexisted correctly without collision.
- **Include-voided toggle**: clicking the checkbox fired `GET /api/shippers?includeVoided=1`,
  confirmed in the network log.
- **Failed load renders a real error, not an empty list**: patched `window.fetch` in-page to
  reject `/api/shippers` calls with a simulated network failure, then re-triggered a fetch. The
  page showed a red "simulated network failure" banner and the table body was genuinely empty
  (no rows, and critically **not** the "No shipments" placeholder text, which is suppressed while
  `error` is set) — confirming a failed request cannot be mistaken for a healthy empty list.
- Cleaned up the seed data afterward (customer `DEMOC`, its order/load/part/shipment) via a
  second throwaway script so the shared dev DB used by both lanes wasn't left cluttered; verified
  Lane B's `ZZLANEB1` fixture was untouched and still present afterward.

One tooling wrinkle, not a product bug: the sandboxed Browser pane's original tab intermittently
rendered stale content from a second, unrelated `next dev` process already running on port 3001
in this shared environment (confirmed via `ss -ltnp`). Opening a fresh tab and cross-checking
against the actual dev-server request log and a direct `curl` against `/api/shippers` (with a
real session cookie) confirmed the page and API were correct throughout; the flakiness was
isolated to that one stale tab's rendering, not the implementation.

## Files changed

- `erp/src/app/shipping/page.tsx` (new)
- `erp/src/app/shipping/ShippingList.tsx` (new)
- `erp/tests/shipping-list.test.ts` (new)
- `erp/src/components/Shell.tsx` — unchanged (both nav entries pre-existed since Phase 1)

## Self-review

- **Completeness**: every column and filter named in spec §11's "Shipping list" paragraph is
  present. No column or filter was invented beyond that list (no carrier filter, no "new
  shipment" button — spec §11 doesn't mention either for this screen, and CLAUDE.md's prime
  directive is not to add unrequested ERP-shaped features).
- **Naming**: `ShippingList` matches the brief's own filename. Local types (`ShipperRow`,
  `CustomerOption`, `Filters`) mirror existing precedents (`BoardRow`/`CustomerOption` in
  `src/app/page.tsx`) rather than inventing new shapes.
- **YAGNI**: deliberately did not add saved views, column configuration, or sorting — the orders
  board has all three, but spec §11's shipping-list paragraph asks only for filters, search, and
  export; the customers/parts-list pattern (no saved views/sorting) is the closer precedent and
  is what the brief points at.
- **Test quality**: each test asserts on the returned row `id` set precisely (not just count),
  and the search tests are scoped per-field (packing-list number, BOL number, order number,
  customer code each get their own test) rather than one combined assertion, so a future
  regression in any one clause fails a specifically-named test. Added one negative test (search
  doesn't leak across customers) beyond the brief's literal ask.
- **Row-level links**: deliberately did *not* link the packing-list number to `/shipping/[id]` —
  that detail page doesn't exist in this codebase yet and isn't part of a concurrently-active
  lane's task list either (only `task-1` through `task-13` and `task-15` briefs exist in
  `.superpowers/sdd/`; there's no task-14 brief). Linking to a route that reliably 404s would be
  a worse UX than plain text; can be added trivially once that page exists.
- **Pristine output**: full `npm test` (1278 tests), `tsc --noEmit`, `eslint`, and `npm run build`
  all clean with zero warnings.

## Concerns

- None blocking. The only judgment call worth flagging: Shell.tsx required no edit at all, which
  diverges from the task brief's literal "Modify: src/components/Shell.tsx" file list — verified
  via `git blame` that both nav entries and both permission areas already existed pre-Phase-4, so
  there was nothing to add. Left the file untouched rather than making a no-op edit, which best
  serves the brief's own stated intent (keeping this shared file out of the merge with Lane B).

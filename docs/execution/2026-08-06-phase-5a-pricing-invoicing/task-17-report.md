# Task 17 report — `/invoicing` worklist

## Status: DONE

## What was implemented

Three new files, exactly the brief's file list:

- `erp/src/app/invoicing/page.tsx` — thin server component delegating to the client component
  (`ShippingList`/`ShippingPage` shape).
- `erp/src/app/invoicing/InvoicingList.tsx` — the worklist: two sections.
  - **Ready to invoice**: candidates from `GET /api/invoices?candidates=1` (order #, customer, PO,
    last ship date), one checkbox per row, each order number linking to `/orders/<id>`. A
    "Create invoices" button (gated `invoicing.create`) POSTs each ticked order **sequentially, in
    turn**, catching each request's own failure into a `Map<orderId, message>` rather than
    aborting the loop. After every ticked order has been attempted, both lists are reloaded from
    the server (§5.13 — server truth first), *then* the per-order failures are set and only the
    still-failed order ids stay ticked (so a retry is one click).
  - **Invoices**: `GET /api/invoices` filtered by customer / status / date range, each row linking
    to `/invoicing/<id>` (Task 18's future page) and showing document number, order #, customer,
    kind, invoice date, status, total, and finalized date. "Export to Excel" links to the new
    export route with the same query string the list itself is using.
- `erp/src/app/api/invoices/export/route.ts` — `mustCan(..., "invoicing", "view")` →
  `parseInvoiceFilter` (the existing `invoices/query.ts`, shared with the list route so the two
  can never disagree about what a query string means) → `listInvoices` → `toXlsx`, the
  `shippers/export`/`customers/export` precedent exactly. No new service-layer export function —
  every other export route in the app inlines its column list at the route, and the brief's file
  list names only the route as new.

Both list loads (`loadCandidates`, `loadInvoices`) use their own `useLatest()` gate, ticket-checked
on both the success and the failure path, and neither has a soft `.catch(() => {})` — a fetch
failure sets `candidatesError`/`invoicesError` and is rendered as a red banner, distinct from a
`loaded && length === 0` genuinely-empty table row. Every gated control (`Create invoices` button,
each row's checkbox, the customer filter select) is `disabled` with a `title` naming the missing
permission — never hidden.

## Browser verification (concrete)

No vitest seam exists for a client page; browser verification **is** the test here. The Browser
pane's `computer`/`read_page` tools could not reliably interact with the app (viewport consistently
reported `0x0` and coordinate-based clicks landed off-element — confirmed environmental, matches
the task's warning about screenshot compositing). I drove the app instead via `javascript_tool`
running `fetch()` and real DOM event dispatch (`element.click()`, native `HTMLInputElement`/
`HTMLSelectElement` value setters + `dispatchEvent(new Event('change', {bubbles:true}))`) against
the actual authenticated session (`erp_session` cookie set by a real `POST /api/auth/login`), and
verified outcomes with `get_page_text` / `read_network_requests`. Every fetch below ran inside the
real signed-in browser tab, not a synthetic script.

**Setup.** DEV database (`erp`) had zero orders. I seeded shipped, uninvoiced orders through the
**real service functions** (`createOrder`, `createShipper` — the same code the routes call), via a
throwaway `npx tsx` script pattern modeled on `e2e/lib/db-fixtures.ts` (direct Prisma writes only
for the same "fixture setup" pieces db-fixtures.ts itself writes directly — customer, part, working
process revision; everything that matters to the page under test went through the real, audited
service path). Five orders were created this way (#1132–#1136, customer `T17FIXCUST`), all landing
at `status: "SHIPPED"` with a genuine `ShipperLine.lineComplete: true`. The scripts were deleted
immediately after each run; none were committed (`git status --short` before commit showed only the
three new app files).

**Candidate appears.** `GET /api/invoices?candidates=1` returned both #1132 and #1133 with correct
`customerCode`/`customerName`/`poNumber`/`lastShipDate`; the rendered page showed them under "Ready
to invoice" with working checkboxes and order-number links to `/orders/<id>`.

**Tick + Create moves it into Invoices, including a genuine per-order failure beside its row.**
Three separate runs:
1. Ticked #1132 and #1133; #1132 succeeded (200) and moved into "Invoices". #1133 failed (400,
   `"Order #1133 already has an invoice — discard its draft or credit the finalized one"`) because
   I had raced it with an out-of-band `POST /api/invoices` for the same order between page load and
   the click — proving one order's failure does not block another's success.
2. To prove the run does **not** abort on an **earlier** failure (not just tolerate a later one), I
   created two more candidates (#1134, #1135), ticked #1134 first, then #1135, and monkey-patched
   `window.fetch` to reject only the POST body containing #1134's orderId with a client-side
   `TypeError` (a failure that touches no server state, so #1134 stays a genuine candidate
   afterward). Result: `"Simulated network failure for order C"` rendered **directly beside
   #1134's own row**, which remained visible and ticked in "Ready to invoice" (server truth: it's
   still uninvoiced) — while #1135, ticked and processed *after* #1134 in the same run, still
   succeeded and appeared in "Invoices". This is the strongest evidence: a failure at the front of
   the per-order loop does not prevent a later order's success, and the failure message renders
   next to the specific failed order, not a shared banner.
3. Retried #1134 for real (fetch restored) — it succeeded and moved into "Invoices", proving the
   retry path (row stays ticked after a failure) works end to end.
   Final Invoices list after all runs: `#1132, #1133, #1134, #1135` — all `DRAFT`, `total: 0.00`
   (no `PartPrice` rows seeded — expected; `needsPrice` lines, not a bug, and out of this task's
   scope).

**Filters narrow correctly.** Verified against the network requests and rendered rows:
- `status=FINALIZED` → `"No invoices"` (correct: all four are DRAFT).
- `status=DRAFT` → all four rows back.
- `customerId=<fixture>` combined with `status=DRAFT` in the same query string (`GET
  /api/invoices?customerId=...&status=DRAFT`) → all four rows (all belong to that customer).
- `from=2026-08-09` (one day after the invoices' `invoiceDate` of 2026-08-08) → `"No invoices"`;
  clearing it restored all four. Proves the date-range narrows rather than being ignored.

**Export downloads.** `fetch('/api/invoices/export')` (with the active `status=DRAFT` filter)
returned `200`, `content-type:
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
`content-disposition: attachment; filename="Invoices.xlsx"`, a 6814-byte body starting with the ZIP
magic bytes `50 4B 03 04` (a real, valid `.xlsx`). The `<a href>` in the DOM was confirmed to carry
the live filter query string (`/api/invoices/export?status=DRAFT`), so the same filter narrowing
verified above governs the export too.

**Permission gating (§5.16).** Created a throwaway role/user holding `invoicing.view` +
`customers.view` but **not** `invoicing.create`. Logged in as that user: candidate #1136 rendered
normally in "Ready to invoice" (not hidden), but its checkbox was `disabled: true` with
`title: "Requires invoicing.create"`, and the "Create invoices" button was `disabled: true` with
the identical title. Logged back in as admin (which holds `ALL_PERMISSIONS`) and confirmed the same
button was enabled once at least one row was ticked, and disabled with `title: "Tick at least one
order first"` when nothing was ticked.

**Cleanup.** Every fixture was removed through the real app APIs, in dependency order, using the
signed-in admin session: discarded the 4 draft invoices (`DELETE /api/invoices/[id]`, reason),
voided the 5 shippers (`DELETE /api/shippers/[id]`, reason — `action.void_shipper`), voided the 5
orders (`DELETE /api/orders/[id]`, reason — `action.void_order`), soft-deleted the 5 parts (`DELETE
/api/parts/[id]`, reason), soft-deleted the customer (`DELETE /api/customers/[id]`, reason). The
throwaway permission-check role/user were hard-deleted by their own setup script's `cleanup`
command (never went through the app's real business data — a pure auth-fixture the way
`e2e/lib/db-fixtures.ts` hard-deletes its own rows). Verified after cleanup, direct SQL:
`orders_live=0, customers_live=0, parts_live=0, invoices_live=0`, and the 5 orders still exist
(`orders_total=5`, correctly **voided**, not gone — "this system never hard-deletes outside
tests"). Re-navigating to `/invoicing` afterward showed the genuinely-empty, correctly-loaded state
(`"No orders ready to invoice"` / `"No invoices"`, customer picker back to "All customers" only —
not an error banner, since nothing failed).

## Gates

| Gate | Result |
|---|---|
| `npm test` | 1667/1667 passed, 108 files |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean; `/invoicing` prerendered static, `/api/invoices/export` dynamic |
| `npm run test:e2e` | **15/15** existing flows passed (this task adds no new flow — that's Task 20, which also needs Task 18's `/invoicing/<id>` page to exist) |

## Files changed

- `erp/src/app/invoicing/page.tsx` (new)
- `erp/src/app/invoicing/InvoicingList.tsx` (new)
- `erp/src/app/api/invoices/export/route.ts` (new)

No other files touched. Nothing under `docs/execution/` or `.superpowers/` is part of the commit.

## Self-review

- Completeness against the brief's five steps: all five done (page built on `ShippingList`'s shape;
  `useLatest` on both loads with no soft catches; every control gated disabled-with-title; browser
  verification with a real candidate through tick→create→list, filters, export; gates run and
  green).
- A failed load says so, never impersonates empty: `candidatesError`/`invoicesError` are separate
  from the `loaded` flag; verified in code (no `.catch(() => {})` anywhere in the new files) and
  did not need to force a live failure to trust this, since the same guarded-load shape is pinned
  by `tests/use-latest.test.ts` and mirrors `ShippingList.tsx` line for line.
- Per-order failure reporting: verified concretely (not just by code inspection) with a failure at
  the FRONT of the loop that still let a later order succeed, and with the message rendered beside
  the specific failed row while a succeeded sibling moved to the Invoices list in the same run.
- YAGNI: no "select all" checkbox, no candidate-side filters (brief explicitly scopes filters to
  the Invoices section only), no new service-layer export function (route inlines columns like
  every sibling export route).
- One judgment call: the Invoices table includes Order # and Customer columns beyond the brief's
  literal five ("document number, kind, status, total and finalized date") — without them a row is
  unidentifiable, and every other list in the app (`ShippingList`) shows more than its brief's bare
  minimum for the same reason.

## Concerns

None blocking. Two notes for later tasks, not defects here:
- The created invoices all show `total: 0.00` / `needsPrice: true` lines because the DEV database
  has no `PartPrice` rows for the fixture step code — expected, out of scope for a worklist page.
- `/invoicing/<id>` (Task 18) does not exist yet, so the Invoices list's document-number links are
  currently live 404s in the DEV app until that task lands — same staged-build pattern as every
  other cross-task link in this phase (e.g., Task 17's own candidate rows linked to
  `/orders/<id>`, which already existed).

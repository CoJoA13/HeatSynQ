# Task 16 report — invoice/credit API routes and the 401/403 sweep

## What was implemented

Ten route files under `src/app/api/invoices/**` and `src/app/api/orders/[id]/invoices/route.ts`,
plus two non-route helper modules (`invoices/response.ts`, `invoices/query.ts`), the
`tests/permissions-sweep.test.ts` extension, and `tests/invoice-routes.test.ts` (12 tests).

**Deviation from the literal file list, and why.** The brief's "Files: Create" list did not
include a change to `src/server/invoices.ts`, but `GET /api/invoices` (the plain list, distinct
from `?candidates=1`) and `GET /api/orders/[id]/invoices` have no service function to call —
`invoices.ts` (Tasks 11–15) exports `listInvoiceCandidates` (orders ready to invoice) but nothing
that lists actual `Invoice` rows. Task 17's own plan section confirms this is expected to exist
("Invoices — the list, filtered by customer / status / date range... showing the document number,
kind, status, total and finalized date"). Per CLAUDE.md ("Business rules live in the services
under `src/server/*.ts`") and the `listShippers`/`shipmentsForOrder` precedent (shippers.ts), I
added two **pure, read-only, additive** exports to `invoices.ts`:

- `listInvoices(filter: InvoiceFilter): Promise<InvoiceListRow[]>` — every live invoice/credit,
  filtered by customer/status/date range, newest first.
- `invoicesForOrder(orderId: string): Promise<InvoiceListRow[]>` — every invoice/credit ever
  raised against an order, discarded drafts included (the `shipmentsForOrder` "full history"
  shape).

Both reuse the existing `documentNumber` helper and the `InvoiceListRow`/`InvoiceFilter` types are
new exports. No existing function, type, or money-path logic in `invoices.ts` was touched — this
is additive only, so Tasks 11–15's reviewed/approved money logic is untouched.

## Permission gate resolution — the table-vs-header conflict

The brief's own Step-1 table (and the outer task prompt's "restated" summary) disagree with each
other and, in two places, with the P5A design spec (`docs/superpowers/specs/2026-08-06-phase-5a-
pricing-invoicing-design.md` §5.5/§5.6) and with the header note explicitly marked **binding**,
carried in from Task 12's review:

- The table lists `recalculate` as `invoicing.edit` alone; the binding header note and spec §5.5's
  general rule ("any edit that changes money on a line additionally needs `change_prices`")
  both say recalculate needs `change_prices` too — and recalculate obviously changes line money
  (it re-prices and replaces every derived line). I gated it `invoicing.edit` + `change_prices`.
- The table lists `credit` as `invoicing.create` alone; the binding header note (and the outer
  prompt's restated section, independently) explicitly name `.../[id]/credit` alongside
  `lines`/`recalculate` as needing `change_prices` "in addition to" its base gate. A credit is a
  new money-bearing document (every line's amount sign-flipped), so I gated it
  `invoicing.create` + `change_prices`.
- The outer prompt's restated section says `unlock` gates on `invoicing.edit`; both the table
  ("`action.unlock_invoice` **alone** — no CRUD permission substitutes for it, the `void_shipper`
  shape") and spec §5.5 ("**Unlock** needs `mustDo(user, "unlock_invoice")`") agree with each
  other and are unambiguous. I gated unlock on `action.unlock_invoice` alone — no `mustCan` at
  all — and the route test proves the full invoicing CRUD set (view/create/edit/delete) plus
  `change_prices` still 403s without it.

I resolved every conflict in favor of whichever source was **most specific and most consistent
with the others** (the design spec's own written rule, cross-checked against the two independent
"binding requirement" restatements), never the stale table. This did not reach the BLOCKED/
NEEDS_CONTEXT bar — the correct gate was derivable, not genuinely ambiguous — but it is a real
judgment call worth a reviewer's second look, so it's called out explicitly here rather than
folded in silently.

## Per-route permission table (as implemented)

| Route | Method | Gate |
|---|---|---|
| `/api/invoices` | GET | `invoicing.view` |
| `/api/invoices?candidates=1` | GET | `invoicing.view` |
| `/api/invoices` | POST | `invoicing.create` |
| `/api/invoices/[id]` | GET | `invoicing.view` |
| `/api/invoices/[id]` | PATCH | `invoicing.edit` |
| `/api/invoices/[id]` | DELETE | `invoicing.delete` (+ reason via `reasonFromBody`) |
| `/api/invoices/[id]/lines` | PUT | `invoicing.edit` **and** `action.change_prices` |
| `/api/invoices/[id]/recalculate` | POST | `invoicing.edit` **and** `action.change_prices` |
| `/api/invoices/[id]/finalize` | POST | `invoicing.edit` |
| `/api/invoices/[id]/unlock` | POST | `action.unlock_invoice` **alone** — no CRUD substitutes |
| `/api/invoices/[id]/credit` | POST | `invoicing.create` **and** `action.change_prices` |
| `/api/orders/[id]/invoices` | GET | `invoicing.view` |

## TDD evidence

**RED**: with `src/app/api/invoices/**` and `src/app/api/orders/[id]/invoices/` temporarily moved
aside (routes not yet written), `npx vitest run tests/invoice-routes.test.ts` failed at collection
with `Error: Cannot find module '@/app/api/invoices/route'` — the whole suite failed to load, 0
tests ran.

**GREEN**: after restoring the route files, `npx vitest run tests/invoice-routes.test.ts` — **12
passed, 0 failed**.

**Discrimination proof, verified by deliberately breaking the gate**: in
`src/app/api/invoices/[id]/lines/route.ts`, commented out `mustDo(user, "change_prices")` and
re-ran `-t "lines requires invoicing.edit AND change_prices"` — the test failed at exactly the
assertion that holds `invoicing.edit` only and expects 403 (`expected 200 to be 403`, at the line
asserting `editOnlyRes.status`). Restored the line, re-ran the full file — 12/12 green again. This
is direct evidence the test would catch a missing `change_prices` gate, not just a missing gate of
any kind.

Every money route's test (`lines`, `recalculate`, `credit`) holds the base CRUD permission alone
(`invoicing.edit` or `invoicing.create`) and asserts 403, then holds `action.change_prices` alone
and asserts 403 (proving `mustCan` isn't bypassed either), then holds both and asserts 200 — the
"holds `invoicing.edit`-only → 403, add `change_prices` → 200" pair is the specific discrimination
proof the task required.

`unlock`'s test holds the **full** invoicing CRUD set (view+create+edit+delete) plus
`change_prices` and asserts 403, then holds `action.unlock_invoice` alone (no CRUD at all) and
asserts 200 — proving no CRUD grant substitutes for the named action.

## Confirmation: every route calls the no-`tx` service form

Grepped every new route file for service calls — none pass a second argument:

- `createInvoice(await req.json())` — 1 arg (the `tx?` overload takes 2).
- `finalizeInvoice((await params).id)` — 1 arg.
- `createCredit((await params).id)` — this function has no `tx`-taking overload at all (checked
  its signature in `invoices.ts`: `export async function createCredit(invoiceId: string)`), so
  there is nothing to get wrong here.
- `updateInvoice`, `replaceInvoiceLines`, `recalculateInvoice`, `discardInvoice`, `unlockInvoice`
  — none of these have a `tx` parameter at all; only `createInvoice` and `finalizeInvoice` do.

All five money-relevant mutators (`createInvoice`, `updateInvoice`, `replaceInvoiceLines`,
`recalculateInvoice`, `finalizeInvoice`, `unlockInvoice`, `createCredit`, `discardInvoice`) are
called through their public, wrapped bracket — every route runs inside the Serializable
`$transaction` + `withDbErrors` mapping.

## Files changed

- `src/server/invoices.ts` — added `InvoiceListRow`, `InvoiceFilter`, `listInvoices`,
  `invoicesForOrder` (additive, read-only; see "Deviation" above).
- `src/app/api/invoices/response.ts` — new, `invoiceResponse(detail)` wrapping `{ invoice,
  warnings }`.
- `src/app/api/invoices/query.ts` — new, `parseInvoiceFilter`/`isCandidatesQuery`.
- `src/app/api/invoices/route.ts` — new, GET (list/candidates) + POST (create).
- `src/app/api/invoices/[id]/route.ts` — new, GET/PATCH/DELETE.
- `src/app/api/invoices/[id]/lines/route.ts` — new, PUT.
- `src/app/api/invoices/[id]/recalculate/route.ts` — new, POST.
- `src/app/api/invoices/[id]/finalize/route.ts` — new, POST.
- `src/app/api/invoices/[id]/unlock/route.ts` — new, POST.
- `src/app/api/invoices/[id]/credit/route.ts` — new, POST.
- `src/app/api/orders/[id]/invoices/route.ts` — new, GET.
- `tests/permissions-sweep.test.ts` — added a second structural gate check
  (`"every invoicing route gates on a permission"`) walking `src/app/api/invoices` and
  `src/app/api/orders/[id]/invoices`, mirroring the existing admin-route check. The existing
  `"every API route calls requireUser"` check already covers the new routes automatically (it
  walks all of `src/app/api`).
- `tests/invoice-routes.test.ts` — new, 12 tests, one per table row, with the discrimination
  proofs described above.

## Gates

- `npx vitest run tests/invoice-routes.test.ts` — 12/12 pass.
- `npx vitest run tests/permissions-sweep.test.ts` — 6/6 pass.
- `npm test` (full suite) — **108 files, 1667 tests, all pass**.
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — compiles successfully; all 8 new invoice routes plus the order-scoped route
  appear in the route manifest.
- `npm run test:e2e` — **skipped deliberately**. These are API routes with no page consuming them
  yet (Tasks 17–18 build the pages); there is no UI flow to exercise. The
  `permissions-sweep.test.ts` extension is the automated permission coverage for this task.

## Self-review

- Every 403 test isolates its actual blocking permission: single-gate routes hold an unrelated
  permission (`orders.view`) or a different CRUD verb on the same area; the three money routes
  hold exactly one of the two required permissions in each 403 case; `unlock` holds the full CRUD
  set to prove none of it substitutes.
- Verified live (not just by inspection) that removing `mustDo(user, "change_prices")` from
  `lines/route.ts` flips its discrimination assertion red — see "TDD evidence" above.
- Confirmed no route passes a `tx` argument to any service call.
- Confirmed `invoiceResponse` is used on every route returning a single `InvoiceDetail` (GET,
  PATCH, PUT lines, POST recalculate/finalize/unlock/credit) — the create route returns
  `createInvoice`'s own `{ invoice, warnings, deduped }` result directly, matching the brief's
  own note that `invoiceResponse` wraps a *bare* `InvoiceDetail`, which `createInvoice`'s result is
  not.
- Confirmed fixtures in `invoice-routes.test.ts` build state through the **service** layer
  (`createInvoice`, `replaceInvoiceLines`, `finalizeInvoice`), never through a route under test —
  the `shipper-routes.test.ts` precedent, so a bug in one route under test can't be masked by
  going through another route to set up its own fixture.
- Full suite, tsc, eslint, and build all green; no regressions in any of the other 107 test files.

## Concerns

1. **The service-layer addition** (`listInvoices`/`invoicesForOrder` in `invoices.ts`) was not in
   the brief's literal "Files: Modify" list. I judged it in-scope and low-risk (additive,
   read-only, mirrors an existing precedent exactly) rather than escalating, because without it
   `GET /api/invoices` literally cannot be implemented and Task 17's own plan text assumes it
   exists. Flagging for the reviewer to confirm this judgment call.
2. **The recalculate/credit `change_prices` gate** rests on resolving a real conflict between the
   brief's own table and its binding header note (see "Permission gate resolution" above). I'm
   confident in the resolution (it's independently corroborated by the design spec's general rule
   and by two separate restatements of the binding requirement), but it is worth a reviewer's
   explicit sign-off given the money-exposure stakes CLAUDE.md calls out for this task.
3. `InvoiceFilter`'s `status` field filters on a single value (`DRAFT` or `FINALIZED`), not an
   array — the brief only asked for "customer, status, date range" without specifying multi-value
   semantics, and no consuming page exists yet (Task 17) to demand otherwise. If Task 17 needs
   multi-select status filtering, `listInvoices`/`parseInvoiceFilter` will need a small follow-up
   change (the `orders.ts`/`query.ts` `parseStatus` array-of-values shape is the precedent to
   reach for).

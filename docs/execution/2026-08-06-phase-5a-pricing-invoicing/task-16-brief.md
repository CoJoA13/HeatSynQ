### Task 16: Routes + the 401/403 sweep

> **Carried in from Task 12's review (2026-08-07). Money-changing invoice edits need
> `change_prices`, not just `invoicing.edit`.** Spec §5.5 requires `mustDo(user, "change_prices")`
> on any edit that changes what is billed — that is `.../[id]/lines` (`replaceInvoiceLines`),
> `.../[id]/recalculate`, and the credit route, in addition to `invoicing.edit`. A header-only
> `updateInvoice` (`.../[id]` PATCH of PO/date/terms/addresses) does **not** change money and takes
> `invoicing.edit` alone. `finalize`/`unlock` gate on `invoicing.edit` (they change lifecycle, not
> line amounts). The 401/403 sweep must **discriminate**: a subject holding `invoicing.edit` but
> not `change_prices` must be refused by the lines/recalculate/credit routes and accepted by the
> header PATCH — a 403 whose subject lacks both proves nothing about which gate fired (the exact
> gap Task 7's route tests had). The service layer deliberately does NOT gate `change_prices`
> (`invoices.ts` mutators are permission-free by design); the routes are the only place it lives, so
> a missing `mustDo` here has no backstop.
>
> **Also carried in from Task 13's review: the finalize/credit routes must call the NO-`tx` service
> form.** `finalizeInvoice(id)` (like `createInvoice`) exposes a `tx`-taking overload used only by
> the concurrency test; the no-`tx` form is what wraps the work in the Serializable `$transaction` +
> `withDbErrors` bracket. Routes must call the no-`tx` form, or they bypass the isolation and the
> error mapping. Same for any other invoice mutator with a `tx?` seam.

**Files:**
- Create: `src/app/api/invoices/route.ts`, `src/app/api/invoices/response.ts`, `src/app/api/invoices/query.ts`, `src/app/api/invoices/[id]/route.ts`, `.../[id]/lines/route.ts`, `.../[id]/recalculate/route.ts`, `.../[id]/finalize/route.ts`, `.../[id]/unlock/route.ts`, `.../[id]/credit/route.ts`, `src/app/api/orders/[id]/invoices/route.ts`
- Modify: `tests/permissions-sweep.test.ts`
- Test: `tests/invoice-routes.test.ts`

**Interfaces:**
- Consumes: everything `invoices.ts` exports; `handle` / `requireUser` / `assertRecord` / `reasonFromBody` (`src/server/http.ts`); `mustCan` / `mustDo`.
- Produces:
```ts
// src/app/api/invoices/response.ts — NOT a route (the shippers/response.ts precedent)
export async function invoiceResponse(detail: InvoiceDetail): Promise<NextResponse>;
// { invoice, warnings } on EVERY mutating response, so no route can drop the needs-price surface
```

- [ ] **Step 1: Write the failing route tests** `tests/invoice-routes.test.ts`, using `signInWith(permissions)` from `tests/helpers/auth.ts` and passing ctx on every call. One case per row of this table — the whole point is that no gate is missing:

| Route | Method | Gate |
|---|---|---|
| `/api/invoices` | GET | `invoicing.view` |
| `/api/invoices?candidates=1` | GET | `invoicing.view` |
| `/api/invoices` | POST | `invoicing.create` |
| `/api/invoices/[id]` | GET | `invoicing.view` |
| `/api/invoices/[id]` | PATCH | `invoicing.edit` |
| `/api/invoices/[id]` | DELETE | `invoicing.delete` (+ reason via `reasonFromBody`) |
| `/api/invoices/[id]/lines` | PUT | `invoicing.edit` **and** `action.change_prices` |
| `/api/invoices/[id]/recalculate` | POST | `invoicing.edit` |
| `/api/invoices/[id]/finalize` | POST | `invoicing.edit` |
| `/api/invoices/[id]/unlock` | POST | `action.unlock_invoice` **alone** — no CRUD permission substitutes for it, the `void_shipper` shape |
| `/api/invoices/[id]/credit` | POST | `invoicing.create` |
| `/api/orders/[id]/invoices` | GET | `invoicing.view` |

  Each gets three cases: **401** with no cookie, **403** holding everything *but* the required permission, **200** holding it.

- [ ] **Step 2: Run to verify failure**, then write the routes. Every one follows `src/app/api/shippers/[id]/route.ts` exactly — `handle(async (req, { params }) => …)`, authorize on the first line, parse, delegate, and wrap through `invoiceResponse`. `invoices/query.ts` parses the list filter (customer, status, date range, `candidates=1`) the way `shippers/query.ts` does, so the list and its export can never disagree about what a query string means.

- [ ] **Step 3: Write `invoiceResponse`**, copying `src/app/api/shippers/response.ts` including its reasoning comment — the mutators return a bare `InvoiceDetail`, so without one shared wrapper a route could silently drop the needs-price warnings a screen is supposed to show.

- [ ] **Step 4: Extend `tests/permissions-sweep.test.ts`** — it already asserts every route calls `requireUser`; confirm the ten new routes are covered by the existing walk and that none of them slipped in without a `mustCan`/`mustDo`.

- [ ] **Step 5: Run the tests, then gates + commit** — `feat: invoice routes with the full 401/403 surface`

---


### Task 9: Order routes + 401/403

**Files:**
- Create: `src/app/api/orders/route.ts` (GET list / POST create), `src/app/api/orders/export/route.ts`, `src/app/api/orders/[id]/route.ts` (GET / PATCH / DELETE void), `src/app/api/orders/[id]/lines/route.ts` (POST), `src/app/api/orders/[id]/lines/[lineId]/route.ts` (PATCH / DELETE), `src/app/api/orders/[id]/lines/[lineId]/serials/route.ts` (PUT), `src/app/api/orders/[id]/containers/route.ts` (PUT), `src/app/api/orders/[id]/charges/route.ts` (PUT), `src/app/api/orders/[id]/loads/route.ts` (PUT), `src/app/api/orders/[id]/loads/resplit/route.ts` (POST), `src/app/api/orders/[id]/link/route.ts` (POST), `src/app/api/orders/[id]/unlink/route.ts` (POST), `src/app/api/orders/entry-defaults/route.ts` (GET)
- Test: `tests/order-routes.test.ts`

Gates per the spec §9 table: list/get/export/entry-defaults `orders.view`; create `orders.create`; every edit `orders.edit`; DELETE = `mustDo(user, "void_order")` + `reasonFromBody`. `entry-defaults` takes `customerId` + optional `partId`, returns `{ requestDate: "yyyy-mm-dd" }` via the §6 chain (service helper exported from `orders.ts`).

- [ ] **Step 1: Failing tests** — the house 401/403 sweep shape: every handler 401 with no cookie, 403 with a session lacking the exact permission (`signInWith([])` / `signInWith(["orders.view"])` against an edit route, `signInWith(["orders.view","orders.create","orders.edit"])` against DELETE — void needs the special), 200 happy path each; DELETE with blank reason → the service's 400; ctx always `{ params: Promise.resolve({ id, lineId }) }`.
- [ ] **Steps 2–4: FAIL → implement (thin handlers, authorize → parse → delegate) → PASS + gates.**
- [ ] **Step 5: Commit** — `feat: order routes with permission gates`


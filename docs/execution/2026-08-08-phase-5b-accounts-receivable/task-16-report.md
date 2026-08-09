# Task 16 — implementation report

**Commit:** `14ff4fa` — `test(5b): 401/403 sweep across the receivables routes`

## Deliverable 1 — `write_off` route gating

`src/app/api/receivables/applications/route.ts`:

- Line 3: `import { mustCan, mustDo } from "@/server/permissions";`
- Lines 6–18: a private `hasWriteOffLine(body: unknown): boolean` type-guard. It only needs to
  recognize the same `lines`/`type` shape `applications.ts`'s own `APPLY` zod schema already
  requires — any body that reaches a WRITE_OFF line inside `applyPaymentInTx` must already match
  this shape, so the loose peek here can never let a real write-off through ungated. A body that
  *doesn't* match still reaches `applyPayment`, which reports its own 400 via zod (unchanged
  behavior for malformed bodies).
- Lines 48–55 (the `POST` handler), the conditional gate:

  ```ts
  export const POST = handle(async (req) => {
    const user = requireUser();
    mustCan(user, "receivables", "create");
    const body: unknown = await req.json();
    if (hasWriteOffLine(body)) mustDo(user, "write_off");
    await applyPayment(body);
    return NextResponse.json({ ok: true });
  });
  ```

  Gate order matches the brief exactly: `mustCan(create)` → parse body → conditional
  `mustDo(write_off)` → delegate to `applyPayment`. `requireUser()` is called once and reused
  (`const user = ...`), not called a second time — keeps the `permissions-sweep` structural check
  (`CALLS_REQUIRE_USER` regex, `=\s*requireUser\(\)`) matching.

  A session holding `receivables.create` but not `action.write_off` submitting an all-PAYMENT/
  DISCOUNT body is unaffected (`hasWriteOffLine` is `false`, `mustDo` never runs). The same session
  submitting a body with *any* WRITE_OFF line — even mixed with PAYMENT/DISCOUNT lines in the same
  call — now gets a 403 before `applyPayment` (and therefore the claim/transaction) ever runs.

- `credit-applications/route.ts` was left untouched, confirmed against spec §9: only a write-off
  line carries the extra `write_off` special action; a CREDIT application is its own permission
  surface (`receivables.create` alone), not touched by this task.

## Deliverable 2 — the 401/403 sweep

13 route files, 19 route+verb combinations. All now assert both no-session→401 and
wrong-permission→403 (plus the write-off-specific cases on `POST /applications`).

| Route (verb) | Gate | 401 before | 403 before | Change |
|---|---|---|---|---|
| `POST /batches` | create | missing | present | added 401 |
| `GET /batches` | view | missing | present | added 401 |
| `GET /batches/[id]` | view | missing | present | added 401 |
| `PATCH /batches/[id]` | edit | missing | present | added 401 |
| `DELETE /batches/[id]` | delete | missing | present | added 401 |
| `POST /batches/[id]/payments` | create | missing | present | added 401 |
| `DELETE /batches/[id]/payments/[paymentId]` | delete | missing | present | added 401 |
| `GET /applications?customerId=` | view | present | present | none needed |
| `GET /applications?paymentId=&invoiceId=` | view | present | present | none needed |
| `POST /applications` | create (+`write_off` for a WRITE_OFF line) | present | present | added 3 write-off-specific tests (403 without special, 200 with special, mixed-line variant) |
| `DELETE /applications/[id]` | delete | missing | missing | added both 401 and 403 (previously only a happy-path test existed) |
| `POST /credit-applications` | create | present | present | none needed |
| `GET /aging` | view | missing | present | added 401 |
| `GET /aging/export` | view | missing | present | added 401 |
| `GET /statements` | view | missing | present | added 401 |
| `POST /statements` | view | missing | present | added 401 |
| `POST /statements/run` | create | missing | present | added 401 |
| `GET /statements/documents` | view | missing | present | added 401 |
| `GET /customers/[id]/receivables` | view | present | present | none needed (Task 15 already covered 401/403/200) |

Files touched:
- `tests/receivables-routes.test.ts` — added a 401 assertion (unauthenticated request, same body/
  params as the existing 403 case) to the top of every one of the 13 `it` blocks that lacked one,
  and renamed each block's description from `"403s without X, then ..."` to `"401s without a
  session, 403s without X, then ..."` to keep the description honest.
- `tests/applications-routes.test.ts` —
  - 3 new tests for the write-off gate: a WRITE_OFF-only body without `action.write_off` (403, 0
    applications created), the same body with `action.write_off` (200, 1 WRITE_OFF application),
    and a **mixed** PAYMENT+WRITE_OFF body in one call proving the gate looks at every line, not
    just the first (403 without the special action, 200 with it, both lines land as one call).
  - 2 new tests for `DELETE /applications/[id]`: unauthenticated → 401 (no batch/payment/invoice
    setup needed — `requireUser()` runs before any DB read), and a session holding
    `receivables.edit` but not `receivables.delete` → 403 (asserts the application's `deletedAt`
    stays `null`, i.e., nothing was voided).
- `tests/customer-routes.test.ts` — untouched; already had full 401/403/200 coverage for
  `GET /customers/[id]/receivables` from Task 15.

## Deliverable 3 — permissions-sweep

`npx vitest run tests/permissions-sweep.test.ts` — **6/6 passed**. No changes were needed to the
sweep itself or to any route/service — every receivables route already called
`mustCan(requireUser(), ...)` or (after this task) `const user = requireUser(); mustCan(user,
...)`, both of which match `CALLS_REQUIRE_USER`'s regex, and `applications.ts` mutates only inside
`applyPaymentInTx`'s single Prisma transaction via `auditedCreate`/`auditedSoftDelete` (unchanged
by this task — only the route added a peek at the parsed body, no new mutation path).

## TDD RED/GREEN for the write-off case

RED — stashed the `applications/route.ts` change (`git stash push -- src/app/api/receivables/
applications/route.ts`) and ran the new tests against the un-gated route:

```
npx vitest run tests/applications-routes.test.ts -t "WRITE_OFF"
```
→ 2 failed as expected:
- `POST refuses a WRITE_OFF line without action.write_off, even holding receivables.create (403)`
  — got 200, expected 403.
- `POST applies a mixed PAYMENT+WRITE_OFF submission only when the caller holds action.write_off`
  — got 200, expected 403 on the no-special-action half.

(The third new write-off test, the happy-path "with `action.write_off`" case, passed even in RED —
expected, since it only asserts 200, which the un-gated route also returns.)

GREEN — `git stash pop` restored the gating; same command:

```
npx vitest run tests/applications-routes.test.ts -t "WRITE_OFF"
```
→ 3 passed, 17 skipped (the `-t` filter).

## Gate results (all foreground)

| Gate | Result |
|---|---|
| `npx vitest run tests/receivables-routes.test.ts tests/customer-routes.test.ts tests/permissions-sweep.test.ts tests/applications-routes.test.ts` | 52/52 passed |
| `npx vitest run ... tests/applications.test.ts tests/receipts.test.ts` (adjacent files touched by earlier tasks, per git status) | 106/106 passed |
| `npm test` (full suite) | 120 files / 1860 tests passed |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean; all `/api/receivables/**` and `/api/customers/[id]/receivables` routes present in the manifest as `ƒ` (dynamic) |

No dev server was started (host resource constraints, per the parent instructions); `npm run
test:e2e` was not run for this task — it touches route-level authorization only, no UI/flow
behavior changed (no component reads a different response shape; a 403 was already the shape every
screen already handles for every other receivables gate).

## Self-review

- Every one of the 19 route+verb combinations enumerated in the brief now has both a 401 and a 403
  assertion (or, for the two already-complete files, confirmed pre-existing coverage rather than
  duplicating it).
- The `write_off` gate is strictly conditional on a WRITE_OFF line being present — verified by the
  mixed-line test (PAYMENT+WRITE_OFF together requires the special action; a PAYMENT-only or
  DISCOUNT-only body, covered by the pre-existing happy-path test, still works with only
  `receivables.create`).
- `requireUser()` is called exactly once in the modified `POST` handler and reused for both
  `mustCan` and the conditional `mustDo` — matches the brief's explicit instruction and keeps the
  `permissions-sweep`'s structural regex satisfied.
- `credit-applications` was checked and confirmed to need no special-action gate — spec §9 ties
  `write_off` to write-offs only.
- The sweep was not weakened: no assertion was loosened, removed, or given a wider match; every
  change is additive (new `it` blocks or new assertions inside existing ones).
- Grepped the diff for stray debug code / leftover `console.log` / commented-out assertions —
  none.

## Concerns

- None blocking. One minor stylistic note for a future pass: `receivables-routes.test.ts` now
  mixes the "401 assertion inline inside the existing 403 test" style (this task) with the
  "separate `it('... (401)')` test" style already used in `applications-routes.test.ts` and
  `customer-routes.test.ts`. Both styles were already present across the receivables test suite
  before this task; I matched each file's own existing convention rather than unifying them, since
  the brief asked for coverage, not a refactor of test structure.

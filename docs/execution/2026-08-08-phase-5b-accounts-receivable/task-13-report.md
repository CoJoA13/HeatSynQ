# Task 13 — implementation report (controller recovery note)

**Recovery context.** The Task 13 implementer subagent completed the implementation but the app
crashed (environmental — host resource contention) before it committed, wrote its own report, or
ran the gates. The working tree held a complete, uncommitted implementation, which survived a
second crash unchanged. Rather than trust it blindly or discard it, the controller (a) verified
there were no stubs/TODOs, (b) read the backend additions in full, and (c) ran the full gate chain
— all green — then committed the work (`ffd6139`) and dispatched the task review. This note stands
in for the implementer's lost report; the task-reviewer verifies the code against it as usual.

## What the recovered work implements

Task 13 = the `/receivables` batch worklist + the batch-entry & apply screen, plus the read
endpoints the UI needs (which Tasks 6–8 did not build — those covered the mutations).

**Client (new, under `src/app/receivables/`):**
- `page.tsx` + `ReceivablesList.tsx` — the worklist: open batches + a status filter, each row
  linking to `/receivables/batches/[id]`; a "New batch" action (deposit date + optional control
  total) gated on `gate(perms, "receivables.create")`.
- `batches/[id]/page.tsx` + `BatchDetail.tsx` (31 KB) — the batch header with the **live balance**;
  a payments table (add payment: payer customer, payment type, amount, check #); per payment an
  **apply panel** over the payer's — and its family's — open finalized invoices, with an amount
  input, a discount affordance shown when `discountAvailable > 0`, and a write-off input (reason
  required) additionally gated on `gateDo(perms, "write_off")`; the unapplied remainder shown as
  on-account; a POSTED batch renders read-only; post/void with reason prompts. Follows 5A's
  `InvoiceDetail` binding-state model (`key={id}` remount, `useMutationGate`, `useEditGuard`,
  `useBulkGrid`, `gate`/`gateDo`).

**Nav (`src/components/Shell.tsx`):** the dead `{ label: "A/R", href: "/ar", area: "ar" }` entry
(the `/ar` route never existed) was **repurposed** to `{ label: "Receivables", href:
"/receivables", area: "receivables" }` — one working A/R nav entry gated on `receivables.view`,
not a confusing duplicate. The vestigial `"ar"` AREA stays in `permission-constants.ts` (removing
it is out of scope — see the owner note in progress.md).

**Backend read endpoints (the UI's data — a legitimate expansion the plan's "consumes the routes"
glossed over; Tasks 6–8 built only the mutations):**
- `receipts.ts` → `listBatches(filter)` + `BatchListRow`/`BatchFilter` — the worklist rows (thin
  summary: batchNumber/depositDate/controlTotal/status/enteredTotal/balance), live batches only,
  newest-first — the `listInvoices` precedent. `GET /api/receivables/batches?status=` gated
  `receivables.view`.
- `applications.ts` → `invoiceOpenBalanceById(invoiceId)` and `openInvoicesForPayer(customerId)`
  (+ `familyCustomerIds` helper) — the apply grid's data: every live FINALIZED INVOICE (never a
  CREDIT) in the payer's family with a positive open balance, oldest-first. Family = payer's root
  (`parentId ?? self`) + the root's children (the aging/statement rollup rule). Reuses
  `ar-balances.invoiceOpenBalance`; Decimal→number via `.toNumber()`. `GET
  /api/receivables/applications?customerId=` gated `receivables.view`.
- `ar-constants.ts` → `RECEIPT_BATCH_STATUS_LABELS` (client-safe label map for the UI).

**Tests added** (backend endpoints): `receipts.test.ts` (+listBatches), `applications.test.ts`
(+invoiceOpenBalanceById/openInvoicesForPayer, incl. family resolution),
`applications-routes.test.ts` + `receivables-routes.test.ts` (the two new GET routes' happy-path +
403). Client components are E2E-covered (Task 17), not unit-tested — the 5A `InvoicingList`/
`InvoiceDetail` precedent.

## Gates (controller-verified on the recovered tree, all FOREGROUND, before commit `ffd6139`)

- `npx tsc --noEmit` → exit 0 (clean).
- `npx eslint src tests` → exit 0 (clean).
- `npm test` → **1845 passed (120 files)** (+13 over Task 12's 1832 — the new endpoint tests).
- `npm run build` → exit 0; `/receivables` (static) and `/receivables/batches/[id]` (dynamic) in
  the route manifest.

## Controller review before commit

- No TODO/FIXME/stub/"not implemented" markers anywhere in the recovered files.
- The backend additions reuse `ar-balances` (no re-derived balance math), convert every Decimal
  via `.toNumber()`, filter `deletedAt: null`, and are read-only (no claim/audit needed — pure
  reads).
- The nav change is exactly the intended repurpose (no duplicate entry, no dead link).

## Open items for the task review to adjudicate

- The backend read-endpoint **expansion** beyond the plan's UI-only Task 13 scope — verify it is
  the minimal support the UI needs and is properly gated (`receivables.view`) and tested.
- `openInvoicesForPayer`'s **family resolution** correctness (root = `parentId ?? self`, root +
  children; the payer always included via the de-duped set).
- The `documentNumber` prefix formatting is duplicated from `invoices.ts`/`statements.ts` (both
  private) — a minor DRY the implementer's own comment acknowledges.
- Browser verification of the worklist + apply screen is a separate controller step after review.

## Fix round 1 (review findings, both Important)

**Finding 1 — apply money-control gate didn't match the route it calls.** The apply screen's
PAYMENT/DISCOUNT amount inputs and the Apply button were gated in `BatchDetail.tsx` on
`receivables.edit`, but `POST /api/receivables/applications` enforces
`mustCan(requireUser(), "receivables", "create")` — the UI's enabled-state and "Requires …"
tooltip disagreed with what the server actually allows. Owner ruling: apply is an
entity-creation (an `Application` row), consistent with add-payment and create-batch, which
already gate on `create` — so the money gate moves to `receivables.create`.

  - `erp/src/app/receivables/batches/[id]/BatchDetail.tsx:310-324` — renamed the raw gate variable
    `editGateRaw` → `applyGateRaw` and changed its source from `gate(perms, "receivables.edit")`
    to `gate(perms, "receivables.create")`; `moneyGate` (feeds the PAYMENT/DISCOUNT amount inputs
    + the Apply button, via `statusLocked(applyGateRaw, posted)`) and `writeOffGateCombined`'s
    base (the write-off input's title/disabled fallback) both now derive from `applyGateRaw`, so
    the write-off input keeps its additional `gateDo(perms, "write_off")` layered on top of the
    now-`create` money gate, per the brief. Nothing else changed: `postGate` (line ~332) still
    reads `gate(perms, "receivables.edit")` directly (post-batch is correctly edit-gated — it
    calls the PATCH route, which gates edit), `createPaymentGate` was already `receivables.create`,
    `deletePaymentGate`/void gates were already `receivables.delete`/untouched.

**Finding 2 — `GET /api/receivables/applications` had no 401/403 coverage.** The route has two
modes (`?customerId=` openInvoicesForPayer — a payer's whole family's open balances — and
`?paymentId=&invoiceId=` discountAvailable), both gated `mustCan(requireUser(), "receivables",
"view")`, but neither had a test asserting the gate is enforced (its sibling `GET
/api/receivables/batches` has this coverage). Added four tests to
`erp/tests/applications-routes.test.ts` (right before the existing "GET ?paymentId=&invoiceId=
returns the live open balance…" test), mirroring the file's own `signInWith`/`noParams` pattern:
  - `GET ?customerId= refuses an unauthenticated caller (401)`
  - `GET ?customerId= refuses a caller without receivables.view (403)`
  - `GET ?paymentId=&invoiceId= refuses an unauthenticated caller (401)`
  - `GET ?paymentId=&invoiceId= refuses a caller without receivables.view (403)`

### Verification (FOREGROUND, this fix round)

- `npx vitest run tests/applications-routes.test.ts tests/receivables-routes.test.ts` →
  **2 files passed, 29 tests passed** (15 in applications-routes.test.ts, up from 11; 14 in
  receivables-routes.test.ts, unchanged) — no regression, new 401/403 tests green.
- `npx tsc --noEmit` → exit 0 (clean; the `BatchDetail.tsx` gate change is client-only, no type
  errors).
- `npx eslint src tests` → exit 0 (clean).
- `npm run build` → exit 0; route manifest still lists `/receivables` and
  `/receivables/batches/[id]`, confirming the UI still compiles.
- Full `npm test` was not re-run this round (focused run covered both changed files; no doubt
  surfaced warranting the full suite, per the task instruction to skip it on a resource-constrained
  host absent a specific reason).

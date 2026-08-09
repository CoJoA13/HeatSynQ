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

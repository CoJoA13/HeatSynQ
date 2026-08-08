# Task 20 report — E2E flow, demo walkthrough, and docs

**Status: DONE**

Commit: `026ff4c` — `feat: invoicing E2E flow, demo walkthrough and docs` (base `0060f1a`).

## What the flow establishes

`erp/e2e/flows/invoice-shipped-order.mjs`, registered as the **16th** flow in `e2e/run.mjs`
(`as: "admin"`, last — it creates its own order/customer and leaves nothing for a later flow to
depend on). It drives the whole invoicing lifecycle through the real app:

1. Keys an order (`createOrderViaUi`) against the fixture's two-`PartPrice` part
   (`FIXTURE.invPartNumber`, one order line, ten units) — ruling 3's multi-operation case.
2. Ships it complete from `/shipping/new` (`startNewShipment` + the "Line 1 complete" checkbox) —
   the board shows **Shipped**.
3. On `/invoicing`, ticks the order under **Ready to invoice** and clicks **Create invoices** —
   waits for the real `POST /api/invoices` response, then opens the new DRAFT from the **Invoices**
   table (never `page.waitForURL(...)` for the `/invoicing` → `/invoicing/<id>` hop — waits for the
   invoice page's own post-navigation-only h1, the kind + document-number badge, per Step 2/3 of
   the brief).
4. Asserts the invoice shows **two** OPERATION rows (one per `PartPrice` row on the part), one
   SURCHARGE row carrying the fixture surcharge's own name, one SALES TAX row (the fixture
   customer's own `salesTaxRate`), and nothing flagged "needs price".
5. **Finalizes** — asserts a header field goes read-only, Recalculate/Finalize themselves disable
   (with the "Already finalized" title), Unlock enables, and the board shows **Invoiced**.
6. **Prints** — waits for the real `POST /api/invoices/<id>/print` response, then waits for the
   invoice page's own **Documents** panel to list the printed document. This is the print→archive
   seam Task 19 built and no flow before this one exercised.
7. **Unlocks** with a reason (`armPrompt`) — asserts the prompt's message names the invoice and the
   audit-history language, the invoice returns to **Draft**, every control re-enables, and the
   board returns to **Shipped** (not Open — status is the human line-complete flag, spec §5.2, not
   quantity arithmetic).

## A real gap found and closed

Step 6 above could not pass as written against the invoice page's own Documents section:
`GET /api/invoices/[id]/documents` did not exist. `InvoiceDetail.tsx`'s `InvoiceDocumentsList`
(Task 18) had been calling it on the documented license that a later task would build it; Task 19's
brief built `printInvoice` and the print route but never listed this list route among its
deliverables, so it was never built. Closed rather than worked around (the order-hub's own
`/api/orders/[id]/documents` route already showed the invoice via Task 19's `listDocumentsForOrder`
change, so the flow *could* have checked there instead — I judged closing the actual page's own
panel was the right fix given the brief's framing of this exact seam):

- `listDocumentsForInvoice(invoiceId)` in `src/server/documents.ts`, mirroring
  `listDocumentsForCert`/`listDocumentsForShipper` exactly (no cross-kind union needed — a credit's
  own printed document carries the credit's own id in `invoiceId`, never its source invoice's).
- `GET /api/invoices/[id]/documents` (`src/app/api/invoices/[id]/documents/route.ts`), gated
  `invoicing.view`, mirroring `GET /api/certs/[id]/documents`.
- Tests: `tests/documents.test.ts` (three new cases — own documents only, newest-first +
  credit-vs-source separation, 404 on a missing invoice) and `tests/invoice-pdf.test.ts` (401/403/
  200 route tests, the `certs`/`shippers` documents-route precedent).

## The fixture reaper — extended, not widened

`e2e/lib/db-fixtures.ts` gained (all under exact-key lookup/teardown, the file's own house rule):

- `FIXTURE.invCustomerCode` (`E2EINVCUST`) — `taxable: true`, its own `salesTaxRate` ("0.070000").
  **Deliberately does NOT touch the global `BillingConfig` singleton row** — see the long comment
  on `FIXTURE`'s invoicing block: `BillingConfig` is one row shared by the whole dev database
  (CLAUDE.md), so mutating its tax rate would risk silently corrupting a developer's real billing
  config if a crash ever skipped this harness's own cleanup. `Customer.salesTaxRate` exercises the
  identical downstream computation in `invoices.ts`'s `buildPricingInput`
  (`customer.taxable ? (customer.salesTaxRate ?? config.salesTaxRate) : null`) while staying fully
  inside one cleanly-deletable fixture row. Flagging this as a judgment call, not a literal reading
  of the brief's "a `BillingConfig` with a tax rate" — I chose the customer-level override for
  safety; if the controller wants the literal `BillingConfig` row touched instead, it needs its own
  capture/restore-on-cleanup design (the row is never deleted, only ever updated).
- `FIXTURE.invPartNumber` (`E2E-INV-PART`) — one part, two `PartPrice` rows on two brand-new,
  dedicated step codes (`E2E-INV-OPA`/`E2E-INV-OPB`, NOT `stepCodeA`/`stepCodeB`/`priceStepCode` —
  those already carry exact-count assertions in `blocked-code-delete.mjs`/`permission-gating.mjs`
  this fixture must not perturb), each on its own GL account (`E2E-4701`/`E2E-4702`).
- One active, plant-wide surcharge (`E2E Invoice Surcharge`, PERCENT, scope ALL).
- New deletion helpers `deleteInvoicesAndLines` (Invoice/InvoiceLine/their StoredDocument+AuditLog
  rows, scoped through the fixture customer's orders, run BEFORE `deleteOrdersAndChildren` —
  `Invoice.orderId` is `ON DELETE RESTRICT`) and `deleteInvoicingReference` (the two GL accounts +
  the surcharge, run AFTER `deleteStepCodes`). `AuditLog` swept for both new entity kinds
  (`"invoice"`, and `"storedDocument"` scoped by `invoiceId` — the existing sweeps in
  `deleteOrdersAndChildren`/`deleteShippingAndCerts` only ever matched documents via
  `orderId`/`shipperId`/`certId`, none of which an INVOICE/CREDIT document carries).
- `reapLeftovers()` gained matching lookups (by code/name, customer-scoped exactly like every
  existing entry) so a crashed run self-heals the same way.

**A real bug this surfaced and fixed, not just a design choice:** the first full run's cleanup
failed — `ShipperOrder_orderId_fkey` (RESTRICT) blocked deleting the invoicing order because I had
initially scoped `deleteShippingAndCerts` to only `[shipCustomerId, holdCustomerId]`, forgetting
that this flow's own shipment (a real `Shipper`/`ShipperOrder` pair) needed the same scope. Fixed by
folding `invCustomerIds` into the shared `shipHoldCustomerIds` set both `reapLeftovers()` and
`cleanup()` read from, so the two paths cannot drift apart again. Verified by re-running: cleanup
now reports `cleanup ok` every time.

## 3× stability result

Ran `npm run test:e2e` three times consecutively after the fix above (a fourth, earlier run — before
the fix — failed on my own assertion bug below and left a cleanup failure, which the next run's
`reapLeftovers()` self-healed automatically, proving that path too):

| Run | Result |
|---|---|
| 1st (post-fix) | **16/16 PASS**, `cleanup ok` |
| 2nd | **16/16 PASS**, `cleanup ok` |
| 3rd | **16/16 PASS**, `cleanup ok` |

The one true bug in my own flow code, fixed before the 3× runs above: the surcharge-name assertion
used `page.getByText(fixtures.invSurchargeName, { exact: true })` against a value that lives in a
controlled `<input>`, not text content — React controlled inputs don't expose `value` as an HTML
attribute or text content (HANDOFF §5a's own documented trap), so `getByText` can never match it.
Fixed to locate the SURCHARGE row by its static kind-label `<td>` and read the description input's
`inputValue()` directly.

## Demo doc — every deviation named

`docs/2026-08-07-phase-5a-demo.md`, on `docs/2026-08-05-phase-4-demo.md`'s shape. "Six things to
rule on before this merges" names, individually, every item the brief called out:

1. Reversing a shipment on a non-invoiced order leaves the order **Shipped, not Open** (verified
   against the actual `reverseShipperInTx` code and its own header comment in `shippers.ts`, not
   just the spec text).
2. Multi-order freight is an owner-DEFERRED N× over-bill (already recorded in HANDOFF §6 — named
   again here per the brief, not duplicated as a NEW backlog entry).
3. A credit's PDF titles itself "Credit" (confirmed by rendering the real builder against the
   golden sample data — see below — not just quoting Task 19's report).
4. Negative amounts render `"$-937.44"` (sign between `$` and digits) — confirmed the same way.
5. A credit copies its source invoice's `invoiceDate` verbatim (confirmed against
   `invoices.ts`'s `createCredit`, line "`invoiceDate: source.invoiceDate,`").
6. The PDF side-by-side comparison itself, with its three named layout deviations (no "Page No.",
   no internal row-id markers, no Fax line) — all three already documented in `pdf/invoice.ts`'s
   own header comment; re-verified visually, not just copied from the comment.

**How the PDF comparison was actually done:** I rendered a real invoice PDF and a real credit PDF
through the production `buildInvoiceDefinition` + `renderPdf` using the exact golden sample data
`tests/invoice-pdf.test.ts` already pins (order 72026 — the same numbers as
`docs/samples/Invoice Sample.pdf`), via a throwaway script (`npx tsx`, deleted after use, never
committed), and viewed both alongside the owner's own sample PDF. This is a byte-real comparison,
not a description from memory or from the test file's own assertions.

**On screenshots:** the flow's own `shot()` calls (`e2e-artifacts/invoice-shipped-order/*.png`) are
real Playwright screenshots from headless Chromium against a real `next dev` + database, produced
as a side effect of the passing runs above — not hand-captured through an interactive browser tool,
and the demo doc says so explicitly rather than implying otherwise.

## Doc updates made

- **`CLAUDE.md`** — added: (1) an invoice-is-frozen-paper paragraph (unconditional snapshot reads,
  the explicit contrast with the shipper/cert live-join-first rule directly above it) plus
  `invoice-guards.ts` as a dependency-free leaf and why (the `order-locks.ts`/Phase-4-lesson-3
  precedent — built before the import cycle exists); (2) `Invoice.creditNumber` folded into the
  existing plain-`@unique`-on-soft-deletable enumeration (now six columns, not five, with its own
  clause). Did **not** re-add the already-present `BillingConfig` singleton paragraph (it was
  already there — added by an earlier task) or any test/flow/migration counts (the file's own
  maintenance rule).
- **`docs/HANDOFF.md`** — top summary line updated to today's state; §4's "current phase" section
  updated to note Task 20's completion and what's next; a new **§4a** (what 5A delivered, the
  rulings taken, the notable lessons — explicitly marked as pre-merge scaffolding that condenses
  into one paragraph once 5A actually merges, per §2's own rule); **§6** gained a new dated entry
  naming the four demo pings not already covered there (the multi-order-freight deferral was
  already present); **§9** fully rewritten as the **5B (Accounts Receivable)** kickoff prompt,
  carrying spec §16's inheritance list **verbatim**, explicitly marked as drafted AHEAD of 5A's own
  merge (not yet used — the merge commit is a bracketed placeholder for the controller to fill in).

## Gates (all green)

| Gate | Result |
|---|---|
| `npm test` | **1688 passed** (109 files) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean (1 pre-existing, unrelated warning in `cert-results-print.mjs`) |
| `npm run build` | compiled; `/api/invoices/[id]/documents` registered |
| `npm run test:e2e` | **16/16**, run three times consecutively, all green |

## Files changed

- `erp/e2e/flows/invoice-shipped-order.mjs` (new) — the 16th flow.
- `erp/e2e/run.mjs` — registered the flow, updated the header comment ("fifteen" → "sixteen").
- `erp/e2e/lib/db-fixtures.ts` — the invoicing fixtures, two new deletion helpers, extended
  `reapLeftovers()`/`cleanup()`.
- `erp/src/server/documents.ts` — `listDocumentsForInvoice`.
- `erp/src/app/api/invoices/[id]/documents/route.ts` (new).
- `erp/tests/documents.test.ts` — `listDocumentsForInvoice` coverage.
- `erp/tests/invoice-pdf.test.ts` — the documents-route 401/403/200 coverage.
- `docs/2026-08-07-phase-5a-demo.md` (new) — the demo doc.
- `CLAUDE.md`, `docs/HANDOFF.md` — the doc updates above.

Not committed (per instruction): anything under `docs/execution/` or `.superpowers/` — this report
lives at `docs/execution/2026-08-06-phase-5a-pricing-invoicing/task-20-report.md` and stays outside
the commit, matching every other task's report.

## Self-review

- **Did the E2E flow pass 3× consecutively?** Yes, after fixing the reaper scoping bug and my own
  assertion bug — both fixes verified by re-running, not assumed.
- **Does it actually exercise print→archive?** Yes, and it surfaced a real product gap (the missing
  documents route) rather than passing around it — closed with its own service+route+tests, not a
  flow-side workaround.
- **Does it wait for content, not a URL?** Yes — every navigation wait in the new flow is a
  post-navigation-only heading, never `waitForURL`. Grepped the file to confirm no `waitForURL` call
  exists anywhere in it.
- **Is the reaper un-widened, with an AuditLog sweep for new entities?** Yes — every new lookup is
  exact-key, customer-scoped, matching the file's existing pattern; `AuditLog` is swept for both
  `"invoice"` and the invoice-scoped `"storedDocument"` rows before the rows themselves.
- **Are the demo deviations all named?** Yes — six items, each individually numbered and described,
  cross-referenced against actual code/tests rather than restated from the brief.
- **Are the doc facts accurate against the constraints file and the actual code?** Cross-checked
  every claim (ruling numbers, the `reverseShipperInTx` status behavior, `createCredit`'s
  `invoiceDate` copy, the money formatter's sign placement, the `BillingConfig` singleton
  pre-existing paragraph) against the actual source and the spec text, not against my own prior
  summaries.

## Concerns

1. **The `BillingConfig`-vs-`Customer.salesTaxRate` judgment call above.** I chose not to mutate the
   global `BillingConfig` singleton for the fixture's tax rate, on a real risk (a crash that skips
   cleanup would otherwise leave a stranger's dev database silently taxed) that the brief's literal
   wording didn't anticipate. I believe this is the right call under CLAUDE.md's own framing of that
   table, but it is a deviation from a literal reading of "a `BillingConfig` with a tax rate" in the
   brief, so flagging it explicitly rather than letting a reviewer discover it unannounced.
2. **HANDOFF.md grew by roughly 90 net lines** (443 → 531) to carry §4a's pre-merge summary and
   spec §16's inheritance list verbatim in §9. Both are temporary by design (§4a explicitly
   condenses at merge; §9 gets replaced by the next kickoff once 5B starts) and I judged the content
   asked for could not be both accurate and materially shorter — noting it in case the controller
   wants a tighter version before this merges.
3. **§9's kickoff prompt references a merge commit that does not exist yet** (`[fill in the merge
   commit]`), since Phase 5A has not merged as of this task. This is intentional and clearly marked,
   not an oversight — the controller (or whoever runs the merge) needs to fill it in at that point.

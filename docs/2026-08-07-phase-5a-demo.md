# Phase 5A demo — Pricing & Invoicing (2026-08-07)

A walkthrough for the owner: what shipped across the 20 tasks of Phase 5A, the 16th E2E flow with
its screenshots, how to watch it live, what changed for daily use, and six decisions/deviations
that need your ruling before this merges — named here, not left for you to find.

## What Phase 5A delivered

Your shop can now **price a job and bill it**. A part's recipe and its price are separate things
(ruling 3): a part carries **one price row per Process Step Code** — austempering and
straightening can each bill as their own named line on one invoice, exactly like the sample's
`PRICE` block headed `Austemper`. Each price row carries a unit price, an optional setup charge, a
minimum charge, a price-per unit (each / hundred / thousand / pound / lot), and its own price
breaks — and posts to its own GL account through its step code. **Surcharges** are named,
percent-or-flat add-ons with an include/exclude list of step codes, a minimum floor, and
per-customer opt-out or rate override (spec §7.5, ruling 6). **Sales tax** is one plant rate with a
per-customer override and an all-or-nothing taxable flag (ruling 8); **certification charges** and
**extra order charges** both bill too, each with a GL account behind it (ruling 9, §4.5's billing
configuration).

An order becomes invoiceable the moment it reaches **Shipped** — ruling 5: **one invoice per
order, billed once**, never split per-shipper or per-PO (that grouping machinery is deliberately
gone). `/invoicing`'s **Ready to invoice** worklist lists every such order; tick one or several and
**Create invoices** snapshots the shipped quantities and resolved prices into a **draft** — a
`PART` row per order line with a `OPERATION` child row per priced operation, then surcharges,
freight, charges, certification and tax, in that print order. A draft can be recalculated, its
lines replaced, or discarded (with a reason — it frees the order number); **Finalize** freezes it,
writes the order to **Invoiced**, and refuses only while a line still needs a price. Finalized
paper is **frozen** — read from its own snapshot unconditionally, never re-joined to a part's or a
step code's current name or rate (spec §5.4) — and it **Prints** to the same permanent, byte-exact
archive every other document in this system uses. **Unlock** (a reason, recorded in the audit
history, never printed) returns a finalized invoice to Draft and the order to its ship-derived
status. A **credit** is raised from a finalized invoice — the same row shape, `kind = CREDIT`, sign
flipped, its own `credit_number_next` counter — and a **reversing shipment** un-ships goods already
shipped (and usually invoiced), reusing `void_shipper`'s own dangerous-action and locking machinery
rather than adding a second one; against an already-invoiced order it writes the order to
**Reopened**.

All of it is covered by **the vitest suite** (grown across all 20 tasks — see the gate table below
for today's count) and the **sixteen-flow Playwright harness** this task adds the 16th flow to
(spec §13). Spec: `docs/superpowers/specs/2026-08-06-phase-5a-pricing-invoicing-design.md`. Plan:
`docs/superpowers/plans/2026-08-06-phase-5a-pricing-invoicing.md`. Execution ledger (every task's
brief, report and review verdict): `docs/execution/2026-08-06-phase-5a-pricing-invoicing/`.

**The 20 tasks, in build order:** invoice constants + two new settings; the schema (six tables, two
hand-written CHECKs, the registry/sweep/audit surface); `BillingConfig` + Admin → Billing;
`part-prices.ts` (price rows + breaks); the part page's Pricing section rebuilt on price rows;
`surcharges.ts` + its list/step-code/customer-override machinery; Admin → Surcharges; the
customer-side surcharge overrides, tax rate and cert suppression; `pricing.ts` (the pure resolution
engine); `invoice-guards.ts` + the new order/shipment invariants; `invoices.ts` candidates and
creation; draft edits, recalculate, discard; finalize/unlock/status-ownership; credits; the
reversing shipment; routes + the 401/403 sweep; `/invoicing`; `/invoicing/[id]` + the order hub's
Invoices section; the invoice/credit PDF, print and archive; and this task — the E2E flow, this
demo, and the doc updates.

## A gap this task found and closed

Task 19 built `printInvoice` (render, archive, stream the PDF) and its route, but never built the
matching **list** route the invoice page's own Documents panel had been calling since Task 18 —
`GET /api/invoices/[id]/documents` did not exist, so every real print left that panel 404ing on the
very page a user would check it from. This task's E2E flow is the first to exercise print and then
look at the list, which is what surfaced it. Closed the same way the shipment and cert pages'
equivalents were built (`listDocumentsForInvoice` in `src/server/documents.ts`, the route mirroring
`GET /api/certs/[id]/documents`), with its own test coverage
(`tests/documents.test.ts`, `tests/invoice-pdf.test.ts`) — not worked around.

## Seed state

Nothing beyond the standard seed: `npm run db:seed`. The E2E run below creates its own throwaway
fixtures in the dev database — on top of the existing fixture customers, this task adds an
invoicing customer (`E2EINVCUST`, `taxable: true` with its own 7% `salesTaxRate`) with one part
carrying **two** priced operations (`E2E-INV-OPA` / `E2E-INV-OPB`, each on its own GL account,
`E2E-4701` / `E2E-4702`) and one active, plant-wide surcharge (`E2E Invoice Surcharge`, 5%).
Everything is torn back out afterward — the invoice, its printed PDF, the shipment, the order, and
every audit row — on success, on a thrown error, or on Ctrl-C mid-run.

## The 16th E2E flow

Run with `npm run test:e2e` from `erp/` — this now runs **sixteen** flows in sequence (the fifteen
from Phases 2C–4, unchanged, plus this one, last). Screenshots and a `video.webm` land in
`erp/e2e-artifacts/invoice-shipped-order/` (gitignored — reviewed locally, not committed).

### 16. `invoice-shipped-order` — the whole invoicing lifecycle, end to end

Keys an order for the two-operation part (ten units, one order line) and ships it complete from
`/shipping/new` — the board shows **Shipped**. On `/invoicing`, the order appears under **Ready to
invoice**; ticking it and clicking **Create invoices** produces a DRAFT that appears in the
**Invoices** table below, and opening it shows exactly the shape ruling 3 exists for: **one PART
row with two OPERATION rows beneath it** (one per priced operation), a **SURCHARGE** row carrying
the surcharge's own name, and a **SALES TAX** row from the customer's own rate — nothing flagged
"needs price". **Finalize** locks the draft-edit controls (a header field goes read-only,
Recalculate and Finalize itself disable, Unlock enables) and the board flips to **Invoiced**.
**Print** streams and archives the PDF — the flow waits for the invoice page's own **Documents**
panel to list it, the exact seam the gap above was found through. **Unlock**, with a reason typed
into the prompt, returns the invoice to **Draft** (every control re-enables) and the board back to
**Shipped** — not Open; see the first deviation below.

**Demonstrates:** ruling 3's multi-operation invoice shape, the Ready-to-invoice worklist and
per-order create (§5.3), frozen-paper reads post-finalize (§5.4), the finalize/unlock lifecycle and
status ownership (§5.2/§5.5), and the print→archive→list seam end to end.

Artifacts: `erp/e2e-artifacts/invoice-shipped-order/02-order-created.png`,
`03-shipment-saved.png`, `04-board-shipped.png`, `05-ready-to-invoice-ticked.png`,
`06-invoice-created.png`, `07-invoice-draft.png`, `08-invoice-finalized.png`,
`09-board-invoiced.png`, `10-invoice-printed-archived.png`, `11-invoice-unlocked.png`,
`12-board-shipped-again.png`, `video.webm`.

*(A note on how these screenshots were produced, since this report should not overstate what it
did: they come from the Playwright harness's own `page.screenshot()` calls, run as real headless
Chromium against a real `next dev` + database — not hand-captured through an interactive browser
tool for this document. I did not composite or otherwise fabricate any image; every PNG named
above is a byte-real file on disk after the run below.)*

## What the printed invoice/credit actually look like, against your samples

Rendered the exact golden sample data `tests/invoice-pdf.test.ts` already pins (order 72026, the
`docs/samples/Invoice Sample.pdf` numbers) through the real `buildInvoiceDefinition` +
`renderPdf` and opened both PDFs beside your sample. The layout, the identity block, the
`Billto`/`Shipto` blocks, the `PARTS` table, the `PRICE` block (`Austemper $937.44`, `Price per
Each: $6.51 Or`, `Minimum Charge: $600.00`), `Sub Total Amount`, the named `EnergySur` surcharge
line and `Total Amount Due` all match your sample line for line, number for number. Three
deviations, all already recorded in `pdf/invoice.ts`'s own header comment and named again here so
they are not a surprise:

1. **No `Page No.: 1 of 1` line.** A pure-JSON pdfmake definition cannot carry a page-count
   callback — the identical deviation already made on the shipping ticket and the certification.
2. **No small internal row-id markers** — your sample's stray `1` beside `Remit To` and `2827`
   beside `Shipto:` are Visual Shop's own internal ids, not printed.
3. **The footer has no `Fax:` line** — there is no fax field anywhere in this model to print
   (nothing invented to fill the slot).

Everything else is byte-identical in content. A **credit**, rendered the same way with the sign
flipped and `title: "Credit"` / `documentNumber: "1000"`, titles itself **"Credit"** — the layout,
`PARTS` table and `PRICE` block are otherwise identical, and every money figure prints as
`$-937.44` / `$-37.50` / `$-974.94`.

## Six things to rule on before this merges

Named here individually — not one of these is hidden in the diff for you to find later.

> **Owner rulings, 2026-08-07 (at demo):**
> 1. **Reversing a shipment reopens the order — RULED and BUILT (owner, 2026-08-07).** Not cosmetic
>    after all: a reversal exists to correct qty/weight (reverse → correct → reprint the corrected
>    ship ticket), so the order must reopen to become re-shippable. Ruling: a reversal clears the
>    "line complete" flag on the lines it reverses, and the order re-derives to **Partial shipped**
>    (whatever shipment remains) — status stays flag-derived, §5.2 intact. Owner's own 1000-pc
>    example (ship 350 → ship 650 complete → reverse the 650 → *Partial shipped*, ship corrected
>    463 → still *Partial*, ship 187 complete → *Shipped*) is the acceptance test. Invoiced orders
>    still go to *Reopened* on reverse, and a later unlock now correctly derives *Partial shipped*.
>    Built in `aea35a3`; spec §5.2/§5.6 amended.
> 2. **Deferred — confirmed.** Multi-order freight stays a deliberate deferral (shop bills no freight).
> 3. **Approved as-is.** Credit PDF titled "Credit" — correct call, no change.
> 4. **Approved as-is.** Negative amount format `"$-937.44"` — agreed and approved for production.
> 5. **Deferred to 5B.** Whether a credit carries its own raise-date vs the source invoice's date —
>    owner will decide at 5B planning/spec (already filed, spec §16).
> 6. **Accepted.** The three print-layout deviations (Page No. line, internal row-id markers, no Fax
>    line) are fine — same class already accepted on the Phase 4 documents.

1. **Reversing a shipment on a NON-invoiced order leaves the order Shipped, not Open.** Order
   status is derived purely from the human "line complete" checkbox (spec §5.2), never from
   quantity — so un-shipping goods on an order that was never invoiced does not automatically
   un-complete that line, and the board keeps showing Shipped even though some of the shipped
   quantity just came back. This may surprise a clerk expecting a return to reopen the order.
   Changing it (making a reversal re-derive or clear the complete flag) is a spec amendment, not a
   bug fix — flag if you want that behavior instead.
2. **Multi-order freight is an N× over-bill on a billable-freight truck, and it is a known,
   deliberate deferral (owner-ruled 2026-08-07), not a bug.** Freight is a shipment-level amount;
   Phase 5A bills one order at a time (ruling 5), so N orders on one freight-billing truck would
   each bill the full truck's freight today. Your shop **does not bill freight**, so nothing is
   wrong in this deployment — the correct split (freight-on-one-order / proportional /
   single-order-only) is left for later research against other shops' practice. Recorded in
   HANDOFF §6; do not build a split without a ruling on which one.
3. **A credit's PDF titles itself "Credit", not "Invoice."** Spec §10 says a credit "prints the
   same layout with the credit number and negative amounts" and does not say what the title reads.
   Task 19's call: a credit memo is a distinct financial document, and titling it "Invoice" would
   read as misleading paper to the customer. If you want the literal word "Invoice" on a credit
   instead, it is a one-line change (`readInvoicePdfData` in `src/server/invoices.ts`).
4. **Negative amounts render `"$-937.44"`** — the sign sits between the `$` and the digits, not in
   front of the `$`. Chosen so the magnitude and the sign both read at a glance without disturbing
   the sample's positive form; Phase 7's template designer will make this editable. Confirm the
   format reads clearly to you and your customers before it goes to production paper.
5. **A credit copies its source invoice's `invoiceDate` verbatim**, not the date the credit is
   actually raised. Harmless today — nothing in 5A ages or date-filters a credit — but the printed
   credit therefore bears the ORIGINAL invoice's date, which may look wrong once statements or
   aging exist. Filed for 5B (spec §16): decide then whether a credit should carry its own
   raise-date.
6. **The PDF comparison above is close to exact but not literally pixel-for-pixel** — see the three
   named deviations (Page No., internal row-id markers, no Fax line). None of them are gaps in the
   data model; all three are print-layout limits of a pure-JSON template, the same class of
   deviation already accepted on the shipping ticket and the certification in Phase 4.

## Watching it live

- **Headed Playwright, watch the bundled Chromium click through all sixteen flows:**
  `HEADED=1 npm run test:e2e` from `erp/` — same fixtures and cleanup, just a visible browser.
- **Interactively in your own browser** against `npm run dev` — ask for a specific thing (e.g.
  "key an order, ship it, invoice it, finalize, print, unlock") and it'll be driven live in a real
  Chrome window.

## What changed for daily use

- **A part's Pricing section** (part page) is now a table of price rows, one per Process Step
  Code, each with its own setup/unit/minimum charge, price-per unit, and its own price-break table
  — replacing the old four flat columns on the part itself.
- **Admin → Surcharges** manages named add-ons (percent or flat, an include/exclude list of step
  codes, a minimum floor, a GL account); a customer's own page gains a per-surcharge opt-out/rate
  override, a taxable flag with an optional rate override, and a certification-charge suppression
  flag.
- **Admin → Billing** holds the plant-wide sales tax rate and its GL account, the freight and
  other-charge GL accounts, and the certification-charge default (step code + amount).
- **Invoicing** (left nav) is the new worklist: **Ready to invoice** (every fully-shipped,
  not-yet-invoiced order, tick-and-create, per-order failures reported beside their own row) above
  a filterable, exportable **Invoices** list.
- **The invoice page** (`/invoicing/<id>`) is one screen: header (customer/order, PO, terms,
  invoice date, bill-to/ship-to, material/process, tax rate — all read-only once finalized), the
  PART/OPERATION and surcharge/freight/charge/cert/tax line grids, totals, Recalculate/Finalize,
  Print, Raise credit, Unlock, Discard, the printed-documents list, and History.
- **The order hub** gained an **Invoices** section listing every invoice/credit ever raised against
  it, and the board now lights up **Invoiced**/**Reopened** alongside the existing ship-derived
  statuses.
- Voiding an order, voiding or editing a shipment, and adding an order charge are all now
  **refused, naming the invoice**, once a finalized invoice exists on that order — unlock or credit
  it first (spec §5.7).

## Gate results this doc is based on

All four quality gates plus the E2E suite were run clean on the combined
`phase-5a-pricing-invoicing` branch immediately before writing this doc — see the task report
(`docs/execution/2026-08-06-phase-5a-pricing-invoicing/task-20-report.md`) for the exact pass
counts: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build` all clean, and
`npm run test:e2e` — **16/16** flows passed, run **three times consecutively** to confirm
stability. Both databases report no pending migrations.

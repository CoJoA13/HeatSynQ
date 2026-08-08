# Visual Shop capture wishlist

**Purpose.** The local Visual Shop screen library (`docs/samples/` subfolders `00-`…`06-`, gitignored,
see that folder's own `README.md`) is a comprehensive but **incomplete** reference — VS has far more
menus and screens than were captured, and the capture deliberately stopped at any state-changing
action (posting, closing, delete/purge, send, print, shipping actions). This file lists the screens
we do **not** have yet that would be useful for the phases ahead, keyed to VS's actual menu labels
(from `01-navigation-inventory/`), so the next capture pass is targeted rather than exhaustive.

**Living doc.** Add rows as the owner mentions a function we lack a screen for. Capture the same way
the existing library was: navigate/search/view only, stop before anything that mutates data, keep
local (these hold live company data — never commit).

**How to read priority.** Ordered by the roadmap: 5A (pricing/invoicing) is done; **5B = Accounts
Receivable** is next; **5C = month-end close + QuickBooks Online summary export** follows; then
Phase 6 quoting, 7 templates, 8 reports (spec split recorded in the P5A spec §1).

---

## Priority 1 — Phase 5B (Accounts Receivable): the action flows we have none of

The library has A/R *reports* (open invoices, aging **warning only**, A/R information, open-AR-by-customer,
GL recap-no-records) but **none of the A/R action screens** 5B must build. From VS's **A/R menu** and
the **Billing menu**:

| VS screen (menu → item) | Why 5B needs it | Capture the sub-dialogs too |
|---|---|---|
| **A/R → A/R Batch Entry** | The cash-receipts batch (checks/cash/card/ACH) — the core of 5B (spec §7.6). | The batch header + a line; how check/card/ACH type is chosen; the live batch balance. |
| **A/R → Apply Payments to A/R** | Applying a payment to invoices — the heart of A/R. | **Partial** application, **discount**, **write-off**, and **on-account / on-account credit** — spec §3 names all four; each is likely its own dialog/field. |
| **A/R → Close the Batch** | Committing a batch. | The confirmation/summary before commit. |
| **A/R → Finance Charges** | Finance-charge assessment run (plant rate + per-customer override; idempotent; printable — §7.6). | The run parameters and the per-invoice dispute/exempt handling. |
| **A/R → Statements** | Customer statements (a document type, §10). | The statement layout/preview and its selection criteria. |
| **A/R → Aging / Summaries** (submenu, **run it**) | We only have the *warning*; 5B builds aging-with-cutoff. | The actual aging output with the as-of/cutoff parameter dialog. |
| **A/R → Payment Report** / **Credit / On Account Report** | A/R read models 5B will mirror. | — |
| **Billing → Lock Invoices and Post To A/R** | The bridge that turns a finalized invoice into an A/R open item — the 5A→5B seam. | The lock/post confirmation and what it writes. |
| **A/R → AR Utilities** | Whatever corrective tools exist (they inform edge cases). | Landing only; do not run anything. |

## Priority 2 — Phase 5C (month-end close + QBO/GL)

| VS screen | Why 5C needs it |
|---|---|
| **A/R → Preliminary Closing Report** | The pre-close review 5C's "guided month-end close" mirrors (invoiced/paid/ending A/R side-by-side, §7.6). |
| **A/R → Close AR Period** | The period-close action + its close record. **Tied to the captured Aging-Summary warning** ("invoices closed after the cutoff may be reopened and marked Not Closed") — the reopen-a-closed-invoice behavior is real 5C signal. |
| **A/R → Close Invoices** | How individual invoices move to closed. |
| **A/R → Post Payments to GL** / **AR GL Recap by Batch** / **GL Posting Table Mainte.** | The A/R→GL summary posting — feeds the QBO summary export (§7.6, idempotent, GL-sourced). |
| **Billing → Post Sales To GL** / **Sales GL Posting Register** / **Sales GL Recap by Batch** | The sales→GL side of the same summary export. |

## Priority 3 — validates recent / in-flight work (nice-to-have, lower urgency)

- **Shipping ACTIONS** — the library has only passive Shipping tabs (actions were deliberately not
  activated). A capture of VS's **reverse-shipment** flow, **mark-line-complete**, and
  **create-shipment-from-loads** would validate Phase 4/5A behavior — directly relevant to the
  2026-08-07 reversal-reopens-the-order change.
- **Billing → Create Invoices from Shipped Orders** (the run) and **Invoicing** (invoice detail /
  finalize actions) — VS's version of 5A's `/invoicing` worklist and invoice page.
- **A credit memo / VS's "Dupe Inv to Credit"** — VS's credit screen, to compare against 5A's credit.

## Priority 4 — later phases

- **Phase 6 (Quoting):** Billing → **Quotations** (create + line detail), **Quotes Pending Printing /
  Approval**, and the quote→order conversion. The library has the quotations *landing* + one quote's
  header/detail; the *create* and *convert* flows are missing.
- **Phase 7 (Template designer):** no VS analog needed — VS has no visual template editor; this phase
  is a HeatSynQ addition.
- **Phase 8 (Reports & parallel-run):** the specific **Reports menu** items the owner actually uses
  day-to-day (the go-to list is open item #3, confirmed at Phase 8 start). Capture those individually
  when the list is settled.

---

*Seeded 2026-08-07 from the first VS capture pass and this session's discussion (reversal/reship,
loads, partial shipping, credits, finance charges). Extend as more functions come up.*

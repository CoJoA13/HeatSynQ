# Phase 5A — Pricing & Invoicing (merged 2026-08-08)

*Moved verbatim out of `docs/HANDOFF.md` §4a on 2026-08-08, when Phase 5A merged. The "What it delivered / Owner rulings / Notable lessons" prose below is unedited; the original `### 4a.` heading is kept as written so older references to "HANDOFF §4a" still resolve here. Current one-paragraph state: HANDOFF §4 "Merged, in build order".*

---

### 4a. Phase 5A (Pricing & Invoicing) — MERGED to main as `359c707` (PR #58, 2026-08-08)

**Finish sequence DONE (2026-08-08):** the whole-branch review ran on the strongest model and its one fix wave was applied; the owner demo (2026-08-07, `docs/2026-08-07-phase-5a-demo.md`) ruled on the six flagged deviations — the reversing shipment now **reopens the order it reverses** (built in `aea35a3`, spec §5.2/§5.6 amended: a non-invoiced reversal re-derives to *Partial shipped*, an invoiced one to *Reopened*), the credit PDF's "Credit" title and the `"$-937.44"` negative-amount format were both approved as-is, the three print-layout deviations accepted, multi-order freight confirmed as a deliberate deferral (§6), and the credit's copied `invoiceDate` deferred to 5B (spec §16). Squash-merged as **`359c707` (PR #58, 2026-08-08)**. Final gates: **1692 tests**, `tsc`/`eslint`/`build` clean, E2E **16/16**. Codex then reviewed the PR and raised **7 findings — all verified real against the branch, none already fixed**: unlocking a *credit* releases the order's invoice-owned status (no `kind` branch, unlike finalize); part-price reads escaping the Serializable invoice transaction (`listPartPrices` on the top-level client); Recalculate double-billing a manually-overridden operation (regenerated derived line + preserved manual line); manually-added charge lines carrying no GL account and no way to set one; an emptied invoice being finalizable into a $0 INVOICED order; recalculated tax omitting preserved manual charges from its base; and voiding either side of a reversal pair corrupting the order (status stuck / ledger negative). All triaged to issues **#59–#65** for the post-5A burn-down — no correctness fix was made in-branch; the owner elected to defer, matching the #48–#56 pattern. Full triage and the resolved review threads are on PR #58.

**What it delivered.** Part pricing moved off four flat columns on `Part` onto **price rows keyed
by Process Step Code** (ruling 3 — a part bills more than one operation, e.g. austempering and
straightening as separate invoice lines), each row carrying setup/unit/minimum charges, a
price-per unit, and its own price breaks, resolved through a pure engine (`pricing.ts`).
**Surcharges** (`surcharges.ts`, spec §7.5) are named, percent-or-flat add-ons with an
include/exclude step-code list, a minimum floor, and a per-customer opt-out/rate override.
**`BillingConfig`** (a one-row singleton — CLAUDE.md) holds the plant sales-tax rate and the
freight/other-charge/cert-charge GL defaults. **`Invoice`/`InvoiceLine`** (plus `Surcharge`/
`PartPrice`/`PartPriceBreak`/`BillingConfig` — six new tables) carry the whole model, gated by one
new hand-written CHECK (`BillingConfig_singleton_check`) and a re-statement of
`StoredDocument_kind_owner_check` to add `INVOICE`/`CREDIT`. `/invoicing` is the new worklist
(Ready-to-invoice + a filterable Invoices list); `/invoicing/[id]` is the invoice page — draft
edit, Recalculate, Finalize (locks the draft, writes `Order.status = INVOICED`), Print (byte-exact
archive, the traveler/cert/ticket pattern), Unlock (a reason, returns to Draft and the order to its
ship-derived status), Raise credit (`kind = CREDIT`, its own `credit_number_next` counter), and
Discard (a never-printed draft only). The **reversing shipment** (`reverseShipper`, Task 15)
un-ships goods already shipped, reusing `void_shipper`'s own dangerous-action and
`claimOrdersInOrder` machinery rather than a second locking path, and writes `Order.status =
REOPENED` when the order carries a finalized invoice. Twenty tasks in build order: invoice
constants + settings; the schema; `BillingConfig` + Admin → Billing; part prices + breaks; the part
page's Pricing section; surcharges + Admin → Surcharges; customer-side tax/surcharge/cert
overrides; the pricing engine; `invoice-guards.ts` + the new order/shipment invariants; invoice
candidates/creation; draft edits/recalculate/discard; finalize/unlock/status-ownership; credits;
the reversing shipment; routes + the 401/403 sweep; `/invoicing`; `/invoicing/[id]` + the order
hub's Invoices section; the invoice/credit PDF/print/archive; and this task (E2E, demo, docs).

**Owner rulings taken during the phase** (spec §3 has the full text): the restructure REPLACES the
old flat-column pricing rather than coexisting with it (ruling 4 — the dev DB was empty, so free
today); one invoice per order, billed once, at SHIPPED — no per-shipper/per-order/per-PO grouping
(ruling 5, spec §7.6 superseded); sales tax is one plant rate with a per-customer override, freight
excluded from the tax base (ruling 8); the cert charge resolves part → customer-suppression →
plant default (ruling 9); corrections are unlock → correct → re-lock, or a credit — never a second
edit-after-finalize path (ruling 10); a credit is one `Invoice` row with `kind = CREDIT`, not a
separate table (ruling 11); the setup charge adds ON TOP of the minimum, not inside it (ruling 13).
Mid-phase: **multi-order freight is a known N× over-bill, owner-DEFERRED 2026-08-07** (§6).

**Notable lessons.** `invoice-guards.ts` is a dependency-free leaf (Phase 4 lesson 3 — pull a
cross-module question into a leaf *before* the import cycle exists, not after it crashes), which is
what lets `orders.ts`/`shippers.ts` refuse a mutation against an already-invoiced order without
importing `invoices.ts`. Task 2's own plan snippet was wrong (missing `liveWhere` for two
block-target kinds — caught by 21 failures on the first run; the code is right, the plan was not).
**Task 20 found and closed a gap Task 19 left open:** `GET /api/invoices/[id]/documents` — the
invoice page's own Documents panel had been calling a route that was never built (Task 19's brief
never listed it), so every real print left that panel 404ing; closed with `listDocumentsForInvoice`
and its route, mirroring the shipper/cert precedent, with its own coverage
(`tests/documents.test.ts`, `tests/invoice-pdf.test.ts`) — the E2E flow was the first thing to
exercise print-then-view-the-list, which is what surfaced it. Every task's per-task review came
back Spec ✅ / Approved on the first or second pass; the per-task deferred-minors lists the
whole-branch review will triage next are recorded in
`docs/execution/2026-08-06-phase-5a-pricing-invoicing/progress.md`.

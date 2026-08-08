# Task 18 report: `/invoicing/[id]` — the invoice page, and the order hub's Invoices section

## What was implemented

Three new files, one modified, exactly per the brief's file list:

- `erp/src/app/invoicing/[id]/page.tsx` — the bare `<InvoiceDetail key={id} id={id} />` shell,
  copying `src/app/shipping/[id]/page.tsx`'s idiom (and its comment) verbatim.
- `erp/src/app/invoicing/[id]/InvoiceDetail.tsx` — the page body: header (customer/order links,
  PO, terms, invoice date, bill-to/ship-to, material/process, tax rate, status badge, document
  number), a two-table line grid (PART/OPERATION; surcharge/freight/charge/cert/tax) backed by
  ONE `useBulkGrid` instance saved through a single `PUT .../lines`, totals, the six lifecycle
  actions (Recalculate, Finalize, Unlock, Print, Raise credit, Discard), a Documents list, and
  `HistoryPanel`.
- `erp/src/app/orders/[id]/InvoicesSection.tsx` — the order hub's Invoices section: every
  invoice/credit ever raised against the order (discarded dimmed, not hidden), each row linking to
  `/invoicing/<id>`, and a Create-invoice button.
- `erp/src/app/orders/[id]/page.tsx` — registered `InvoicesSection` beside `ShipmentsSection`.

### State model (`ShipmentDetail.tsx` precedent, copied exactly)

- `useMutationGate` — one monotonic ticket shared by `load` and every write (`applyMutation`).
- `useEditGuard` — the header's PO/terms/bill-to/ship-to text fields route through
  `onFocusField`/`onBlurSave`/`merge`, so an arriving detail never resets the field under the
  cursor. Confirmed no server import in this file (`grep '@/server'` — none).
- Header PATCH is optimistic; on failure, `load()` runs before `setError` (§5.13).
- `voidLocked`'s shape, renamed `statusLocked(g, finalized, discarded)`: discarded wins if somehow
  both were true (they cannot co-occur — discard refuses a FINALIZED invoice).
- **"Raise credit" deliberately does NOT go through `applyMutation`.** Its response describes a
  DIFFERENT document (the new credit), not this invoice — applying it here would silently swap the
  page's content out from under the URL. It calls the route directly and `router.push`es to the
  new credit's own page (the `orders/new` "Save & Print" precedent). This is the one place I
  departed from a literal `ShipmentDetail.tsx` mechanical copy, because no shipment action has this
  shape (nothing on that page creates a *different* entity and returns it).

### The line grid

One `useBulkGrid<LineFields>` instance composes the WHOLE line array once (`PUT .../lines`
replaces the entire array in one call — splitting into two grid instances would have needed
recombining at save time anyway) and is filtered twice for display: a PART/OPERATION table and a
surcharges/freight/charges/cert/tax table. `key`/`parentKey` fields carry the OPERATION→PART
self-relation across the replace (`invoices.ts`'s `wirePayloadParents`); a PART line removed
without removing its children leaves them flat rather than dangling, the server's own documented
fallback (verified live during the recalculate exercise below — see "not spec-mandated" note).

**One UI design decision I made, not spec-mandated, disclosed here:** editing a row's `amount`
also stamps `priceSource: MANUAL` and clears `needsPrice`. Recalculate preserves only
`priceSource = MANUAL` lines, so a manually-corrected line must not be silently discarded on the
next Recalculate, and a line the operator just priced no longer "needs" one. Editing other fields
(description/qty/weight) does not reclassify the line. Manually ADDED rows are always `kind:
"CHARGE"` (the one ad-hoc addition needing no order-side/surcharge-side link) and pre-stamped
`MANUAL`/`needsPrice: false`. `unitPrice`/`rate`/`setupCharge`/etc. are shown read-only (pricing
snapshots) rather than editable — editing them without re-deriving `amount` would misrepresent
what the line actually bills; `amount` is the one number that lands on the invoice.

## The per-action gate table, as built

| Action | Route gate | UI gate (as built) | Status lock |
|---|---|---|---|
| Header PATCH | `invoicing.edit` | `gate(perms,"invoicing.edit")` | `statusLocked` (finalized → "Invoice is finalized"; discarded → "Invoice is discarded") |
| Line PUT / Recalculate | `invoicing.edit` **+** `change_prices` | double gate, "whichever is actually the blocker" title, computed once as `moneyGate` | `statusLocked` on top |
| Finalize | `invoicing.edit` | `gate(perms,"invoicing.edit")`, structurally overridden to `{disabled:true,title:"Already finalized"}` when already finalized, `"Invoice is discarded"` when discarded | own structural check, not `statusLocked` (mirrors `voidGate`'s "Already voided" shape) |
| Unlock | `mustDo("unlock_invoice")` | `gateDo(perms,"unlock_invoice")`, structurally overridden to `{disabled:true,title:"That invoice is not finalized — there is nothing to unlock"}` unless FINALIZED | n/a (only actionable when finalized) |
| Discard | `invoicing.delete` | `gate(perms,"invoicing.delete")`, structurally overridden ("Already discarded" / "Cannot discard a finalized invoice — unlock or credit it instead") | n/a |
| Raise credit | `invoicing.create` **alone** | `gate(perms,"invoicing.create")`, structurally overridden ("A credit cannot itself be credited" when kind≠INVOICE; "Only a finalized invoice can be credited" unless FINALIZED) | n/a |
| Print | not built (Task 19) | `gate(perms,"invoicing.view")`, locked only by discarded ("Invoice is discarded — nothing to print") — matches the traveler/BOL print-button precedent (`<area>.view`, not `.edit`), and stays enabled on a finalized invoice per the brief | discarded only, NOT finalized |
| Create invoice (hub) | `invoicing.create` | `gate(perms,"invoicing.create")`, structurally overridden ("Only a fully shipped order can be invoiced" / "This order already has an invoice — open it below") | n/a |

Every disabled control carries a title; none are hidden (§5.16). Verified live in the browser (see
below) with three different permission sets — every title in the table above was independently
observed, not inferred.

## Browser verification — concrete observations

No vitest seam; driven live against `npm run dev` (port 3000) + the DEV database (`erp`),
signed in as `admin`/`admin` via `.claude/launch.json`'s `erp-dev` config. Screenshots are
unusable in this environment (compositing times out); every observation below is either a
`get_page_text`/`read_page` DOM read, a `read_network_requests` request/response body, or a
`javascript_tool` DOM probe (`button.disabled`/`.title`, `input.value`).

**Fixtures.** A guarded script (`tmp-invoice-fixture.ts`, run via `npx tsx`, deleted afterward)
called the real service functions (`createOrder`, `createShipper`, `addPartPrice`) directly against
the dev DB to fast-forward: customer `T18CUST`, part `T18-PART` with one priced operation
(Austenitize, $6.51/EACH, GL 4010), order #1144 shipped to line-complete (144 pcs). A second script
created order #1145 the same way plus a DRAFT invoice on it, used only for the double-gate
permission check below.

**Lifecycle, in order, on order #1144:**

1. **Create** — clicked "Create invoice" on the order hub (`POST /api/invoices` → 200). Navigated
   to `/invoicing/<id>`. Page rendered: "Invoice 1144 · Draft", header populated (customer/order
   links, PO "T18-PO" carried from the order, process "Austenitize"), lines PART (144 pcs, 3024 lb,
   amount disabled/"—") + OPERATION (unit price 6.51, GL 4010, amount 937.44 = 144×6.51), totals
   subtotal/total 937.44, Documents section showing `Request failed (404)` (Task 19's route does
   not exist yet — the honest-failure behavior working as designed).
2. **Edit a line** — set the OPERATION line's amount to 950.00 via DOM, clicked "Save lines"
   (`PUT .../lines` → 200). Response confirmed: `amount: 950`, `priceSource: "MANUAL"`,
   `needsPrice: false`, PART/OPERATION `parentLineId` link preserved across the whole-array
   replace even though the PART row itself was untouched. Subtotal/total updated to 950.
3. **Recalculate** (`POST .../recalculate` → 200) — regenerated the DERIVED Austenitize line
   (`priceSource: "PART_PRICE"`, amount 937.44) and PRESERVED the manual one (amount 950,
   `parentLineId` now `null` — the server's documented "a preserved manual line drops its parent
   link when that parent was a regenerated derived line" behavior, observed live, not just read in
   the source). Page correctly rendered 3 lines (1 PART + 2 OPERATION); subtotal/total 1887.44.
4. **Finalize** (`POST .../finalize` → 200) — confirmed via `GET /api/orders/<id>` that
   `order.status` became `"INVOICED"`. Probed every button/input on the page:
   Discard disabled/"Cannot discard a finalized invoice — unlock or credit it instead"; Finalize
   disabled/"Already finalized"; Recalculate, Save lines, Add charge line, and every Remove button
   disabled/"Invoice is finalized"; every line input (description/qty/weight/amount) disabled with
   the same title; header PO/terms readOnly and bill-to/ship-to readOnly, all "Invoice is
   finalized"; invoice-date disabled/same title. Print and Raise credit and Unlock stayed enabled
   — exactly the required lock shape.
5. **Unlock with a reason** (`POST .../unlock` body `{reason:"Task 18 browser verification
   unlock"}` → 200) — response `status: "DRAFT"`; `GET /api/orders/<id>` confirmed
   `order.status: "SHIPPED"` (ship-derived recompute, per §5.2). Re-probed controls: Save
   lines/Recalculate/Finalize/Add charge line all re-enabled; Unlock now disabled/"That invoice is
   not finalized — there is nothing to unlock"; Raise credit disabled/"Only a finalized invoice can
   be credited".
6. Finalized again (to reach the state Raise credit requires).
7. **Raise credit** (`POST .../credit` → 200) — navigated to `/invoicing/<newId>`. Page showed
   "Credit 1000 · Draft", amounts negated (`-1887.44` total), a "Credit for → source invoice" link
   whose `href` was verified (via DOM) to point at the ORIGINAL invoice's id, and no "Raise credit"
   button (kind ≠ INVOICE — structurally absent, not merely disabled, since a credit can never
   raise a further credit).
8. **Discard with a reason** (on the credit — never printed, so eligible) — `DELETE
   /api/invoices/<id>` body `{reason:...}` → 200, followed by the page's own `load()` → 200. Banner
   rendered "Discarded — Task 18 browser verification unlock" (the actual audit reason, read back
   through `/api/admin/audit`). Every editing control re-probed: Print disabled/"Invoice is
   discarded — nothing to print"; Discard disabled/"Already discarded"; Save
   lines/Recalculate/Finalize/Add charge line all disabled/"Invoice is discarded".
9. **Hub links both ways** — returned to `/orders/<id>`. Invoices section table showed BOTH
   documents: `1000 discarded Credit Draft … -1887.44` and `1144 Invoice Finalized … 1887.44`,
   each `<a href>` pointing at the correct `/invoicing/<id>`. "Create invoice" button was
   disabled/"Only a fully shipped order can be invoiced" (order is now INVOICED, not SHIPPED —
   correctly refusing a structurally-impossible second invoice, not merely a permission check).

**Double-gate title verification (the one piece of genuinely novel logic).** Created two throwaway
roles/users directly via a guarded script (hard-deleted afterward, never went through app business
data — the Task 17 report's own precedent for this exact kind of fixture):
- `t18nochangeprices` (`invoicing.edit`, no `change_prices`): on the DRAFT order-1145 invoice, Save
  lines / Recalculate / Add charge line were disabled with **`"Requires change_prices"`** — the
  correct blocker, not `invoicing.edit` (held). Finalize was enabled.
- `t18noinvoiceedit` (`change_prices` + `unlock_invoice`, no `invoicing.edit`): same controls were
  disabled with **`"Requires invoicing.edit"`** — the opposite blocker correctly named. Finalize
  was disabled with the same title (`invoicing.edit` alone gates it).

This confirms the "whichever is actually the blocker" rule is not just copied syntax but produces
the correct, DIFFERENT title depending on which of the two permissions is actually missing.

**Console:** `read_console_messages` showed zero errors across the entire session (login, create,
edit, recalculate, finalize, unlock, credit, discard, both permission-restricted sessions, hub
navigation).

**Cleanup.** In dependency order, through the real app APIs (the Task 17 report's own precedent):
unlocked + discarded the finalized invoice on #1144, discarded the DRAFT invoice on #1145, voided
both shippers (`action.void_shipper`), voided both orders (`action.void_order`), soft-deleted the
part, soft-deleted the customer. The two throwaway permission-check role/users were hard-deleted by
their own script (pure auth fixtures, never went through business data). Verified after cleanup via
direct Prisma count: `orders_live=0, orders_total=2` (voided, not gone), `customers_live=0,
parts_live=0, invoices_live=0, shippers_live=0, stray_roles=0, stray_users=0`. All five
`tmp-*.ts` scratch scripts were deleted; `git status` shows only this task's three new files plus
the one edited line in `orders/[id]/page.tsx`.

## Gates

| Gate | Result |
|---|---|
| `npm test` | 1667/1667 passed, 108 files (no vitest seam for this task — browser verification IS the test, per the brief) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | clean; `/invoicing/[id]` builds as a dynamic route (`ƒ /invoicing/[id]`) |
| `npm run test:e2e` | **15/15** existing flows passed (this task adds no new flow — that's Task 20, which also needs this page to exist and now does) |

## Files changed

- `erp/src/app/invoicing/[id]/page.tsx` (new)
- `erp/src/app/invoicing/[id]/InvoiceDetail.tsx` (new)
- `erp/src/app/orders/[id]/InvoicesSection.tsx` (new)
- `erp/src/app/orders/[id]/page.tsx` (modified — registered `InvoicesSection`)

## Self-review

- Every action's UI gate matches its Task 16 route gate exactly (table above), verified against
  the route source (`src/app/api/invoices/**/route.ts`) line by line, not from memory.
- A finalized invoice locks every editing control (header, both line tables, Recalculate,
  Add charge line, Save lines, Finalize itself, Discard) — verified live via DOM probe, not
  inferred from the code.
- Unlock re-enables every one of those controls — verified live via DOM probe after the actual
  unlock call, order status re-derivation confirmed via a direct GET.
- Print and Raise credit both stay usable on a finalized invoice (per the brief); Raise credit
  correctly becomes unavailable once the invoice's OWN kind is CREDIT (structural, not a
  permission gate) and once status drops back to DRAFT.
- `key={id}` page-shell idiom copied with its comment, matching `shipping/[id]/page.tsx` exactly.
- `useEditGuard`/`useMutationGate` used exactly as `ShipmentDetail.tsx` uses them; no server import
  in either client file (`grep '@/server'` returns nothing in `InvoiceDetail.tsx` or
  `InvoicesSection.tsx`).
- The one deliberate UI-only decision (amount-edit stamps `MANUAL`/`needsPrice:false`) is disclosed
  above, not silently invented.

## Concerns

- **The Documents section and Print button both call routes Task 19 has not built yet**
  (`GET/POST /api/invoices/[id]/documents` and `.../print`). This is explicitly licensed by the
  brief ("wire the button but expect its endpoint to 404 until Task 19") and was extended to the
  Documents list by the same reasoning (no route exists to list invoice documents until Task 19
  widens `documents.ts`). Verified live: both fail cleanly with an honest "Request failed (404)" /
  `Print failed (404)` message, never a silent empty state or a crash. No action needed from Task
  18; flagging for Task 19's implementer so the shape is expected, not a surprise.
- The line grid's "Add charge line" always appends at the END of the composed array (added rows
  land after existing ones, per `useBulkGrid`'s own `compose` contract), which can place a manually
  added CHARGE line after a TAX line in stored `position` order — spec §5.3's canonical ordering
  (SURCHARGE, FREIGHT, CHARGE, CERT, TAX) is what `createInvoice`/`recalculateInvoice` produce, but
  `replaceInvoiceLines` accepts caller order as-is (no server-side re-sort). This only affects
  MANUALLY added lines on a manually-edited draft, not the create/recalculate paths, and does not
  violate any spec rule (the route's own contract is "trust the caller's order") — noted here as a
  minor, disclosed judgment call rather than silently shipped.
- I did not add automated coverage beyond what the brief specifies (browser verification only) —
  consistent with "No vitest seam" in the task instructions.

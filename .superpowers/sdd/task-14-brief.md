### Task 14: Shipment page — header, per-order panels, three grids each

**Files:**
- Create: `src/app/shipping/[id]/page.tsx`, `src/app/shipping/[id]/ShipmentDetail.tsx`, `src/app/shipping/[id]/ShipmentOrderPanel.tsx`
- Test: exercised by Task 20's E2E; service coverage already exists

- [ ] **Step 1: Build the header** — customer, ship-to selector (that customer's live `SHIP_TO` addresses), ship date, carrier, route, comments, and the freight block (bill/amount, terms, class, description, package count prefilled from the container sum, pro no, SCAC). The customer's standing `shippingNotes` render as a read-only banner.
- [ ] **Step 2: Build one panel per `ShipperOrderDetail`**, headed with its `label` (`72036-3`), each carrying three grids built on `useBulkGrid` from `src/lib/bulk-grid.ts`: lines (ordered / shipped-to-date / ship-now qty and lbs / ship-line-complete, prefilled to the remainder), containers, serials. **Sibling-split rule: this phase's three grids per panel are the largest sibling group in the codebase — any fix to one lands on all three in the same commit.**
- [ ] **Step 3: Add the actions** — Add order (a picker of that customer's orders with unshipped lines), Remove order, Print (all tickets / this order's ticket / BOL / the cert checkbox pre-ticked), the stored-documents list, `HistoryPanel entity="shipper"`, and Void with a reason prompt.
- [ ] **Step 4: Render the state banners** — the credit-hold refusal (with the link to the customer), the §5.7 warnings, and a voided read-only banner naming the reason.
- [ ] **Step 5: Remount per id** — `<ShipmentDetail key={id} …>`; any `defaultValue`-bound field otherwise keeps the previous record's text (HANDOFF §5.12, a Critical in 2B).
- [ ] **Step 6: Verify in the browser** — build a two-order shipment, edit a line, watch the order's status change on the board. Screenshots for the demo doc.
- [ ] **Step 7: Gates + commit** — `feat(ui): shipment page with per-order ticket panels`

---


### Task 17: Order hub sections and the new order-entry fields

**Files:**
- Modify: `src/app/orders/[id]/*` (hub sections), `src/app/orders/new/*` (entry), `src/app/parts/[id]/*`, `src/app/customers/[id]/*`

- [ ] **Step 1: Add the hub's Certifications section** — lists `certsForOrder`, and for `LOAD` scope shows the explicit gap ("by load · 4 loads · 0 certs") with a create action per load, plus **a warning row for any cert whose `loadNumber` no longer exists** after a re-split (§4.1). Order- and shipment-scope certs are listed, never created here.
- [ ] **Step 2: Add the hub's Shipments section** — `shipmentsForOrder`, each row linking to the shipment and showing its label (`72036-3`), ship date, quantities and complete flags.
- [ ] **Step 3: Add the Overview fields** — `certRequired`, `certScope` (both editable, showing what resolved), and `customerJobNo`.
- [ ] **Step 4: Add the order-entry fields** — the resolved cert-required/scope preview with an override, `customerJobNo`, and the containers grid's new `Cust Cont Id` column. The entry page keeps **only what the user typed** and re-derives until they type over it (the 2C-3 draft lesson).
- [ ] **Step 5: Add the part and customer fields** — `certRequired`/`certScope` on the part (three-state: yes / no / inherit, showing what it inherits), `certRequiredDefault`/`certScopeDefault` on the customer. **Sibling-pair habit: both pages in the same commit.**
- [ ] **Step 6: Verify in the browser** — key an order for a cert-required part, see the cert appear on the hub. Screenshots.
- [ ] **Step 7: Gates + commit** — `feat(ui): order hub certification and shipment sections, cert fields throughout`

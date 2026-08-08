### Task 18: `/invoicing/[id]` — the invoice page, and the order hub's Invoices section

**Files:**
- Create: `src/app/invoicing/[id]/page.tsx`, `src/app/invoicing/[id]/InvoiceDetail.tsx`, `src/app/orders/[id]/InvoicesSection.tsx`
- Modify: `src/app/orders/[id]/page.tsx`
- Test: browser verification

**Interfaces:**
- Consumes: the Task 16 routes; `useBulkGrid` (`src/lib/bulk-grid.ts:116`), `useLatest` / `useMutationGate`, `useEditGuard`, `gate` / `gateDo`, `HistoryPanel`, the Task 1 label maps.
- Produces: nothing other tasks consume.

- [ ] **Step 1: The page shell** — `page.tsx` is a bare `<InvoiceDetail key={id} id={id} />`, the `src/app/shipping/[id]/page.tsx` idiom **including its comment**: Next reuses the component instance across `/invoicing/A → /invoicing/B`, and without the key a `defaultValue`-bound field carries one invoice's unsaved text onto another (HANDOFF §5.12 — a Critical in Phase 2B).
- [ ] **Step 2: The body**, on `ShipmentDetail.tsx`'s state model exactly:
  - header (customer, order link, PO, terms, invoice date, status badge, document number) with **optimistic PATCH and rollback-then-report** (§5.13 — reload *first*, then set the error);
  - **one monotonic mutation ticket** shared by every write and by `load` itself, so overlapping calls resolve to the newest (`useMutationGate`);
  - `useEditGuard` on the header, so an arriving detail never resets the field under the cursor — the notes-clobber trio's fix, and this is a fourth member of that sibling group;
  - the **PART/OPERATION grid** and the **charges/surcharge/freight/cert/tax lines**, editable through `useBulkGrid` and saved by the whole-array PUT;
  - totals; actions **Recalculate**, **Finalize**, **Unlock** (prompting for the reason), **Print**, **Raise credit**, **Discard** (prompting for the reason);
  - the Documents list and `HistoryPanel`.
- [ ] **Step 3: Lock the UI to the status.** A finalized invoice renders every editing control disabled with the title `"Invoice is finalized"` — the `voidLocked` helper's shape (`ShipmentDetail.tsx:110-127`), which a discarded draft reuses with `"Invoice is discarded"`. Money-bearing controls take the **double gate** (`invoicing.edit` **and** `change_prices`) computed once, with the same "whichever is actually the blocker" title rule the parts Pricing section uses.
- [ ] **Step 4: The order hub's Invoices section** — spec §6 lists invoices as a hub section. Rows link to `/invoicing/<id>`; when the order is `SHIPPED` with no live invoice, a **Create invoice** button gated on `invoicing.create`. Register it in `src/app/orders/[id]/page.tsx` beside the Shipments and Certifications sections.
- [ ] **Step 5: Verify in a real browser** per HANDOFF §5a — create, edit a line, recalculate, finalize (controls lock), unlock with a reason (controls unlock, order returns to Shipped), raise a credit, and confirm the hub section links both ways. Clear the DEV-database fixtures afterwards.
- [ ] **Step 6: Gates + commit** — `feat(invoicing): invoice page and the order hub's Invoices section`

---


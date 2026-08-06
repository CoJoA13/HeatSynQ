### Task 20: E2E flows, demo walkthrough, and docs

**Files:**
- Create: `e2e/ship-partial-then-complete.spec.ts`, `e2e/multi-order-shipment.spec.ts`, `e2e/cert-results-print.spec.ts`, `e2e/void-shipment.spec.ts`, `e2e/credit-hold-block-and-override.spec.ts`, `docs/<date>-phase-4-demo.md`
- Modify: `docs/HANDOFF.md` (§4a, §6, §7, §9), `CLAUDE.md`

- [ ] **Step 1: Write the five flows** per §13. Fixtures follow HANDOFF §5a: exact-key, scoped to the fixture customer, localhost-gated, cleaned from the **dev** database (`erp`, not `erp_test`) afterwards.
- [ ] **Step 2: Avoid the Phase 3 URL trap** — never `page.waitForURL(/\/shipping\/[^/?]+$/)`; it matches the literal `/shipping/new` route that is still on screen. Wait for content that can only exist after navigation (the packing-list number badge).
- [ ] **Step 3: Run the whole harness three times consecutively** — `npm run test:e2e` — to confirm stability, as Phase 3 did. Expected: 15/15 each time.
- [ ] **Step 4: Write the demo walkthrough** with screenshots at every named checkpoint (the 2C-2 / 2C-3 / Phase 3 precedent), including the three deviations a reader will notice: pass/fail shows on screen and not on paper; `cert_number_next` sits in Settings unused; and `Cust Cont Id` / `Customer Job No` are built but unused by this shop (§3.22).
- [ ] **Step 5: Update `docs/HANDOFF.md`** — §4a gains the Phase 4 record (tasks, gates, test count, review rounds); §6 gains anything triaged rather than fixed; **§7 item 1 is struck — the samples arrived**; §9's kickoff prompt is rewritten for Phase 5 (Invoicing & A/R + QBO) quoting the spec's §16 inheritance list.
- [ ] **Step 6: Update `CLAUDE.md`** — the sorted-claim rule for multi-order writes, the `StoredDocument` kind/owner `CHECK`, and the "certs have no unique column, `Cert` adds no sweep exemption" note.
- [ ] **Step 7: Full gates** — `/gates` including `npm run build` and the E2E suite. Expected: all green, tests well past 1010.
- [ ] **Step 8: Commit** — `docs: Phase 4 demo walkthrough and handoff update`

---


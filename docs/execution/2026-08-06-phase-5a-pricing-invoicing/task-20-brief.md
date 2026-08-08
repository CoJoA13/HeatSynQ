### Task 20: E2E flow, demo walkthrough, and docs

**Files:**
- Create: `e2e/flows/invoice-shipped-order.mjs`, `docs/<date>-phase-5a-demo.md`
- Modify: `e2e/run.mjs`, `e2e/lib/db-fixtures.ts`, `docs/HANDOFF.md`, `CLAUDE.md`
- Test: `npm run test:e2e`

**Interfaces:**
- Consumes: `createOrderViaUi` / `startNewShipment` / `orderPanel` / `waitForShipmentPage` (`e2e/lib/orders.mjs`), `waitForValue` / `fillReliable` / `armPrompt` (`e2e/lib/ui.mjs`).
- Produces: a 16th registered flow.

- [ ] **Step 1: Extend the fixtures** — `e2e/lib/db-fixtures.ts` gains an invoicing customer and a part carrying **two** `PartPrice` rows (so the flow exercises the multi-operation case ruling 3 exists for), a GL account on each step code, one active surcharge, and a `BillingConfig` with a tax rate. Follow the file's existing exact-key teardown; the reaper is localhost-gated and scoped to the fixture customer — **do not widen it**.
- [ ] **Step 2: Write `e2e/flows/invoice-shipped-order.mjs`** with the header comment naming what it pins, the way every existing flow does. The path: key an order against the two-operation part → ship it with both lines marked complete → the board shows **Shipped** → `/invoicing` shows it under *Ready to invoice* → tick and create → the invoice page shows **two** priced operation rows, the surcharge and the tax → **Finalize** → controls lock and the board shows **Invoiced** → **Print** → the document appears in the Documents list → **Unlock** with a reason → controls unlock and the board shows **Shipped** again.
- [ ] **Step 3: Avoid the `/new`-route URL trap** — it has now armed twice (`/orders/new` in Phase 3, `/shipping/new` in Phase 4). This flow's own navigation is `/invoicing → /invoicing/<id>`, so wait for **post-navigation-only content** (the document-number badge), never `page.waitForURL(/\/invoicing\/[^/?]+$/)`.
- [ ] **Step 4: Register it in `e2e/run.mjs`** as the 16th entry, `as: "admin"`, last in `FLOWS` — it creates its own order and leaves nothing later flows depend on. Update the file's header comment (it says "fifteen owner-reviewable flows").
- [ ] **Step 5: Run the suite three times consecutively** — `npm run test:e2e` — to confirm stability, the standing practice since 2C-3.
- [ ] **Step 6: Write the demo walkthrough** `docs/<date>-phase-5a-demo.md` with screenshots, on `docs/2026-08-05-phase-4-demo.md`'s shape: the pricing setup, the worklist, the invoice, the printed PDF against the owner's sample side by side, and the unlock path. **Name every deviation from the sample** rather than letting the owner find them.
- [ ] **Step 7: Update the docs as part of the work** (standing owner rule):
  - **`CLAUDE.md`** — a paragraph on the invoice being frozen paper (snapshot read **unconditionally**, the opposite of the shipment grids), the `invoice-guards.ts` leaf and why it exists, `BillingConfig` as a singleton with a CHECK, and the new sweep exemptions.
  - **`docs/HANDOFF.md`** — a new §4a for 5A (what it delivered, the rulings, the lessons), §6 gaining anything deferred, and **§9 rewritten as the 5B kickoff prompt** carrying spec §16's inheritance list verbatim.
- [ ] **Step 8: Full gates + the E2E suite, then commit** — `feat: invoicing E2E flow, demo walkthrough and docs`

---

## Review and merge

Per the process that has held for four phases: **a fresh subagent per task → the repo's own `task-reviewer` agent on each task's diff → fix rounds until approved → re-review**. Then, on the whole branch:

1. **One whole-branch review on the strongest model** over `main..HEAD` of `phase-5a-pricing-invoicing`, fed the per-task deferred-minors lists from `docs/execution/2026-08-06-phase-5a-pricing-invoicing/progress.md` as triage input.
2. **One fix wave** from that review, with scoped re-review of the fixes.
3. **The owner demo** (`docs/<date>-phase-5a-demo.md`) before the merge.
4. **Open the PR** — attribution and the Claude-Session link in the **PR body**, never a commit trailer (a hook blocks them).
5. **The owner-ratified stopping rule applies from review round 6**: after that round's fixes, further findings become issues unless they are correctness, concurrency, or data-integrity defects.
6. After the squash-merge: verify the squashed tree is byte-identical to the branch tip, all gates plus `npm run test:e2e` green on `main`, both databases migrated — then kick off **5B (Accounts Receivable)** with the §9 prompt.

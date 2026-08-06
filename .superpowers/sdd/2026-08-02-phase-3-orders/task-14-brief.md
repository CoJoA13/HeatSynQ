### Task 14: Order hub UI

**Files:**
- Create: `src/app/orders/[id]/page.tsx`
- Modify: `src/components/Shell.tsx` only if the hub needs a nav affordance (it should not — reached from board/search)

**Behavior contract (remounts per id — `key={id}`):**
- Sections per §11: Overview (scalars editable per Task 5 PATCH; Void button `gateDo("void_order")` with reason prompt; linked-orders panel with Link/Unlink); Lines (lead badge "Lead · Rev N locked"; rider add/remove/edit gated `orders.edit`; lead qty/weight editable, part never); Process (read-only render via the part's existing revision API `GET /api/parts/[partId]/process/revisions/[n]` — the 2C-3 routes; no new endpoint); Containers/Serials/Charges (bulk-edit grids PUTting the Task 5 endpoints); Loads (grid + Re-split button + both warnings rendered as amber banners); Notes; Attachments (`AttachmentsSection owner="order"`); Documents (list from Task 16's route — placeholder "No documents yet" section until Task 16 fills it); History (`HistoryPanel entity="order" entityId={id}`).
- Voided: red banner "Voided — {reason from latest audit entry}", every control read-only/disabled.
- Warnings from any mutation response render in the amber banner; errors in the red one; **rollback-before-report** on failed saves (§5.13: reload server truth first, then show why).

- [ ] **Step 1: Build the page.**  **Step 2: Manual smoke: edit scalars, riders, loads; void a scratch order; verify §5.16 tooltips with a restricted user.**  **Step 3: Gates.**
- [ ] **Step 4: Commit** — `feat: order hub page`


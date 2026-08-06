// Flow 14 (Phase 4, Task 20): void a shipment (design spec §13.4, §5.6). Ships an order complete
// (status -> SHIPPED), prints its ticket, then voids the shipment with a required reason and
// proves the §5.6 contract in the browser: EVERY control on the page locks (disabled or
// readOnly, swept programmatically across every input/select/textarea/button — the Task 14
// browser-verification recapture), the order's status RETURNS to Open, the stored PDF stays
// listed and re-downloadable forever, and a NEW shipment for the same order gets sequence 2 —
// the voided shipment's sequence 1 is never reused, and its ledger contribution is gone (the
// new prefill is back to the full ordered quantity).
import assert from "node:assert/strict";
import { armPrompt, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const REASON = "E2E void-shipment flow: intentional test void, demonstrating the void UX for the demo.";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Order + complete shipment. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 30 }],
  });
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "30");
  await panel.getByLabel("Line 1 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);

  // --- Print the ticket so a stored document exists to survive the void. The cert checkbox is
  // unticked first: this order's part requires no cert, and the flow is about the void, not the
  // cert pipeline (multi-order-shipment covers that). ---
  await page.getByLabel("Also print certifications").uncheck();
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print all tickets", exact: true }).click();
  const ticketLink = page.getByRole("link", { name: "Shipping ticket", exact: true }).first();
  await ticketLink.waitFor({ state: "visible", timeout: 30000 });
  await (await popup)?.close().catch(() => {});
  const ticketHref = await ticketLink.getAttribute("href");
  await shot("shipped-and-printed");

  // --- The order is SHIPPED (its one line is complete). ---
  await page.goto(`${ctx.baseURL}/orders/${order.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  await page.getByText("· Shipped", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await shot("order-shipped-before-void");

  // --- Void, reason required (the prompt says exactly what voiding means). ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  const dialogMessage = armPrompt(page, REASON);
  await page.getByRole("button", { name: "Void shipment", exact: true }).click();
  const message = await dialogMessage;
  assert.match(message, new RegExp(`Void shipment \\(Packing List ${shipment.shipperNumber}\\)\\?`));
  assert.match(message, /Reason for voiding \(recorded in the audit history\):/);
  await page.getByText(`Voided — ${REASON}`).waitFor({ state: "visible", timeout: 10000 });

  // --- §5.6 in the browser: EVERY control locks. Swept programmatically rather than
  // spot-checked — each control type locks its own way (disabled on selects/dates/checkboxes/
  // buttons, readOnly on text inputs and textareas), so the sweep accepts either and fails
  // loudly on any control satisfying neither. (The Task 14 recapture: "looks disabled" and
  // "cannot be edited" are different claims; this checks the DOM properties, not the styling.) ---
  const unlocked = await page.$$eval("main input, main select, main textarea, main button", (els) =>
    els
      .filter((el) => !(el.disabled === true || el.readOnly === true))
      .map((el) => `${el.tagName.toLowerCase()}[label=${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}]`));
  assert.deepEqual(unlocked, [], `voided shipment must lock every control; still unlocked: ${unlocked.join(", ")}`);
  // And the two §5.16 titles name the real reason rather than a generic "disabled".
  assert.equal(
    await page.getByRole("button", { name: "Print all tickets", exact: true }).getAttribute("title"),
    "Shipment is voided — stored prints stay available");
  assert.equal(
    await page.getByRole("button", { name: "Void shipment", exact: true }).getAttribute("title"),
    "Already voided");
  await shot("voided-every-control-locked");

  // --- The stored ticket is still listed and still re-downloadable, forever (§5.6). ---
  await page.getByRole("link", { name: "Shipping ticket", exact: true }).first().waitFor({ state: "visible" });
  const pdf = await (await page.request.get(new URL(ticketHref, ctx.baseURL).toString())).body();
  assert.ok(pdf.subarray(0, 5).toString() === "%PDF-", "the stored ticket must stay downloadable after the void");

  // --- The order's status RETURNS (§5.6: a void restores the previous derivation — the voided
  // shipment's complete flag no longer counts). ---
  await page.goto(`${ctx.baseURL}/orders/${order.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  await page.getByText("· Open", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await shot("order-status-returned");

  // --- A new shipment gets the NEXT sequence, not the freed one (§4.2: the sequence counts
  // voided shipments), and the voided shipment contributes NOTHING to the ledger — the prefill
  // is back to the full ordered 30. ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel2 = orderPanel(page, `#${order.number}`);
  await waitForValue(panel2.getByLabel("Line 1 ship-now quantity", { exact: true }), "30");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment2 = await waitForShipmentPage(page);
  assert.ok(shipment2.shipperNumber > shipment.shipperNumber, "the packing-list number is never reused");
  await page.getByRole("link", { name: `${order.number}-2`, exact: true }).waitFor({ state: "visible" });
  await shot("new-shipment-sequence-2");
}

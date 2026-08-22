// Flow 11 (Phase 4, Task 20): the ship ledger end to end (design spec §13.1). Keys a two-line
// order, ships part of it from /shipping/new (the Task 14b create page), watches the board flip
// to "Partially shipped", then ships the rest with both lines marked complete — deliberately
// over-shipping one line by 10 on the way, so the §5.7 save-with-warnings panel fires (warns,
// never blocks) — and watches the board flip to "Shipped". Status derivation reads ONLY the
// human line-complete flags, never quantity arithmetic (spec §5.2): the first save ships real
// quantity and completes nothing, the second completes both lines.
//
// Also carries the Cust Cont Id round-trip pin (Task 17's data-loss fix, adjudication B: the hub
// containers grid's whole-array replace silently blanked stored customerContainerId on every
// save until the grid composed the column — no vitest seam exists client-side, so THIS is the
// regression proof): a container is saved with a Cust Cont Id, then a second save touches ONLY
// its count, and after a full reload the stored id must still be there.
import assert from "node:assert/strict";
import { waitForValue } from "../lib/ui.mjs";
import { boardRow, createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

async function assertBoardStatus(page, ctx, orderNumber, statusText, absentText) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  // #167a: the ORDER-NUMBER CELL, never "any cell holding these digits" — and this flow's own
  // order is the one whose Weight cell collided (e2e/lib/orders.mjs's `boardRow`).
  const row = await boardRow(page, orderNumber);
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.getByText(statusText, { exact: true }).waitFor({ state: "visible" });
  if (absentText) {
    await assert.rejects(
      row.getByText(absentText, { exact: true }).waitFor({ state: "visible", timeout: 500 }),
      `board row for #${orderNumber} should show "${statusText}", not "${absentText}"`,
    );
  }
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- The order: two lines, 100 of part A (1000 lbs) and 40 of part B (200 lbs). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [
      { partNumber: fixtures.shipPartANumber, qty: 100 },
      { partNumber: fixtures.shipPartBNumber, qty: 40 },
    ],
  });
  await shot("order-created");

  // --- Cust Cont Id round-trip (the Task 17 pin) on the hub's containers grid. ---
  await page.getByRole("button", { name: "Add container", exact: true }).click();
  await page.getByLabel("Container 1 type", { exact: true }).selectOption(fixtures.containerTypeId);
  await page.getByLabel("Container 1 count", { exact: true }).fill("4");
  await page.getByLabel("Container 1 customer container id", { exact: true }).fill("BIN-0007");
  let saved = page.waitForResponse((res) =>
    res.url().includes(`/api/orders/${order.id}/containers`) && res.request().method() === "PUT" && res.ok());
  await page.getByRole("button", { name: "Save containers", exact: true }).click();
  await saved;
  // Second save touches ONLY the count — the exact shape that used to blank the stored id.
  await page.getByLabel("Container 1 count", { exact: true }).fill("5");
  saved = page.waitForResponse((res) =>
    res.url().includes(`/api/orders/${order.id}/containers`) && res.request().method() === "PUT" && res.ok());
  await page.getByRole("button", { name: "Save containers", exact: true }).click();
  await saved;
  await page.reload();
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "5");
  await waitForValue(page.getByLabel("Container 1 customer container id", { exact: true }), "BIN-0007");
  await shot("cust-cont-id-preserved");

  // --- Shipment 1: partial. Prefill is the FULL remainder (nothing shipped yet); ship 60 of
  // line 1 and none of line 2, completing nothing. ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel1 = orderPanel(page, `#${order.number}`);
  await waitForValue(panel1.getByLabel("Line 1 ship-now quantity", { exact: true }), "100");
  await waitForValue(panel1.getByLabel("Line 2 ship-now quantity", { exact: true }), "40");
  await panel1.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("60");
  await panel1.getByLabel("Line 1 ship-now weight", { exact: true }).fill("600");
  await panel1.getByLabel("Line 2 ship-now quantity", { exact: true }).fill("0");
  await panel1.getByLabel("Line 2 ship-now weight", { exact: true }).fill("0");
  await shot("new-shipment-partial");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  // No warnings on this save, so the page navigates straight to the shipment. NEVER
  // waitForURL(/\/shipping\/[^/?]+$/) here — that also matches the literal /shipping/new still on
  // screen (the Phase 3 trap, spec §13); waitForShipmentPage waits for the packing-list badge.
  const shipment1 = await waitForShipmentPage(page);
  await page.getByRole("link", { name: `${order.number}-1`, exact: true }).waitFor({ state: "visible" });
  await shot("shipment-1-saved");

  await assertBoardStatus(page, ctx, order.number, "· Partially shipped");
  await shot("board-partially-shipped");

  // --- Shipment 2: the rest, both lines complete. The prefill must equal the REMAINDER (design
  // §5.1: ordered − shipped, a default never a cap) — line 1 was 100 ordered / 60 shipped. Then
  // ship 50 anyway: over-shipping WARNS and still saves (§5.7). ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel2 = orderPanel(page, `#${order.number}`);
  await waitForValue(panel2.getByLabel("Line 1 ship-now quantity", { exact: true }), "40");
  await waitForValue(panel2.getByLabel("Line 1 ship-now weight", { exact: true }), "400");
  await waitForValue(panel2.getByLabel("Line 2 ship-now quantity", { exact: true }), "40");
  await panel2.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("50");
  await panel2.getByLabel("Line 1 complete", { exact: true }).check();
  await panel2.getByLabel("Line 2 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();

  // §5.7 rendered in a real browser: the save SUCCEEDED ("Packing List N saved.") and the
  // over-ship warning is listed on the amber panel rather than raced past by a navigate.
  await page.getByText(/^Packing List \d+ saved\.$/).waitFor({ state: "visible", timeout: 20000 });
  await page.getByText(/exceeds the remaining/).waitFor({ state: "visible" });
  await shot("save-warnings-overship");
  await page.getByRole("button", { name: "Go to shipment", exact: true }).click();
  const shipment2 = await waitForShipmentPage(page);
  assert.notEqual(shipment2.id, shipment1.id, "the second save must create a SECOND shipment");
  assert.ok(shipment2.shipperNumber > shipment1.shipperNumber,
    "packing-list numbers must be allocated in sequence");
  await page.getByRole("link", { name: `${order.number}-2`, exact: true }).waitFor({ state: "visible" });
  await shot("shipment-2-saved");

  // Both lines complete -> SHIPPED, regardless of the over-shipped quantity (spec §5.2:
  // quantities never influence status).
  await assertBoardStatus(page, ctx, order.number, "· Shipped", "· Partially shipped");
  await shot("board-shipped");
}

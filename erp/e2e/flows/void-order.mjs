// Flow 10 (last): void the order order-entry-full created, with a reason, and confirm the board
// hides it until "Include voided" is checked (design spec §5c — voided orders block nothing,
// never free their number, and leave the board unless the toggle is on). Runs last of the four
// order flows on purpose: board-search-scan needs the order live to find it, and once this flow
// voids it there is nothing left for a later flow to build on.
import assert from "node:assert/strict";
import { armPrompt } from "../lib/ui.mjs";

const REASON = "E2E void-order flow: intentional test void, demonstrating the void UX for the demo.";

export async function run(page, shot, ctx) {
  const { created } = ctx;
  if (!created.orderId || !created.orderNumber) {
    throw new Error("void-order requires order-entry-full to have set ctx.created.orderId/orderNumber");
  }

  await page.goto(`${ctx.baseURL}/orders/${created.orderId}`);
  await page.getByRole("heading", { name: `Order #${created.orderNumber}` }).waitFor({ state: "visible" });
  await shot("hub-before-void");

  const dialogMessage = armPrompt(page, REASON);
  await page.getByRole("button", { name: "Void order" }).click();
  const message = await dialogMessage;
  assert.match(message, new RegExp(`Void order #${created.orderNumber}\\?`));
  assert.match(message, /Reason for voiding \(recorded in the audit history\):/);

  await page.getByText(`Voided — ${REASON}`).waitFor({ state: "visible", timeout: 10000 });
  await shot("hub-voided");

  // Board: a voided order leaves the list by default (spec §5c).
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  await assert.rejects(
    page.locator("tr", { hasText: String(created.orderNumber) }).waitFor({ state: "visible", timeout: 1500 }),
    "a voided order should not appear on the board while Include voided is off",
  );
  await shot("board-hides-voided");

  await page.getByRole("checkbox", { name: "Include voided" }).check();
  const row = page.locator("tr", { hasText: String(created.orderNumber) });
  await row.waitFor({ state: "visible", timeout: 10000 });
  // A voided row renders the plain word "Voided" in place of the colored light dot + status —
  // board-search-scan already confirmed the dot for this SAME order while it was still live.
  await assert.rejects(
    row.locator("span.rounded-full").waitFor({ state: "visible", timeout: 1000 }),
    "a voided row should show no colored light",
  );
  await row.getByText("Voided", { exact: true }).waitFor({ state: "visible" });
  await shot("board-shows-with-include-voided");
}

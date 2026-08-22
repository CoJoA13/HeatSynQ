// Flow 8: the order board shows the order order-entry-full just created, with its traffic light
// (design spec §6/§11), and the Shell's global search resolves an exact order number straight to
// its hub — the barcode-scan path a traveler's printed Code 128 exists to feed (task-12-brief.md;
// Shell.tsx's `onSearchKeyDown`). Runs between order-entry-full and loads-after-print (the order
// is live and unvoided either way — this flow doesn't care about print state) and before
// void-order, which needs the order still live to void it.
import assert from "node:assert/strict";
import { boardRow } from "../lib/orders.mjs";

export async function run(page, shot, ctx) {
  const { created } = ctx;
  if (!created.orderId || !created.orderNumber) {
    throw new Error(
      "board-search-scan requires order-entry-full to have run first and set ctx.created.orderId/orderNumber",
    );
  }

  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });

  // #167a: was `page.locator("tr", { hasText: ... })` — a SUBSTRING match against every cell of
  // every row, the loosest member of the family that collision belongs to. `boardRow` matches the
  // order-number cell exactly (e2e/lib/orders.mjs).
  const row = await boardRow(page, created.orderNumber);
  await row.waitFor({ state: "visible", timeout: 10000 });
  // The light is a colored dot (rounded-full) beside the status word — rendered only for a live
  // order (a voided one renders the plain word "Voided" instead, no dot at all; asserted by
  // void-order's own flow, which runs after this one).
  await row.locator("span.rounded-full").waitFor({ state: "visible" });
  await shot("board-order-with-light");

  // Global search — Shell.tsx's placeholder is distinct from the board's OWN inline search box
  // (HANDOFF §5a: the shell has a global search box so placeholder selectors can collide) —
  // "Search orders, parts, customers…" vs. the board filter's "Order #, PO, VS #, lead part,
  // customer", so this is unambiguous.
  const searchBox = page.getByPlaceholder("Search orders, parts, customers", { exact: false });
  await searchBox.click();
  await searchBox.fill(String(created.orderNumber));
  await searchBox.press("Enter");
  await page.waitForURL(new RegExp(`/orders/${created.orderId}$`), { timeout: 10000 });
  await page.getByRole("heading", { name: `Order #${created.orderNumber}` }).waitFor({ state: "visible" });
  assert.equal(page.url().split("/").pop(), created.orderId, "search should land on the SAME order the flow created");
  await shot("search-landed-on-hub");
}

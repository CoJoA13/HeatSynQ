import { test, expect } from "@playwright/test";

test("shop floor shows a running furnace and drills into its order", async ({ page }) => {
  await page.goto("/shop-floor");

  // Seed: WO-48211 (Apex) step 2 "Wash & rack" is in_process → Wash Station is Running.
  const tile = page.getByTestId("equipment-tile-eq-wash-1");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("WO-48211")).toBeVisible();

  await tile.click();

  await expect(page).toHaveURL(/\/orders\/wo-48211$/);
  await expect(page.getByTestId("order-progress")).toBeVisible();
});

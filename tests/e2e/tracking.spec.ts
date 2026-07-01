import { test, expect } from "@playwright/test";

test("a card advances across Tracking board columns via a quick track-out", async ({ page }) => {
  await page.goto("/tracking");

  // Seed: WO-48211 (Apex) has step 1 done, step 2 (Wash & rack) in_process → sits in the Rack column.
  const rackCol = page.getByTestId("area-col-rack");
  const card = rackCol.getByTestId("board-card-WO-48211");
  await expect(card).toBeVisible();

  // Track out the active step (Wash & rack) → its next step (Carburize) is in the In Process area.
  await card.getByRole("button", { name: "Track Out" }).click();

  // The card leaves Rack and appears in the In Process column.
  await expect(page.getByTestId("area-col-in_process").getByTestId("board-card-WO-48211")).toBeVisible();
  await expect(rackCol.getByTestId("board-card-WO-48211")).toHaveCount(0);
});

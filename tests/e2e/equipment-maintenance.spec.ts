import { test, expect } from "@playwright/test";

test("SAT completed on a maintenance furnace, then returned to service", async ({ page }) => {
  await page.goto("/shop-floor");

  // Seed: eq-vac-1 is in maintenance with its SAT due today (DEMO_NOW boundary).
  await expect(page.getByTestId("shopfloor-summary")).toContainText("Pyrometry due");
  const tile = page.getByTestId("equipment-tile-eq-vac-1");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("Maintenance")).toBeVisible();

  await tile.click();
  await expect(page).toHaveURL(/\/shop-floor\/eq-vac-1$/);
  await expect(page.getByTestId("equipment-state-pill")).toHaveText("Maintenance");
  await expect(page.getByTestId("pyro-due-mnt-vac-1-sat")).toBeVisible();

  // Mark the SAT complete — the due pill clears (nextDueAt rolls +30d past DEMO_NOW).
  await page.getByTestId("pyro-complete-mnt-vac-1-sat").click();
  await page.getByRole("button", { name: "Confirm complete" }).click();
  await expect(page.getByTestId("pyro-due-mnt-vac-1-sat")).toHaveCount(0);

  // Return the furnace to service.
  await page.getByRole("button", { name: "Return to service" }).click();
  await page.getByRole("button", { name: "Confirm return" }).click();
  await expect(page.getByTestId("equipment-state-pill")).toHaveText("Idle");
});

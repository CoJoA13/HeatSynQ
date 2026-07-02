import { test, expect } from "@playwright/test";

test("reports catalog drills into derived reports", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  for (const key of ["sales", "ar", "production", "quotes"]) {
    await expect(page.getByTestId(`report-group-${key}`)).toBeVisible();
  }
  await expect(page.locator('[data-testid^="report-link-"]')).toHaveCount(16);

  await page.getByTestId("report-link-ar-aging").click();
  await expect(page).toHaveURL(/\/reports\/ar-aging$/);
  await expect(page.getByText("As of Jun 30, 2026")).toBeVisible();
  await expect(page.getByTestId("report-kpis")).toContainText("$6,740");
  await expect(page.getByTestId("report-table")).toContainText("INV-30412");

  await page.goto("/reports");
  await page.getByTestId("report-link-win-loss").click();
  await expect(page.getByTestId("report-kpis")).toContainText("66.7%");
  await expect(page.getByTestId("report-kpis")).toContainText("$3,740");
  await expect(page.getByTestId("report-table")).toContainText("Q-2838");
});

test("today dashboard renders deterministic Invoiced MTD after clock migration", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByText("Invoiced MTD")).toBeVisible();
  await expect(page.getByText("$19,500")).toBeVisible();
});

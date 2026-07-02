import { test, expect } from "@playwright/test";

test("setup catalog drills into operators and edits a quote limit", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  for (const key of ["operators", "plant", "process-masters", "equipment", "pricing", "cert-defaults"]) {
    await expect(page.getByTestId(`setup-card-${key}`)).toBeVisible();
  }
  // exactly 5 live links; Plant Setup is inert (a div, not an anchor)
  await expect(page.locator('a[data-testid^="setup-card-"]')).toHaveCount(5);

  await page.getByTestId("setup-card-operators").click();
  await expect(page).toHaveURL(/\/setup\/operators$/);
  // Seed: op-dana $100,000 manager / op-vance $25,000 sales / op-office $0 office
  await expect(page.getByText("Dana Mercer")).toBeVisible();
  await expect(page.getByTestId("operator-limit-op-vance")).toHaveText("$25,000");
  await expect(page.getByTestId("permission-row-edit_setup")).toBeVisible();

  // The one write: raise Vance's limit (logged in as op-dana, manager → edit_setup granted)
  await page.getByTestId("edit-limit-op-vance").click();
  await page.getByLabel("Quote limit ($)").fill("30000");
  await page.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByTestId("operator-limit-op-vance")).toHaveText("$30,000");
});

test("pricing card shows the AERO-1 rules", async ({ page }) => {
  await page.goto("/setup");
  await page.getByTestId("setup-card-pricing").click();
  await expect(page).toHaveURL(/\/setup\/pricing$/);
  // Seed: pk-aero1 AERO-1, 4 rules; Temper per lot $1,440 is exact under whole-dollar formatMoney
  await expect(page.getByTestId("price-key-AERO-1")).toContainText("Carburize");
  await expect(page.getByTestId("price-key-AERO-1")).toContainText("$1,440");
  await expect(page.getByTestId("price-key-AERO-1")).toContainText("Used by 1 customer");
});

import { test, expect } from "@playwright/test";

test("standards library renders with the overdue review flagged", async ({ page }) => {
  await page.goto("/standards");
  await expect(page.getByText("AS9100D")).toBeVisible();
  // Exactly one Overdue flag, and it sits in the CQI-9 row
  const cqi9Row = page.getByRole("row").filter({ hasText: "CQI-9" });
  await expect(cqi9Row.getByText("Overdue")).toBeVisible();
  await expect(page.getByText("Overdue")).toHaveCount(1);
});

test("pending cert blocks ship until manual release from the cert detail page", async ({ page }) => {
  // WO-48120 is ready to ship but its cert C-9910 is pending → Ship gated
  await page.goto("/orders/wo-48120");
  await expect(page.getByText("Certification must be released before ship")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeDisabled();

  // Release it from the Quality module: list → row click → detail → Release (manager)
  await page.getByRole("link", { name: "Certifications" }).click();
  await page.getByText("C-9910").click();
  await expect(page.getByText("This cert blocks shipment of WO-48120.")).toBeVisible();
  await page.getByRole("button", { name: "Release" }).click();
  await expect(page.getByText("Released", { exact: true }).first()).toBeVisible();

  // Back on the order via the detail's WO link, the ship gate is cleared
  await page.getByRole("link", { name: "WO-48120" }).click();
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeEnabled();
});

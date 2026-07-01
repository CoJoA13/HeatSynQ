// tests/e2e/smoke.spec.ts
import { test, expect } from "@playwright/test";

test("app boots and shows the shell with the Quotes nav item", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("link", { name: "Quotes" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

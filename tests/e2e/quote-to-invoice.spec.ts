import { test, expect } from "@playwright/test";

test("multi-part quote → send → won → order → release cert → ship → bill → A/R", async ({ page }) => {
  await page.goto("/quotes");
  await page.getByRole("button", { name: "New quote" }).click();

  // Build a 2-part quote for Apex Aerospace (price key AERO-1)
  // Use exact:true to avoid matching the "Customer PO" input as well
  await page.getByLabel("Customer", { exact: true }).selectOption({ label: "Apex Aerospace" });

  // Part 1: TS-4471 with Carburize / Temper lines
  await page.getByRole("button", { name: /add part/i }).click();
  const p0 = page.getByTestId("part-block-0");
  await p0.getByLabel("Part").selectOption({ label: "TS-4471 — Turbine shaft" });
  await p0.getByLabel("Quantity").fill("480");
  await p0.getByRole("button", { name: /add line/i }).click();
  const l0 = p0.getByTestId("line-0");
  await l0.getByLabel("Process").selectOption("Carburize");
  await l0.getByLabel("Basis").selectOption("per_lb");
  await l0.getByLabel("Qty / weight").fill("600");
  await p0.getByRole("button", { name: /add line/i }).click();
  const l1 = p0.getByTestId("line-1");
  await l1.getByLabel("Process").selectOption("Temper");
  await l1.getByLabel("Basis").selectOption("per_lot");
  await l1.getByLabel("Qty / weight").fill("1");

  // Part 2: SP-119 with a Carburize line
  await page.getByRole("button", { name: /add part/i }).click();
  const p1 = page.getByTestId("part-block-1");
  await p1.getByLabel("Part").selectOption({ label: "SP-119 — Spacer ring" });
  await p1.getByLabel("Quantity").fill("120");
  await p1.getByRole("button", { name: /add line/i }).click();
  const l2 = p1.getByTestId("line-0");
  await l2.getByLabel("Process").selectOption("Carburize");
  await l2.getByLabel("Basis").selectOption("per_lb");
  await l2.getByLabel("Qty / weight").fill("150");

  await expect(page.getByTestId("quote-total")).not.toHaveText("$0");

  // Send → lands on the read-only quote view as "Sent" (manager under $100k limit)
  await page.getByRole("button", { name: "Send quote" }).click();
  await expect(page.getByText("Sent")).toBeVisible();

  // Won → auto-creates the work order + pending cert
  await page.getByRole("button", { name: /mark won/i }).click();
  await expect(page.getByText("Won")).toBeVisible();

  // Navigate to Orders via sidebar link, then open the new order WO-48212
  await page.getByRole("link", { name: "Orders" }).click();
  await page.getByText("WO-48212").click();

  // Drive the order: received → Scheduled → In Process → Ready to ship
  // (each click refetches; next transition buttons appear after re-render)
  await page.getByRole("button", { name: "Scheduled" }).click();
  await page.getByRole("button", { name: "In Process" }).click();
  await page.getByRole("button", { name: "Ready to ship" }).click();

  // Now at ready_to_ship: the cert-blocked banner and disabled Ship button are visible
  await expect(
    page.getByText(/certification must be released before ship/i),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeDisabled();

  // Release the pending cert — manager has release_cert permission
  await page.getByRole("button", { name: "Release" }).click();
  await expect(page.getByText("Released")).toBeVisible();

  // Ship → creates the to-bill invoice; order becomes Shipped
  await page.getByRole("button", { name: /^Ship$/ }).click();
  // Use exact match — activity log also emits "Shipped — to-bill invoice"
  await expect(page.getByText("Shipped", { exact: true }).first()).toBeVisible();

  // Navigate to Invoicing; bill the Apex Aerospace invoice (3rd in to-bill list, after seed entries)
  await page.getByRole("link", { name: "Invoicing" }).click();
  // Scope the Bill click to the Apex row so we don't accidentally bill a seed invoice
  const apexRow = page.getByRole("row").filter({ hasText: "Apex Aerospace" });
  await apexRow.getByRole("button", { name: /^Bill$/ }).click();
  // Switch to Sent tab and confirm INV-30413 appeared (confirms mutation completed)
  await page.getByRole("tab", { name: /sent/i }).click();
  await expect(page.getByText("INV-30413").first()).toBeVisible();

  // Navigate to A/R; Apex Aerospace now carries a balance (Net 30, invoiced today)
  await page.getByRole("link", { name: "A/R" }).click();
  await expect(page.getByText("Apex Aerospace")).toBeVisible();
});

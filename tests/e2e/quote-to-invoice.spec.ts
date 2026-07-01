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

  // Drive the traveler. Only the active step exposes its buttons; complete each in order.
  // 1 Receive & verify (track_in) — single Track In completes it
  await page.getByTestId("traveler-step-1").getByRole("button", { name: "Track In" }).click();
  await expect(page.getByTestId("traveler-step-1")).toContainText("Done");
  // 2 Wash & rack (track_in_out)
  await page.getByTestId("traveler-step-2").getByRole("button", { name: "Track In" }).click();
  await expect(page.getByTestId("traveler-step-2")).toContainText("In process");
  await page.getByTestId("traveler-step-2").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-2")).toContainText("Done");
  // 3 Carburize (track_in_out)
  await page.getByTestId("traveler-step-3").getByRole("button", { name: "Track In" }).click();
  await expect(page.getByTestId("traveler-step-3")).toContainText("In process");
  await page.getByTestId("traveler-step-3").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-3")).toContainText("Done");
  // 4 Temper (track_in_out)
  await page.getByTestId("traveler-step-4").getByRole("button", { name: "Track In" }).click();
  await expect(page.getByTestId("traveler-step-4")).toContainText("In process");
  await page.getByTestId("traveler-step-4").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-4")).toContainText("Done");
  // 5 Final inspect (inspect) — Pass auto-releases the cert
  await page.getByTestId("traveler-step-5").getByRole("button", { name: "Pass" }).click();
  await expect(page.getByTestId("traveler-step-5")).toContainText("Done");
  await expect(page.getByText("Released", { exact: true })).toBeVisible();
  // 6 Certify & ship (track_out) — completes → Ready to ship
  await page.getByTestId("traveler-step-6").getByRole("button", { name: "Track Out" }).click();
  await expect(page.getByTestId("traveler-step-6")).toContainText("Done");

  // Now Ready to ship, cert Released, Apex is active → Ship is enabled
  await expect(page.getByRole("button", { name: /^Ship$/ })).toBeEnabled();
  await page.getByRole("button", { name: /^Ship$/ }).click();
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

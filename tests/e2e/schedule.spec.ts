import { test, expect } from "@playwright/test";

test("schedule board shows a planned block and schedules a received order", async ({ page }) => {
  await page.goto("/schedule");

  // Seed: block sb-1 → WO-48230 (Apex, scheduled) on Batch IQ #2, Wed 7/1.
  const seeded = page.getByTestId("schedule-cell-sb-1");
  await expect(seeded).toBeVisible();
  await expect(seeded).toContainText("WO-48230");
  await expect(seeded).toContainText("Scheduled");

  // WO-48231 (received) sits in the Unscheduled queue.
  const queueCard = page.getByTestId("queue-card-WO-48231");
  await expect(queueCard).toBeVisible();

  // Assign it to Batch IQ #1 on Monday.
  await queueCard.getByRole("button", { name: "Assign" }).click();
  await page.getByLabel("Equipment").selectOption("eq-iq-1");
  await page.getByLabel("Day").selectOption({ index: 0 });
  await page.getByRole("button", { name: "Schedule" }).click();

  // It leaves the queue and appears on the board with a Scheduled pill.
  await expect(page.getByTestId("queue-card-WO-48231")).toHaveCount(0);
  const grid = page.getByTestId("grid-cell-eq-iq-1-2026-06-29T00:00:00.000Z");
  await expect(grid).toContainText("WO-48231");
  await expect(grid).toContainText("Scheduled");
});

// Flow: the reports platform (Phase 8A Task 8, spec §4) — the read-only proof that the /reports
// section, its catalog index, a filterable report with the shared Excel export, and the comparison
// scoreboard all render and respond in the real app.
//
// As admin (holds every *.view via ALL_PERMISSIONS, so the index shows all entries): reach /reports
// via the top-level Reports nav entry; confirm the catalog renders (the six native reports + the two
// homed cross-area entries, Invoice register / A/R aging); open the Backlog report, apply a
// received-date filter and confirm the table re-fetches without error; click Export to Excel and
// confirm the xlsx download fires and is non-empty (the export path is shared across every report);
// then open the Comparison scoreboard, confirm its three figures and their basis labels, and confirm
// the This-week / This-month presets update the window.
//
// STRICTLY READ-ONLY — it creates no order/invoice/fixture and mutates no seeded/shared state, so it
// needs no db-fixtures reap entry (there is nothing to clean) and is safe at the FLOWS tail after any
// period/close state earlier flows leave behind (it touches no invoicing/period state). Tolerant of
// empty OR non-empty data: every assertion is on page chrome / controls / labels, never a specific
// row count — the reports render whatever seeded/fixture data happens to exist.
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

// The catalog the /reports index lists for a caller holding every *.view (the admin fixture):
// the six native reports plus the two homed cross-area entries (report-registry.ts).
const REPORT_ENTRIES = [
  "Backlog", "Shipped", "Turnaround", "Sales", "Payments received",
  "Comparison scoreboard", "Invoice register", "A/R aging",
];

export async function run(page, shot, ctx) {
  // --- 1. Reach /reports via the top-level Reports nav entry. ---
  const navReports = page.getByRole("link", { name: "Reports", exact: true });
  await navReports.waitFor({ state: "visible" });
  await navReports.click();
  await page.waitForURL(`${ctx.baseURL}/reports`);
  await page.getByRole("heading", { name: "Reports", exact: true }).waitFor({ state: "visible" });

  // The catalog loads via an async GET /api/reports (compiled on first hit under next dev), so the
  // entries appear AFTER the static heading — wait for the first entry before asserting the rest.
  await page.getByRole("link", { name: "Backlog", exact: true }).waitFor({ state: "visible" });
  for (const label of REPORT_ENTRIES) {
    assert.equal(
      await page.getByRole("link", { name: label, exact: true }).count(), 1,
      `the reports index lists the "${label}" report`,
    );
  }
  await shot("reports-index");

  // --- 2. Open the Backlog report; apply a filter; confirm the table re-fetches without error. ---
  await page.getByRole("link", { name: "Backlog", exact: true }).click();
  await page.waitForURL(`${ctx.baseURL}/reports/backlog`);
  await page.getByRole("heading", { name: "Backlog", exact: true }).waitFor({ state: "visible" });
  // The controls + table render regardless of whether any backlog rows exist (empty-tolerant).
  const exportLink = page.getByRole("link", { name: "Export to Excel", exact: true });
  await exportLink.waitFor({ state: "visible" });
  await page.locator("table").first().waitFor({ state: "visible" });

  // Setting the received-from date changes the ONE shared query string, which re-fetches the table
  // (and re-targets the export link to the same string) — arm the response wait BEFORE the change so
  // we catch it. res.ok() proves the table responded; the exact pathname avoids matching /export.
  const backlogRefetch = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/reports/backlog"
    && res.request().method() === "GET" && res.ok());
  await page.getByLabel("Received from", { exact: true }).fill("2000-01-01");
  await backlogRefetch;
  // No error banner — BacklogReport.tsx's red error box (p.bg-red-50) must not be present.
  assert.equal(
    await page.locator("p.bg-red-50").count(), 0,
    "the backlog table must respond to the filter without an error banner",
  );
  await shot("backlog-filtered");

  // --- 3. Export to Excel — the download fires and the file is non-empty (the shared export path). ---
  const downloadPromise = page.waitForEvent("download");
  await exportLink.click();
  const download = await downloadPromise;
  assert.ok(
    download.suggestedFilename().toLowerCase().endsWith(".xlsx"),
    `the export must download an .xlsx file — got "${download.suggestedFilename()}"`,
  );
  const filePath = await download.path();
  const { size } = await stat(filePath);
  assert.ok(size > 0, "the exported xlsx must be a non-empty file");
  await shot("backlog-exported");

  // --- 4. Comparison scoreboard: three figures + basis labels, then the presets update the window. ---
  // Back to the index by the report's own "← All reports" link (non-exact name to avoid reproducing
  // the arrow glyph), then into the scoreboard — exercising the catalog's linking.
  await page.getByRole("link", { name: "All reports" }).click();
  await page.waitForURL(`${ctx.baseURL}/reports`);
  await page.getByRole("link", { name: "Comparison scoreboard", exact: true }).click();
  await page.waitForURL(`${ctx.baseURL}/reports/scoreboard`);
  await page.getByRole("heading", { name: "Comparison scoreboard", exact: true }).waitFor({ state: "visible" });

  // The three figures and their bases render (Scoreboard.tsx: orders by received date, shipped by
  // ship date, invoiced by invoice date — the VS eyeball basis, deliberately not Sales' finalizedAt).
  // "by ship date" / "by invoice date" each label multiple rows → .first() disambiguates.
  await page.getByText("Orders entered", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("by received date", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("by ship date").first().waitFor({ state: "visible" });
  await page.getByText("by invoice date").first().waitFor({ state: "visible" });

  // The window opens empty ("All dates …"); a preset fills the from/to inputs and re-fetches.
  const fromInput = page.getByLabel("From", { exact: true });
  assert.equal(await fromInput.inputValue(), "", "the scoreboard opens with an empty window");

  const weekRefetch = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/reports/scoreboard"
    && res.request().method() === "GET" && res.ok());
  await page.getByRole("button", { name: "This week", exact: true }).click();
  await weekRefetch;
  assert.match(
    await fromInput.inputValue(), /^\d{4}-\d{2}-\d{2}$/,
    "This week fills the window's from-date",
  );

  const monthRefetch = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/reports/scoreboard"
    && res.request().method() === "GET" && res.ok());
  await page.getByRole("button", { name: "This month", exact: true }).click();
  await monthRefetch;
  // thisMonthWindow always starts on the FIRST of the month — a specific-but-data-independent check
  // that the month preset applied and the window updated off the (different) week window.
  assert.match(
    await fromInput.inputValue(), /^\d{4}-\d{2}-01$/,
    "This month sets the window's from-date to the first of the month",
  );
  await shot("scoreboard-presets");
}

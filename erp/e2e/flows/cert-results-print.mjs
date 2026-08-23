// Flow 13 (Phase 4, Task 20): the certification lifecycle (design spec §13.3). Keys an order for
// the cert-required part — the ORDER-scope cert is created by the order save itself (§6.2) — and
// finds it on the hub already SEEDED from the part's two inspections, with the frozen
// min/max/scale/location rendered read-only (§4.1: a part edit next month must never rewrite a
// cert being filled in). Enters readings and watches pass/fail compute LIVE on screen (§3.21:
// screen only — the page itself says it never prints), overrides a failing reading to Pass with
// the explicit override control, prints, and confirms the stored file is byte-identical on
// re-download (the stored-bytes reprint guarantee; two FRESH renders are never byte-compared —
// the renderPdf non-determinism rule) plus a second print archiving a second document.
import assert from "node:assert/strict";
import { assertNeverVisible } from "../lib/ui.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createOrderViaUi } from "../lib/orders.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- The order; its save creates the order-scope cert (§6.2). ---
  await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.certPartNumber, qty: 12 }],
  });

  // --- Hub Certifications section lists it; the scope label links to the cert page. ---
  await page.getByRole("link", { name: "By order", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("hub-cert-listed");
  await page.getByRole("link", { name: "By order", exact: true }).click();
  await page.getByRole("heading", { name: /^Certification #\d+/ }).waitFor({ state: "visible", timeout: 15000 });

  // --- Seeded from PartInspection, frozen (§4.1/§6.3): both requirements, in the part's own
  // sort order, with scale/min/max/sample qty/location copied at creation. ---
  const hardnessBlock = page.locator("div.border-slate-200").filter({ hasText: fixtures.inspectionCodeAName });
  const caseDepthBlock = page.locator("div.border-slate-200").filter({ hasText: fixtures.inspectionCodeBName });
  await hardnessBlock.waitFor({ state: "visible" });
  await caseDepthBlock.waitFor({ state: "visible" });
  await hardnessBlock.getByText(fixtures.inspectionScaleName, { exact: true }).waitFor({ state: "visible" });
  await hardnessBlock.getByText("E2E flange OD", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("No readings yet.").first().waitFor({ state: "visible" });
  await shot("cert-seeded-frozen");

  // --- Readings: 45 passes the frozen 40–50 band, 60 fails it — both verdicts computed LIVE
  // client-side with the same computePassed the server runs, before any save. ---
  const valueInput = (row) => row.locator('input:not([type="checkbox"])').first();
  await hardnessBlock.getByRole("button", { name: "Add reading", exact: true }).click();
  const row1 = hardnessBlock.locator("tbody tr").nth(0);
  await valueInput(row1).fill("45");
  await row1.getByText("Pass", { exact: true }).waitFor({ state: "visible" });
  await hardnessBlock.getByRole("button", { name: "Add reading", exact: true }).click();
  const row2 = hardnessBlock.locator("tbody tr").nth(1);
  await valueInput(row2).fill("60");
  await row2.getByText("Fail", { exact: true }).waitFor({ state: "visible" });
  await shot("computed-pass-fail-live");

  let saved = page.waitForResponse((res) =>
    res.url().includes("/results") && res.request().method() === "PUT" && res.ok());
  await hardnessBlock.getByRole("button", { name: "Save readings", exact: true }).click();
  await saved;
  // The summary reads the SERVER's stored verdicts back — three explicit states, never inferred
  // by subtraction (the Task 15 lesson).
  await page.getByText("1 passed", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("1 failed", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("0 pending", { exact: true }).waitFor({ state: "visible" });
  await shot("readings-saved");

  // --- Override the failing reading to Pass: explicit checkbox + verdict choice, audited, and
  // flagged on screen (§6.3). The block remounted after the save, so re-locate its rows. ---
  const row2Fresh = hardnessBlock.locator("tbody tr").nth(1);
  await row2Fresh.getByRole("checkbox").check();
  await row2Fresh.getByRole("combobox").selectOption("pass");
  saved = page.waitForResponse((res) =>
    res.url().includes("/results") && res.request().method() === "PUT" && res.ok());
  await hardnessBlock.getByRole("button", { name: "Save readings", exact: true }).click();
  await saved;
  await page.getByText("2 passed", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("0 failed", { exact: true }).waitFor({ state: "visible" });
  await shot("override-round-trip");

  // The §3.21 explanation the page itself carries: pass/fail (and min/max/scale/override marks)
  // never appear on the printed certification.
  await page.getByText(/never appears on the printed certification/).waitFor({ state: "visible" });

  // --- Print: archives the document and stamps first-print printedAt. ---
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print certification", exact: true }).click();
  const certLink = page.getByRole("link", { name: "Certification", exact: true }).first();
  await certLink.waitFor({ state: "visible", timeout: 30000 });
  await (await popup)?.close().catch(() => {});
  // The header's Printed fact now carries a date instead of "not yet" (the page reloaded server
  // truth after the print, which is also what arms the §5.16 post-print results gate).
  await assertNeverVisible(
    page.getByText("not yet", { exact: true }),
    "the Printed header fact should show the first-print date once printed",
  );
  const shotPath = await shot("cert-printed");

  // --- The stored file is exact: fetching the SAME archived document twice returns identical
  // bytes (Buffer.compare — the reprint guarantee, spec §12.12). ---
  const href = await certLink.getAttribute("href");
  const url = new URL(href, ctx.baseURL).toString();
  const first = await (await page.request.get(url)).body();
  const second = await (await page.request.get(url)).body();
  assert.ok(first.subarray(0, 5).toString() === "%PDF-", "the stored certification must be a PDF");
  assert.equal(Buffer.compare(first, second), 0,
    "re-downloading the stored certification must return byte-identical content");
  await fs.writeFile(path.join(path.dirname(shotPath), "certification.pdf"), first);

  // --- A second print action archives a SECOND document (each print is stored forever; the two
  // fresh renders are deliberately NOT byte-compared — renderPdf output is not deterministic). ---
  const popup2 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print certification", exact: true }).click();
  const deadline = Date.now() + 30000;
  for (;;) {
    if (await page.getByRole("link", { name: "Certification", exact: true }).count() >= 2) break;
    if (Date.now() > deadline) assert.fail("second print never appeared in the Documents list");
    await new Promise((r) => setTimeout(r, 250));
  }
  await (await popup2)?.close().catch(() => {});
  await shot("reprint-archived");
}

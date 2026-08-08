// Flow 16 (Phase 5A, Task 20): the invoicing lifecycle, end to end (P5A design spec §5.4/§5.5/
// §10, ruling 3). Keys an order against a TWO-PartPrice part (one order line, two priced
// operations — the multi-operation case ruling 3 exists for), ships it complete, watches the
// board flip to Shipped, moves it through /invoicing's Ready-to-invoice worklist into a DRAFT
// invoice, confirms the invoice page shows both priced operations plus a surcharge and a sales-
// tax line, Finalizes it (locking the draft-edit controls and writing the order's INVOICED
// status), Prints it (the print→archive seam Task 19 built and no flow before this one has
// exercised — the document must appear in the invoice page's OWN Documents list, which Task 19's
// brief owed but never actually built; Task 20 closes that gap, see `documents.ts`'s
// `listDocumentsForInvoice` and its route), then Unlocks it with a reason and confirms both the
// invoice returns to Draft and the order's board status returns to its ship-derived Shipped
// (never Open — status is the human line-complete flag, not order status arithmetic; spec §5.2).
//
// Never `page.waitForURL(/\/invoicing\/[^/?]+$/)` for the /invoicing -> /invoicing/<id> hop (the
// Phase 3/4 URL trap, now armed twice already) — that pattern would also match the literal
// `/invoicing` list page's own URL at the instant the link is clicked. Every wait below is for
// POST-navigation-ONLY content: the invoice page's own h1 (kind + document-number badge), which
// only renders once `invoice` state has actually loaded (InvoiceDetail.tsx: `if (!invoice) return
// <div>...</div>` gates the whole page body on it).
//
// Tax is exercised via the fixture customer's OWN `salesTaxRate` override, not by mutating the
// global `BillingConfig` singleton row — see the comment on `FIXTURE.invCustomerCode` in
// `e2e/lib/db-fixtures.ts` for why.
import assert from "node:assert/strict";
import { armPrompt, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const UNLOCK_REASON =
  "E2E invoice-shipped-order flow: intentional unlock, demonstrating the unlock UX for the demo.";

async function assertBoardStatus(page, ctx, orderNumber, statusText, absentText) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  const row = page.locator("tr").filter({ has: page.getByText(String(orderNumber), { exact: true }) });
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.getByText(statusText, { exact: true }).waitFor({ state: "visible" });
  if (absentText) {
    await assert.rejects(
      row.getByText(absentText, { exact: true }).waitFor({ state: "visible", timeout: 500 }),
      `board row for #${orderNumber} should show "${statusText}", not "${absentText}"`,
    );
  }
}

/** Both `/invoicing`'s two sections are plain `<section>`s, each headed by its own `<h2>` — the
 *  cleanest scope for a row lookup that must not cross into the other table. */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Key an order against the two-PartPrice part (one line, ten units). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.invCustomerCode,
    lines: [{ partNumber: fixtures.invPartNumber, qty: 10 }],
  });
  await shot("order-created");

  // --- Ship it complete. ---
  await startNewShipment(page, ctx, fixtures.invCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await panel.getByLabel("Line 1 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("shipment-saved");

  await assertBoardStatus(page, ctx, order.number, "· Shipped");
  await shot("board-shipped");

  // --- /invoicing: the order shows up under "Ready to invoice". Tick it and create. ---
  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readySection = sectionByHeading(page, "Ready to invoice");
  const readyRow = readySection.locator("tr").filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  await shot("ready-to-invoice-ticked");

  const created = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  await created;

  // --- The new DRAFT invoice appears in the "Invoices" table; open it. ---
  const invoicesSection = sectionByHeading(page, "Invoices");
  const invoiceRow = invoicesSection.locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-created");
  await invoiceRow.getByRole("link").click();

  // Post-navigation-only content — see the file's top comment. Tolerant of any invoice_number_
  // prefix (the badge is "Invoice <prefix> - <orderNumber>" or bare "Invoice <orderNumber>").
  const invoiceHeading = page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) });
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  const invoiceId = page.url().split("/").pop();
  await shot("invoice-draft");

  // --- Two priced OPERATION rows (ruling 3's multi-operation part), a SURCHARGE row and a
  // SALES TAX row (the fixture customer's own salesTaxRate). ---
  assert.equal(await page.locator("td", { hasText: "Operation" }).count(), 2,
    "the two-PartPrice part must produce two OPERATION rows on the invoice");
  assert.equal(await page.locator("td", { hasText: "Surcharge" }).count(), 1,
    "the one active plant-wide surcharge must produce one SURCHARGE row");
  assert.equal(await page.locator("td", { hasText: "Sales tax" }).count(), 1,
    "the customer's own salesTaxRate must produce one TAX row");
  // The description cell is a controlled <input> (InvoiceLinesGrid's `otherRow`), so its text
  // never reaches `getByText` (React controlled inputs don't expose `value` as an HTML attribute
  // or as text content — HANDOFF §5a's own documented trap). Locate the SURCHARGE row by its
  // static kind-label cell, then read its description input's live value directly.
  const surchargeRow = page.locator("tr").filter({ has: page.locator("td", { hasText: "Surcharge" }) });
  const surchargeDescription = await surchargeRow.locator("input").first().inputValue();
  assert.equal(surchargeDescription, fixtures.invSurchargeName,
    "the surcharge row must carry the surcharge's own name");
  assert.equal(await page.locator("td", { hasText: "needs price" }).count(), 0,
    "both priced operations must resolve a price — nothing should need one");

  // --- Finalize: controls lock, the order becomes Invoiced. ---
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.getByText("Finalized", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-finalized");

  const poInput = page.getByLabel("PO number", { exact: true });
  assert.equal(await poInput.evaluate((el) => el.readOnly), true,
    "a header field must lock once the invoice is finalized");
  const recalcButton = page.getByRole("button", { name: "Recalculate", exact: true });
  assert.equal(await recalcButton.isDisabled(), true, "Recalculate must lock once finalized");
  const finalizeButton = page.getByRole("button", { name: "Finalize", exact: true });
  assert.equal(await finalizeButton.isDisabled(), true, "Finalize must lock once already finalized");
  assert.equal(await finalizeButton.getAttribute("title"), "Already finalized");
  const unlockButton = page.getByRole("button", { name: "Unlock", exact: true });
  assert.equal(await unlockButton.isDisabled(), false, "Unlock must be available once finalized");

  await assertBoardStatus(page, ctx, order.number, "· Invoiced", "· Shipped");
  await shot("board-invoiced");

  // --- Print: the print→archive seam Task 19 built — the document must appear in the invoice
  // page's own Documents list. ---
  await page.goto(`${ctx.baseURL}/invoicing/${invoiceId}`);
  await invoiceHeading.waitFor({ state: "visible", timeout: 15000 });
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const printed = page.waitForResponse((res) =>
    res.url().endsWith(`/api/invoices/${invoiceId}/print`) && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await printed;
  await (await popup)?.close().catch(() => {});

  const documentsSection = sectionByHeading(page, "Documents");
  await documentsSection.getByRole("link", { name: "Invoice", exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-printed-archived");

  // --- Unlock with a reason: controls unlock, the invoice returns to Draft, the order returns
  // to Shipped (its ship-derived status — NOT Open; spec §5.2, the reversing-shipment precedent
  // Task 15 set for invoice-owned states). ---
  const dialogMessage = armPrompt(page, UNLOCK_REASON);
  await unlockButton.click();
  const message = await dialogMessage;
  assert.match(message, /^Unlock Invoice/);
  assert.match(message, /Reason for unlocking \(recorded in the audit history\):/);
  await page.getByText("Draft", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-unlocked");

  assert.equal(await poInput.evaluate((el) => el.readOnly), false, "a header field must unlock after Unlock");
  assert.equal(await recalcButton.isDisabled(), false, "Recalculate must unlock after Unlock");
  assert.equal(await finalizeButton.isDisabled(), false, "Finalize must be available again after Unlock");
  assert.equal(await unlockButton.isDisabled(), true, "Unlock must lock again once there is nothing to unlock");

  await assertBoardStatus(page, ctx, order.number, "· Shipped", "· Invoiced");
  await shot("board-shipped-again");
}

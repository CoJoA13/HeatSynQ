// The north-star A/R flow (Task 17, P5B design spec §11/§4/§6/§8): seeds a shipped -> invoiced
// order (the 5A `invoice-shipped-order.mjs` precedent — same createOrderViaUi/startNewShipment/
// waitForShipmentPage helpers, same /invoicing "Ready to invoice" -> Create -> Finalize path),
// then drives the NEW `/receivables` screens end to end: a deposit batch, a check payment applied
// as a partial payment + an early-pay discount + a small write-off (leaving an on-account
// remainder), the aging report (the invoice's own bucket + the Unapplied column), and a printed,
// archived statement (combined family, finance charges assessed) that reappears in the
// customer's own Documents list.
//
// Fixture math (e2e/lib/db-fixtures.ts's `arCustomer`/`arPart`/`arTerms`/`arPaymentType`): one
// priced OPERATION line, unitPrice 100.00 x qty 10 = invoice total 1000.00 (`surchargeOptOut` +
// `taxable: false` on the fixture customer keep this exact — no surcharge/tax line rides along).
// Terms are 2/10/30 (netDays 30, discountPercent 2, discountDays 10): the payment is received
// today, well inside the 10-day window, so the early-pay discount is 2% of the invoice's OPEN
// balance at apply time (the owner-ruling-owed basis — see the demo doc) = 2% x 1000.00 = 20.00.
//
//   check received:              700.00
//   PAYMENT applied to invoice:  500.00
//   DISCOUNT applied:             20.00  (2% x 1000.00 open balance)
//   WRITE_OFF applied:            30.00
//   ---------------------------------------
//   applied to the invoice:      550.00  -> invoice open balance 1000.00 - 550.00 = 450.00
//                                            (CURRENT bucket: dueDate = invoiceDate + 30 days,
//                                            not yet past due)
//   on-account (unapplied cash): 700.00 (check) - 500.00 (PAYMENT-type applications) = 200.00
//
// So the aging report's row for this customer must show Current 450.00, Unapplied 200.00, Net
// 250.00 — the exact figures asserted below.
//
// Never `page.waitForURL` for a route -> route/[id] hop (the Phase 3/4/5A trap, spec §13,
// re-armed in invoice-shipped-order.mjs) — every wait below is for post-navigation-ONLY content.
import assert from "node:assert/strict";
import { waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const WRITE_OFF_REASON =
  "E2E receivables-apply-age-statement flow: small collection adjustment, demonstrating write-off UX for the demo.";

/** Both `/invoicing`'s two sections are plain `<section>`s, each headed by its own `<h2>` — the
 *  `invoice-shipped-order.mjs` `sectionByHeading` precedent, duplicated here (private there). */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Seed a shipped -> invoiced order (the invoice-shipped-order.mjs precedent). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.arCustomerCode,
    lines: [{ partNumber: fixtures.arPartNumber, qty: 10 }],
  });
  await shot("order-created");

  await startNewShipment(page, ctx, fixtures.arCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await panel.getByLabel("Line 1 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("shipment-saved");

  // --- /invoicing: create, then finalize, the invoice. ---
  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readySection = sectionByHeading(page, "Ready to invoice");
  const readyRow = readySection.locator("tr").filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();

  const created = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  await created;

  const invoicesSection = sectionByHeading(page, "Invoices");
  const invoiceRow = invoicesSection.locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await invoiceRow.getByRole("link").click();

  const invoiceHeading = page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) });
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  await shot("invoice-draft");

  // One priced OPERATION line, no surcharge (`surchargeOptOut`) and no tax (`taxable: false` on
  // the fixture customer) — total = subtotal = 1000.00 (see the file-header fixture-math
  // comment). Caught here, before the money math downstream gets harder to debug.
  const totalLabel = page.locator("span.border-t.pt-1.font-medium", { hasText: "Total" });
  const totalValue = totalLabel.locator("xpath=following-sibling::span[1]");
  assert.equal(await totalValue.textContent(), "1000.00",
    "the AR fixture's one priced operation (100.00 x 10, no surcharge/tax) must total 1000.00");

  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.getByText("Finalized", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-finalized");

  // --- /receivables: open a new deposit batch. ---
  const today = new Date().toISOString().slice(0, 10);

  await page.goto(`${ctx.baseURL}/receivables`);
  await page.getByRole("heading", { name: "Receivables", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("Deposit date", { exact: true }).fill(today);
  await page.getByRole("button", { name: "New batch", exact: true }).click();

  const batchHeading = page.getByRole("heading", { name: /^Batch #\d+/ });
  await batchHeading.waitFor({ state: "visible", timeout: 15000 });
  // Recorded for cleanup's id-driven backstop (run.mjs's `state.created` comment) — a
  // `ReceiptBatch` this flow creates but a later step fails before ever paying into is otherwise
  // invisible to the customer-scoped `deleteReceivables` sweep (no `Payment` row to find it by).
  ctx.created.receivablesBatchId = page.url().split("/").pop();
  await shot("batch-created");

  // --- Add a check payment. ---
  // NOT `getByLabel(..., { exact: true })` for these two: BatchDetail.tsx wraps each `<select>`
  // directly inside its own `<label>` text (nesting, not `aria-label`/`for`), and Playwright's
  // getByLabel computes that label's match text as the label's FULL textContent — which for a
  // `<select>` child recursively includes every `<option>`'s own rendered text too. So the
  // computed string is "Payer customerSelect…E2EARCUST · E2E AR Customer…", never literally
  // "Payer customer" — `exact: true` then matches nothing (verified live against this exact page:
  // 0 matches with `exact: true`, 1 without). `getByRole("combobox")`'s OWN accessible-name
  // computation does collapse to the clean "Payer customer" (confirmed via `ariaSnapshot()`), so
  // this is a getByLabel-specific quirk, not a real accessibility defect in the app — but it means
  // a `<select>` wrapped by a label needs a scoped `label ... select` locator instead (a plain
  // `<input>` has no text content of its own to pollute the label with — the "Amount"/"Check #"/
  // "Received date" fields below are unaffected and keep `exact: true`).
  await page.locator("label", { hasText: "Payer customer" }).locator("select").selectOption(fixtures.arCustomerId);
  await page.locator("label", { hasText: "Payment type" }).locator("select").selectOption(fixtures.arPaymentTypeId);
  await page.getByLabel("Amount", { exact: true }).fill("700.00");
  await page.getByLabel("Check #", { exact: true }).fill("E2E-1001");
  await page.getByLabel("Received date", { exact: true }).fill(today);
  await page.getByRole("button", { name: "Add payment", exact: true }).click();

  const paymentRow = page.locator("tr").filter({ has: page.getByText(fixtures.arPaymentTypeName, { exact: true }) });
  await paymentRow.waitFor({ state: "visible", timeout: 15000 });
  await shot("payment-added");

  // --- Apply: a partial payment + an early-pay discount + a small write-off, leaving an
  // on-account remainder (see the file-header fixture-math comment for the exact figures). ---
  await paymentRow.getByRole("button", { name: "Apply", exact: true }).click();
  // Scoped to the ApplyPanel's OWN nested `<table>` (found via its unique "Write-off" column
  // header's NEAREST ancestor `<table>`), not a bare `page.locator("tr")` and not even
  // `page.locator("table").filter({ has: ... })` — the panel renders inside `<td colSpan={8}>` of
  // a wrapper `<tr>` in the OUTER Payments table, so BOTH `tr` (candidate row vs. that outer
  // wrapper row) and `table` (inner ApplyPanel table vs. the outer Payments table, which also
  // "has" the header transitively through its nested descendant) go ambiguous under a `has:`
  // filter — a strict-mode violation caught live, twice, during this task's own development.
  // `ancestor::table[1]` picks the CLOSEST table, sidestepping the "has" transitivity trap.
  const applyTable = page.getByRole("columnheader", { name: "Write-off", exact: true })
    .locator("xpath=ancestor::table[1]");
  const invoiceCandidateRow = applyTable.locator("tbody tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceCandidateRow.waitFor({ state: "visible", timeout: 15000 });

  await invoiceCandidateRow.getByLabel(`${order.number} amount`, { exact: true }).fill("500.00");
  await invoiceCandidateRow.locator('input[type="checkbox"]').check();
  await invoiceCandidateRow.getByLabel(`${order.number} write-off amount`, { exact: true }).fill("30.00");
  await invoiceCandidateRow.getByLabel(`${order.number} write-off reason`, { exact: true }).fill(WRITE_OFF_REASON);
  await shot("apply-panel-filled");

  // The toggle button on `paymentRow` reads "Hide" once expanded (BatchDetail.tsx), so the ONLY
  // "Apply" button left on the page at this point is the ApplyPanel's own submit button.
  const applied = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/applications" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await applied;

  await page.getByText("Payment 700.00 · Applied 500.00 · On account 200.00", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("applied");

  // The Payments table's own "On account" column reflects the same figure.
  const onAccountCell = paymentRow.locator("td").nth(5);
  assert.equal((await onAccountCell.textContent()).trim(), "200.00",
    "the payment's on-account column must show the 200.00 unapplied remainder");

  // --- Aging report: the invoice's open balance (1000.00 - 550.00 = 450.00) sits in the CURRENT
  // bucket (dueDate = invoiceDate + 30 days, not yet past due); Unapplied carries the payment's
  // 200.00 on-account cash; Net = 450.00 - 200.00 = 250.00. ---
  await page.goto(`${ctx.baseURL}/receivables/aging`);
  await page.getByRole("heading", { name: "A/R Aging", exact: true }).waitFor({ state: "visible" });
  // Scoped `label ... select`, not `getByLabel(..., { exact: true })` — the same wrapping-label
  // `<select>` quirk as the batch's "Payer customer"/"Payment type" fields above.
  await page.locator("label", { hasText: "Customer / family" }).locator("select").selectOption(fixtures.arCustomerId);

  const agingRow = page.locator("tbody tr").filter({ has: page.getByText(fixtures.arCustomerCode, { exact: false }) });
  await agingRow.waitFor({ state: "visible", timeout: 15000 });
  const agingCells = agingRow.locator("td");
  assert.equal((await agingCells.nth(1).textContent()).trim(), "450.00", "Current bucket must hold the open balance");
  assert.equal((await agingCells.nth(2).textContent()).trim(), "0.00", "1–30 bucket must be empty — nothing is past due yet");
  assert.equal((await agingCells.nth(6).textContent()).trim(), "200.00", "Unapplied column must carry the on-account cash");
  assert.equal((await agingCells.nth(7).textContent()).trim(), "250.00", "Net column must be buckets minus unapplied");
  await shot("aging-report");

  // --- Statement: combined family, finance charges assessed. Preselected via `?customerId=`
  // (Statements.tsx reads it straight off the URL — no dropdown pick needed). ---
  await page.goto(`${ctx.baseURL}/receivables/statements?customerId=${fixtures.arCustomerId}`);
  await page.getByRole("heading", { name: "Statements", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("Combine family", { exact: true }).check();
  await page.getByLabel("Assess finance charges", { exact: true }).check();

  const totalDueLine = page.locator("p", { hasText: "Total due:" });
  await totalDueLine.waitFor({ state: "visible", timeout: 15000 });
  assert.match((await totalDueLine.textContent()) ?? "", /250\.00/, "the statement's total due must match the aging report's Net");
  await shot("statement-preview");

  const documentsSection = sectionByHeading(page, "Documents");
  const printed = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/statements" && res.request().method() === "POST" && res.ok());
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await printed;
  await (await popup)?.close().catch(() => {});

  await documentsSection.getByRole("link", { name: "Statement", exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("statement-printed-archived");
}

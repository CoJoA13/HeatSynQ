// The north-star A/R flow (Task 17, P5B design spec §11/§4/§6/§8): seeds a shipped -> invoiced
// order (the 5A `invoice-shipped-order.mjs` precedent — same createOrderViaUi/startNewShipment/
// waitForShipmentPage helpers, same /invoicing "Ready to invoice" -> Create -> Finalize path),
// then drives the NEW `/receivables` screens end to end: a deposit batch, a check payment applied
// as a partial payment + a small write-off (leaving an on-account remainder), the aging report
// (the invoice's own bucket + the Unapplied column), a printed, archived statement (combined
// family, finance charges assessed) that reappears in the customer's own Documents list, a
// STANDALONE bad-debt write-off and its undo on the customer's A/R section (#77), and finally a
// SECOND check that settles the invoice and takes the early-pay discount.
//
// The #77 round trip is deliberately NET-ZERO and sits between the statement and the settling
// check: it writes off the whole 470.00 still open (proving the invoice stays listed and flagged
// at zero instead of vanishing — the reason the owner put the void surface in scope), then voids
// it, putting the 470.00 back for the settling apply below. All it leaves behind is one
// soft-deleted Application, which no balance, aging, close or GL read ever sees.
//
// Fixture math (e2e/lib/db-fixtures.ts's `arCustomer`/`arPart`/`arTerms`/`arPaymentType`): one
// priced OPERATION line, unitPrice 100.00 x qty 10 = invoice total 1000.00 (`surchargeOptOut` +
// `taxable: false` on the fixture customer keep this exact — no surcharge/tax line rides along).
// Terms are 2/10/30 (netDays 30, discountPercent 2, discountDays 10) and both checks are received
// today, well inside the 10-day window. **The two applies are the two halves of #69** (owner ruling
// 2026-08-19: an early-pay discount is earned only by a payment that SETTLES the invoice) — the
// first is refused the offer and asserts its ABSENCE, the second earns it. Before that ruling the
// first apply took 20.00 on a partial payment.
//
//   FIRST APPLY — a partial payment; no discount offered (700.00 cannot settle 1,000.00):
//   check received:              700.00
//   PAYMENT applied to invoice:  500.00
//   WRITE_OFF applied:            30.00
//   ---------------------------------------
//   applied to the invoice:      530.00  -> invoice open balance 1000.00 - 530.00 = 470.00
//                                            (CURRENT bucket: dueDate = invoiceDate + 30 days,
//                                            not yet past due)
//   on-account (unapplied cash): 700.00 (check) - 500.00 (PAYMENT-type applications) = 200.00
//
// So the aging report's row for this customer must show Current 470.00, Unapplied 200.00, Net
// 270.00 — the exact figures asserted below, and the statement's total due must match that Net.
//
//   SECOND APPLY — the settling remittance, which DOES earn the discount (runs LAST, after every
//   aging/statement assertion, so it moves none of the figures above):
//   eligible discount:             9.40  (2% x the 470.00 still open, under the 20.00 entitlement)
//   check received:              460.60  (= 470.00 - 9.40, exactly the offer's boundary)
//   PAYMENT applied:             460.60
//   DISCOUNT taken:                9.40
//   ---------------------------------------
//   invoice open balance:          0.00, second check fully applied (on account 0.00)
//
// Never `page.waitForURL` for a route -> route/[id] hop (the Phase 3/4/5A trap, spec §13,
// re-armed in invoice-shipped-order.mjs) — every wait below is for post-navigation-ONLY content.
import assert from "node:assert/strict";
import { armPrompt, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const WRITE_OFF_REASON =
  "E2E receivables-apply-age-statement flow: small collection adjustment, demonstrating write-off UX for the demo.";
const BAD_DEBT_REASON =
  "E2E receivables-apply-age-statement flow: standalone bad-debt write-off (#77), voided again below.";
const VOID_REASON =
  "E2E receivables-apply-age-statement flow: undoing the bad-debt write-off from the screen that made it.";

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

  // --- Apply: a partial payment + a small write-off, leaving an on-account remainder (see the
  // file-header fixture-math comment for the exact figures). ---
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
  // #69: the "Take 20.00" checkbox is the ONLY thing rendered in the Discount cell, and it renders
  // only when `discountAvailable > 0` (BatchDetail.tsx). This 700.00 check cannot settle the
  // 1,000.00 invoice, so the server offers nothing and the affordance is absent — asserted rather
  // than merely not-clicked, because a silently reappearing checkbox is exactly how the pre-ruling
  // behavior would creep back in.
  assert.equal(await invoiceCandidateRow.locator('input[type="checkbox"]').count(), 0,
    "no early-pay discount may be offered on a payment that cannot settle the invoice (#69)");
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

  // --- Aging report: the invoice's open balance (1000.00 - 530.00 = 470.00) sits in the CURRENT
  // bucket (dueDate = invoiceDate + 30 days, not yet past due); Unapplied carries the payment's
  // 200.00 on-account cash; Net = 470.00 - 200.00 = 270.00. ---
  await page.goto(`${ctx.baseURL}/receivables/aging`);
  await page.getByRole("heading", { name: "A/R Aging", exact: true }).waitFor({ state: "visible" });
  // Scoped `label ... select`, not `getByLabel(..., { exact: true })` — the same wrapping-label
  // `<select>` quirk as the batch's "Payer customer"/"Payment type" fields above.
  await page.locator("label", { hasText: "Customer / family" }).locator("select").selectOption(fixtures.arCustomerId);

  const agingRow = page.locator("tbody tr").filter({ has: page.getByText(fixtures.arCustomerCode, { exact: false }) });
  await agingRow.waitFor({ state: "visible", timeout: 15000 });
  const agingCells = agingRow.locator("td");
  assert.equal((await agingCells.nth(1).textContent()).trim(), "470.00", "Current bucket must hold the open balance");
  assert.equal((await agingCells.nth(2).textContent()).trim(), "0.00", "1–30 bucket must be empty — nothing is past due yet");
  assert.equal((await agingCells.nth(6).textContent()).trim(), "200.00", "Unapplied column must carry the on-account cash");
  assert.equal((await agingCells.nth(7).textContent()).trim(), "270.00", "Net column must be buckets minus unapplied");
  await shot("aging-report");

  // --- Statement: combined family, finance charges assessed. Preselected via `?customerId=`
  // (Statements.tsx reads it straight off the URL — no dropdown pick needed). ---
  await page.goto(`${ctx.baseURL}/receivables/statements?customerId=${fixtures.arCustomerId}`);
  await page.getByRole("heading", { name: "Statements", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("Combine family", { exact: true }).check();
  await page.getByLabel("Assess finance charges", { exact: true }).check();

  const totalDueLine = page.locator("p", { hasText: "Total due:" });
  await totalDueLine.waitFor({ state: "visible", timeout: 15000 });
  assert.match((await totalDueLine.textContent()) ?? "", /270\.00/, "the statement's total due must match the aging report's Net");
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

  // --- The STANDALONE bad-debt write-off and its undo (#77), on the customer's own A/R section.
  // A deliberate NET-ZERO round trip, inserted here rather than at the tail: the whole point of the
  // owner's void ruling is that a fully written-off invoice must stay reachable, which can only be
  // shown while there IS an open balance — and the settling apply below needs the same 470.00 the
  // void puts back. It leaves nothing behind but one soft-deleted Application (invisible to every
  // balance, the aging, the close and the GL delta, all of which read live rows only), so every
  // figure asserted above and below is untouched. ---
  await page.goto(`${ctx.baseURL}/customers/${fixtures.arCustomerId}`);
  const receivables = sectionByHeading(page, "Receivables");
  const netBalance = receivables.locator("p", { hasText: "Net balance:" });
  await netBalance.waitFor({ state: "visible", timeout: 15000 });
  assert.match((await netBalance.textContent()) ?? "", /270\.00/,
    "the customer A/R section must open on the same 270.00 net the aging report and statement showed");

  const invoiceRow = receivables.locator("tbody tr").filter({ hasText: String(order.number) }).first();
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await invoiceRow.locator("td").nth(5).textContent()).trim(), "470.00",
    "the open-items row must carry the invoice's live open balance");

  await invoiceRow.getByRole("button", { name: "Write off", exact: true }).click();
  const writeOffAmount = receivables.getByLabel("Amount to write off", { exact: true });
  // Owner ruling 2026-08-19: editable, defaulting to the FULL open balance. Asserting the DEFAULT
  // (rather than typing over it) is what pins that half of the ruling.
  await waitForValue(writeOffAmount, "470.00");
  await receivables.getByLabel("Reason for the write-off", { exact: true }).fill(BAD_DEBT_REASON);
  await shot("write-off-form-filled");

  const wroteOff = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/write-offs" && res.request().method() === "POST" && res.ok());
  await receivables.getByRole("button", { name: "Write off balance", exact: true }).click();
  await wroteOff;

  // The invoice is settled to zero AND STILL LISTED, flagged — the void ruling's whole substance.
  // Before #77 this row vanished here, and with it the only handle its undo had.
  const writtenOffRow = receivables.locator("tbody tr").filter({ hasText: String(order.number) }).first();
  await writtenOffRow.getByText("Written off", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await writtenOffRow.locator("td").nth(5).textContent()).trim(), "0.00",
    "a fully written-off invoice must read 0.00 open and still be on screen");
  await netBalance.filter({ hasText: "-200.00" }).waitFor({ state: "visible", timeout: 15000 });
  assert.match((await netBalance.textContent()) ?? "", /-200\.00/,
    "the net must fall to the on-account cash alone once the receivable is written off");
  await shot("invoice-written-off");

  // The undo, from the same screen that made it (§5.14).
  const voidMessage = armPrompt(page, VOID_REASON);
  const voided = page.waitForResponse((res) =>
    /^\/api\/receivables\/applications\/[^/]+$/.test(new URL(res.url()).pathname)
    && res.request().method() === "DELETE" && res.ok());
  await receivables.getByRole("button", { name: "Void", exact: true }).click();
  assert.match(await voidMessage, /Void the write-off of 470\.00/);
  await voided;

  await netBalance.filter({ hasText: "270.00" }).waitFor({ state: "visible", timeout: 15000 });
  const restoredRow = receivables.locator("tbody tr").filter({ hasText: String(order.number) }).first();
  assert.equal((await restoredRow.locator("td").nth(5).textContent()).trim(), "470.00",
    "voiding the write-off must put the whole open balance back");
  await assert.rejects(
    restoredRow.getByText("Written off", { exact: true }).waitFor({ state: "visible", timeout: 1500 }),
    "the written-off flag must be gone once the write-off is voided",
  );
  await shot("write-off-voided");

  // --- LAST, and deliberately after every assertion above: a SECOND check that SETTLES the
  // invoice, which is the only way an early-pay discount can be earned since #69. This is the
  // discount's happy path — the checkbox rendered, checked, and driven through the route into a
  // real DISCOUNT application — restored end to end after the first apply above lost it. It runs
  // at the tail so the aging/statement fixture math it would otherwise move stays untouched.
  //
  //   invoice open after the first apply:  470.00
  //   eligible discount:                     9.40  (2% x 470.00, under the 20.00 entitlement)
  //   second check received:               460.60  (= 470.00 - 9.40, the settling remittance)
  //   PAYMENT applied:                     460.60
  //   DISCOUNT taken:                        9.40
  //   ---------------------------------------------
  //   invoice open balance:                  0.00, and the check is fully applied (on account 0.00)
  //
  // 460.60 is the offer's boundary exactly (`cash >= open - eligible`), so a cent lost anywhere in
  // the chain shows up here as an absent checkbox rather than a wrong number.
  await page.goto(`${ctx.baseURL}/receivables/batches/${ctx.created.receivablesBatchId}`);
  await batchHeading.waitFor({ state: "visible", timeout: 15000 });
  await page.locator("label", { hasText: "Payer customer" }).locator("select").selectOption(fixtures.arCustomerId);
  await page.locator("label", { hasText: "Payment type" }).locator("select").selectOption(fixtures.arPaymentTypeId);
  await page.getByLabel("Amount", { exact: true }).fill("460.60");
  await page.getByLabel("Check #", { exact: true }).fill("E2E-1002");
  await page.getByLabel("Received date", { exact: true }).fill(today);
  await page.getByRole("button", { name: "Add payment", exact: true }).click();

  // By CHECK NUMBER, not by payment type: both checks share this batch's one payment type now, so
  // the `paymentRow` locator used earlier in this flow would match two rows from here on.
  const settlingRow = page.locator("tr").filter({ has: page.getByText("E2E-1002", { exact: true }) });
  await settlingRow.waitFor({ state: "visible", timeout: 15000 });
  await settlingRow.getByRole("button", { name: "Apply", exact: true }).click();

  const settleTable = page.getByRole("columnheader", { name: "Write-off", exact: true })
    .locator("xpath=ancestor::table[1]");
  const settleCandidateRow = settleTable.locator("tbody tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await settleCandidateRow.waitFor({ state: "visible", timeout: 15000 });

  // The offer is present THIS time, and for the right amount — the mirror of the absence assertion
  // on the first apply, and the half of #69 that would otherwise have no end-to-end coverage.
  await settleCandidateRow.getByText(/^Take 9\.40$/).waitFor({ state: "visible", timeout: 15000 });
  await settleCandidateRow.getByLabel(`${order.number} amount`, { exact: true }).fill("460.60");
  await settleCandidateRow.locator('input[type="checkbox"]').check();
  await shot("settling-apply-panel-filled");

  // Scoped to the panel's own `<td colSpan={8}>` (the candidate table's nearest ancestor `td`),
  // NOT `page.getByRole(...)` as the first apply above could safely do: with a second payment row
  // on screen, the page now carries the OTHER row's "Apply" toggle as well as this panel's submit
  // button, and an unscoped locator goes strict-mode ambiguous.
  const settlePanel = settleTable.locator("xpath=ancestor::td[1]");
  const settled = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/applications" && res.request().method() === "POST" && res.ok());
  await settlePanel.getByRole("button", { name: "Apply", exact: true }).click();
  await settled;

  await settlePanel.getByText("Payment 460.60 · Applied 460.60 · On account 0.00", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  // The DISCOUNT actually landed as its own application row, at the offered figure.
  const discountRow = settlePanel.locator("tr").filter({ has: page.getByText("Discount", { exact: true }) });
  await discountRow.waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await discountRow.locator("td").nth(2).textContent()).trim(), "9.40",
    "the DISCOUNT application must be written for the offered early-pay amount (#69)");
  // Settled invoices drop out of the candidate list, so the row that carried the offer is gone.
  await settleCandidateRow.waitFor({ state: "detached", timeout: 15000 });
  await shot("settling-payment-applied");
}

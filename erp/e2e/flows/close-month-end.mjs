// Flow 18 (last, Phase 5C, Task 9): the month-end close + QuickBooks Online summary export, end to
// end (5C design spec §4.1/§4.3/§6/§7). Sets the four Admin -> Billing plant-default GL accounts
// through the real UI, seeds a shipped -> invoiced order against its own fixture customer (the
// `invoice-shipped-order.mjs`/`receivables-apply-age-statement.mjs` precedent), takes a payment
// with a partial application, an early-pay discount, and a small write-off, opens
// `/receivables/close`, confirms the preliminary schedule reconciles (variance 0), closes the
// current month, exports the GL delta, downloads the CSV and confirms it balances, then reopens the
// month, VOIDS the write-off application (the reachable correction unit — see the note below on why
// "void the payment" itself is not: `voidPayment` refuses on a POSTED batch, and the batch must stay
// POSTED for its cash to count in the close at all; §4.1/§6 name `voidApplication` as the
// post-reopen correction path), re-closes, re-exports, and confirms a non-empty, exactly-balanced
// REVERSING delta scoped to that one event.
//
// WHY "THIS MONTH", NOT A FIXED "JULY" (unlike the task brief's own sample wording): every A/R
// mutation this flow drives (order/invoice/payment/application) is dated by the SERVER as today —
// none of the UI screens this flow touches expose a way to backdate them — so the only month
// reachable through the real UI, ever, is the current one. `year`/`month` are computed from the
// same wall-clock moment the fixtures and the app both use.
//
// WHY THIS FLOW BACKFILLS TWO PHASE 5B FIXTURES (see `e2e/lib/db-fixtures.ts`'s `arOpGlAccountName`
// and `closePaymentType` comments): `resolveReadiness`/`buildCurrentJournal` (gl-export.ts) scan
// EVERY finalized invoice / posted payment dated in the target month GLOBALLY, not per-customer.
// `receivables-apply-age-statement.mjs`'s own invoice stays FINALIZED for the rest of a run (unlike
// `invoice-shipped-order.mjs`'s, which ends Unlocked and so drops out of scope) and runs earlier in
// `FLOWS`, so by the time this flow reaches Export, that invoice's step code and payment type are
// ALSO in this month's scope — without a GL account on each, this flow's own export would be
// refused by a gap that isn't its own fixture's to fix. `db-fixtures.ts`'s `create()` backfills both
// once, before any flow runs, so no flow's own assertions (dollar amounts, UI text) are disturbed.
//
// WHY THE FIRST EXPORT'S CSV IS ONLY ASSERTED BALANCED, NOT AN EXACT TOTAL, BUT THE SECOND ONE IS:
// the FIRST export of a brand-new month posts EVERY in-scope event as "new" — including the AR
// flow's own invoice/payment/discount/write-off, which ran earlier in this same calendar month — so
// its total is not this flow's own to predict. The SECOND export (after reopening and voiding just
// THIS flow's own write-off application) is exact: every other event stayes UNCHANGED between the
// two exports (present in both the prior-posted and current-live maps) and so emits nothing, leaving
// the reversing delta scoped to exactly the one event this flow itself voided — a precise,
// deterministic assertion, not a flaky one.
//
// A PRE-FLIGHT GUARD (below) refuses to run at all if a `ClosePeriod` for the target month ALREADY
// exists — this flow only ever touches a period it creates itself; see `db-fixtures.ts`'s
// `deleteClosePeriodFixture` comment for why a broader self-heal sweep is deliberately not built.
import assert from "node:assert/strict";
import { armPrompt, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const CHECK_AMOUNT = "600.00";
const PAYMENT_AMOUNT = "400.00";
const WRITE_OFF_AMOUNT = "30.00";
const WRITE_OFF_AMOUNT_CENTS = 3000;
const WRITE_OFF_REASON =
  "E2E close-month-end flow: small collection adjustment, demonstrating the write-off UX for the demo.";
const VOID_REASON =
  "E2E close-month-end flow: correcting a mistaken write-off before re-closing, demonstrating the " +
  "reopen -> correct -> re-close -> re-export reversing delta for the demo.";

/** Both `/invoicing`'s two sections are plain `<section>`s, each headed by its own `<h2>` — the
 *  `invoice-shipped-order.mjs`/`receivables-apply-age-statement.mjs` `sectionByHeading` precedent. */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

/** Polls `locator.count()` until it reaches `min` or `timeoutMs` elapses — for a list that grows
 *  after a mutation (a new closed-period row, a new export-batch list item) where no single
 *  network response is the "done" signal on its own (the close screen bumps a `refresh` counter
 *  that re-pulls THREE endpoints, not one). */
async function waitForCount(locator, min, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await locator.count();
    if (n >= min) return n;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for at least ${min} item(s) — last saw ${n}`);
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

/** The closed-period row for `label` ("August 2026") — keyed on Close.tsx's
 *  `data-testid="closed-period-row"` (#90; the old `ancestor::div[contains(@class,'p-3')]` xpath
 *  broke on any padding retune), narrowed to the row whose `<span class="font-medium">` holds the
 *  period label. */
function periodRow(page, label) {
  return page.locator('[data-testid="closed-period-row"]')
    .filter({ has: page.locator("span.font-medium", { hasText: label }) });
}

/**
 * A ONE-SHOT `confirm()` handler — unlike `armDialog` (ui.mjs), which registers a PERSISTENT
 * `page.on("dialog", ...)` listener that is never removed (fine for every existing flow, which
 * arms a dialog exactly once per run). This flow arms THREE separate dialog sequences on the same
 * `page` (two batch-post confirms, then a reopen confirm+prompt, then a void prompt) — a second
 * `armDialog`/`armPrompt` call on the same page would leave the FIRST listener still registered,
 * and Playwright's own dialog object can only be accepted/dismissed once, so the second listener to
 * fire on a later dialog crashes with "Cannot accept dialog which is already handled!" (caught live
 * during this task's own development). `page.once` self-removes after firing, so each of this
 * flow's three dialog sequences starts with a clean listener set.
 */
function armConfirmOnce(page) {
  return new Promise((resolve, reject) => {
    page.once("dialog", (dialog) => {
      dialog.accept().then(() => resolve(dialog.message())).catch(reject);
    });
  });
}

/** Reopen (Close.tsx `doReopen`) fires `confirm()` THEN `prompt()` back to back in one click
 *  handler — two chained `page.once` listeners (the `armConfirmOnce` doc comment's own reasoning
 *  for why this flow cannot reuse `armDialog`/`armPrompt` as-is), so neither lingers to intercept
 *  the void-application `armPrompt` call later in this same flow. */
function armReopenDialogs(page, reason) {
  return new Promise((resolve, reject) => {
    page.once("dialog", (dialog) => {
      if (dialog.type() !== "confirm") { reject(new Error(`Expected a confirm dialog, got ${dialog.type()}`)); return; }
      dialog.accept().then(() => {
        page.once("dialog", (dialog2) => {
          if (dialog2.type() !== "prompt") { reject(new Error(`Expected a prompt dialog, got ${dialog2.type()}`)); return; }
          dialog2.accept(reason).then(resolve).catch(reject);
        });
      }).catch(reject);
    });
  });
}

/** Sums the Debit/Credit columns of a `GL_EXPORT_COLUMNS` CSV (`Date,Account,Debit,Credit,Memo`)
 *  in integer cents — a small quote-aware line splitter, not a full CSV library, since this
 *  harness's own fixture account names/memos never contain a comma or a quote (verified against
 *  `renderCsv`'s own `esc()`, which only engages for those two characters plus newlines). */
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function sumCsv(text) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("Empty CSV — expected at least a header row");
  const rows = lines.slice(1).map(parseCsvLine);
  let debitCents = 0;
  let creditCents = 0;
  for (const r of rows) {
    if (r[2]) debitCents += Math.round(Number(r[2]) * 100);
    if (r[3]) creditCents += Math.round(Number(r[3]) * 100);
  }
  return { rowCount: rows.length, debitCents, creditCents };
}

/**
 * Posts an OPEN receipt batch (the close screen's own "N open receipt batch(es) ... not yet posted
 * — post first if it belongs in this close" nudge, `close-periods.ts`'s `computeSchedule`: an
 * UNPOSTED batch's payment total is excluded from `paymentTotal` even though its cash already
 * counts in the aging `Unapplied` column — leaving it unposted is the one reliable way to make the
 * roll-forward-vs-aging variance nonzero). A no-op if already posted (the status badge next to the
 * heading already reads "Posted") — defensive, not expected to trigger here. `batchId` is null-safe
 * so callers can pass `ctx.created.receivablesBatchId` without an extra guard at the call site.
 */
async function postOpenBatch(page, ctx, batchId) {
  if (!batchId) return;
  await page.goto(`${ctx.baseURL}/receivables/batches/${batchId}`);
  const heading = page.getByRole("heading", { name: /^Batch #\d+/ });
  await heading.waitFor({ state: "visible", timeout: 15000 });
  if (await heading.getByText("Posted", { exact: true }).count() > 0) return;
  const confirmed = armConfirmOnce(page);
  const posted = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/receivables/batches/${batchId}`
    && res.request().method() === "PATCH" && res.ok());
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await confirmed;
  await posted;
}

/** Sets one Admin -> Billing GL-default `<select>` by ACCESSIBLE NAME (never `getByLabel`, the
 *  HANDOFF §5a trap — every `<select>` on this page is wrapped directly by its own `<label>` text,
 *  which `getByLabel`'s computation pollutes with every option's rendered text; `getByRole`'s own
 *  accessible-name computation does not have this problem) and waits for the PUT this page's
 *  `save()` fires on every `onChange` to resolve before returning, so two selects never race each
 *  other into a serialization conflict on the shared `BillingConfig` singleton row (`setBillingConfig`
 *  runs Serializable with no retry when an FK is being assigned).
 */
async function setBillingGlAccount(page, ctx, labelText, glAccountId) {
  const saved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/admin/billing" && res.request().method() === "PUT" && res.ok());
  await page.getByRole("combobox", { name: labelText, exact: true }).selectOption(glAccountId);
  await saved;
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Target period: THIS month (see the file header for why). Deliberately NOT recorded on
  // `ctx.created` here — `run.mjs`'s `finally { teardown() }` cleans up `ctx.created` on EVERY
  // exit path, pass or fail, including a guard failure below. If a REAL ClosePeriod already covers
  // this month (a developer/owner closed it through the live UI — the demo doc's own "watching it
  // live" section invites exactly this), the guard correctly refuses to POST, but recording the
  // year/month here regardless would still hand cleanup's id-driven `deleteClosePeriodFixture` a
  // target it did not create, and `ClosePeriod` is `@@unique([year,month])` — cleanup would
  // hard-delete a real period + its GlExportBatch/GlPosting/audit rows. `ctx.created.
  // closePeriodYear`/`Month` are set ONLY after THIS flow's own `closePeriod` POST below actually
  // succeeds (see that block), so a guard failure — or anything that throws before this flow closes
  // the month itself — leaves them `null` and cleanup never touches a period it didn't create. ---
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-based

  // --- Pre-flight guard: refuse to run at all if a ClosePeriod already covers this month — this
  // flow only ever touches a period it creates itself (see the file header / db-fixtures.ts). ---
  const existingPeriodsRes = await page.request.get(`${ctx.baseURL}/api/receivables/close`);
  assert.equal(existingPeriodsRes.ok(), true, "GET /api/receivables/close must succeed");
  const existingPeriods = await existingPeriodsRes.json();
  assert.equal(
    existingPeriods.some((p) => p.year === year && p.month === month), false,
    `Refusing to run: a ClosePeriod already exists for ${year}-${month} — this flow only ever ` +
    "touches a period it creates itself. Investigate (GET /api/receivables/close) before re-running.",
  );

  // --- Admin -> Billing: the four plant-default GL accounts the close/export needs. ---
  await page.goto(`${ctx.baseURL}/admin/billing`);
  await page.getByRole("heading", { name: "Billing", exact: true }).waitFor({ state: "visible" });
  await setBillingGlAccount(page, ctx, "A/R GL account", fixtures.closeArGlAccountId);
  await setBillingGlAccount(page, ctx, "Discount GL account", fixtures.closeDiscountGlAccountId);
  await setBillingGlAccount(page, ctx, "Write-off GL account", fixtures.closeWriteOffGlAccountId);
  await setBillingGlAccount(page, ctx, "Sales tax GL account", fixtures.closeSalesTaxGlAccountId);
  await shot("billing-gl-defaults-set");

  // --- Seed a shipped -> invoiced order (the invoice-shipped-order.mjs precedent). One priced
  // OPERATION, unitPrice 100.00 x qty 10 = 1000.00 (`surchargeOptOut` + `taxable: false` keep this
  // exact). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.closeCustomerCode,
    lines: [{ partNumber: fixtures.closePartNumber, qty: 10 }],
  });
  await shot("order-created");

  await startNewShipment(page, ctx, fixtures.closeCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await panel.getByLabel("Line 1 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("shipment-saved");

  // --- /invoicing: create, then finalize. ---
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

  const totalLabel = page.locator("span.border-t.pt-1.font-medium", { hasText: "Total" });
  const totalValue = totalLabel.locator("xpath=following-sibling::span[1]");
  assert.equal(await totalValue.textContent(), "1000.00",
    "the close fixture's one priced operation (100.00 x 10, no surcharge/tax) must total 1000.00");

  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.getByText("Finalized", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-finalized");

  // --- /receivables: a deposit batch, a check payment, and an apply: a partial PAYMENT + the
  // early-pay DISCOUNT + a small WRITE_OFF (fixture math: check 600.00, PAYMENT 400.00, DISCOUNT
  // 2% x 1000.00 open balance = 20.00, WRITE_OFF 30.00 -> applied 450.00, open 550.00, on-account
  // 200.00 — the receivables-apply-age-statement.mjs fixture-math precedent, own numbers). ---
  const today = new Date().toISOString().slice(0, 10);

  await page.goto(`${ctx.baseURL}/receivables`);
  await page.getByRole("heading", { name: "Receivables", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("Deposit date", { exact: true }).fill(today);
  await page.getByRole("button", { name: "New batch", exact: true }).click();

  const batchHeading = page.getByRole("heading", { name: /^Batch #\d+/ });
  await batchHeading.waitFor({ state: "visible", timeout: 15000 });
  // Recorded for cleanup's id-driven backstop — see the `receivablesBatchId` precedent
  // (receivables-apply-age-statement.mjs / run.mjs's `state.created` comment). A SEPARATE field
  // (`closeBatchId`), never `receivablesBatchId`, so the two A/R flows' backstops cannot clobber
  // each other.
  ctx.created.closeBatchId = page.url().split("/").pop();
  await shot("batch-created");

  await page.locator("label", { hasText: "Payer customer" }).locator("select").selectOption(fixtures.closeCustomerId);
  await page.locator("label", { hasText: "Payment type" }).locator("select").selectOption(fixtures.closePaymentTypeId);
  await page.getByLabel("Amount", { exact: true }).fill(CHECK_AMOUNT);
  await page.getByLabel("Check #", { exact: true }).fill("E2E-CLOSE-1001");
  await page.getByLabel("Received date", { exact: true }).fill(today);
  await page.getByRole("button", { name: "Add payment", exact: true }).click();

  const paymentRow = page.locator("tr").filter({ has: page.getByText(fixtures.closePaymentTypeName, { exact: true }) });
  await paymentRow.waitFor({ state: "visible", timeout: 15000 });
  await shot("payment-added");

  await paymentRow.getByRole("button", { name: "Apply", exact: true }).click();
  // The ApplyPanel's OWN candidate-grid table, found via its unique "Write-off" COLUMN header's
  // nearest ancestor table (the receivables-apply-age-statement.mjs precedent for this exact trap).
  const candidateTable = page.getByRole("columnheader", { name: "Write-off", exact: true })
    .locator("xpath=ancestor::table[1]");
  const invoiceCandidateRow = candidateTable.locator("tbody tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceCandidateRow.waitFor({ state: "visible", timeout: 15000 });

  await invoiceCandidateRow.getByLabel(`${order.number} amount`, { exact: true }).fill(PAYMENT_AMOUNT);
  await invoiceCandidateRow.locator('input[type="checkbox"]').check(); // take the early-pay discount
  await invoiceCandidateRow.getByLabel(`${order.number} write-off amount`, { exact: true }).fill(WRITE_OFF_AMOUNT);
  await invoiceCandidateRow.getByLabel(`${order.number} write-off reason`, { exact: true }).fill(WRITE_OFF_REASON);
  await shot("apply-panel-filled");

  const applied = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/applications" && res.request().method() === "POST" && res.ok());
  // The toggle button reads "Hide" once expanded, so this is the ONLY "Apply" button left on screen.
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await applied;
  await page.getByText("Payment 600.00 · Applied 400.00 · On account 200.00", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("applied");

  // --- Post every OPEN batch this run itself created that carries a payment dated this month —
  // this flow's own batch, and `receivables-apply-age-statement.mjs`'s (Phase 5B), which runs
  // earlier in `FLOWS` and leaves its own batch OPEN. Real month-end prep, not a workaround: the
  // close screen's own preliminary report flags exactly this ("N open receipt batch(es) ... post
  // first if it belongs in this close"), and `computeSchedule` only counts a POSTED batch's cash —
  // an open one's payment is invisible to `paymentTotal` while its on-account cash is still visible
  // to the aging `Unapplied` column, so leaving either batch open makes the variance nonzero. Never
  // touches a batch this run did not itself create (`postOpenBatch`'s ids come only from
  // `ctx.created`, the harness's own "never touch a stranger's dev-DB row" discipline). ---
  await postOpenBatch(page, ctx, ctx.created.closeBatchId);
  await postOpenBatch(page, ctx, ctx.created.receivablesBatchId);

  // --- /receivables/close: the preliminary schedule for THIS month, confirmed to reconcile
  // (variance 0) via the SAME endpoint the screen itself reads — a robust numeric check, not a DOM
  // text scrape, since OTHER e2e flows' own finalized invoices dated this same month legitimately
  // ride along in the GLOBAL schedule total (see the file header). ---
  const query = `year=${year}&month=${month}`;
  await page.goto(`${ctx.baseURL}/receivables/close?${query}`);
  await page.getByRole("heading", { name: "Month-End Close", exact: true }).waitFor({ state: "visible" });
  await page.getByText(/^Continuity schedule/).waitFor({ state: "visible", timeout: 15000 });
  await shot("preliminary-schedule");

  const preliminaryRes = await page.request.get(`${ctx.baseURL}/api/receivables/close/preliminary?${query}`);
  assert.equal(preliminaryRes.ok(), true, "GET .../close/preliminary must succeed");
  const preliminary = await preliminaryRes.json();
  assert.equal(preliminary.unpostedBatchCount, 0,
    `every batch dated this month must be posted before the schedule can reconcile — ` +
    `${preliminary.unpostedBatchCount} still open`);
  assert.equal(preliminary.schedule.variance, 0,
    `preliminary schedule must reconcile (variance 0) — got ${JSON.stringify(preliminary.schedule)}`);

  const readinessRes = await page.request.get(`${ctx.baseURL}/api/receivables/close/readiness?${query}`);
  assert.equal(readinessRes.ok(), true, "GET .../close/readiness must succeed");
  const readinessGaps = await readinessRes.json();
  assert.equal(readinessGaps.length, 0,
    `readiness must be clear before export — gaps: ${JSON.stringify(readinessGaps)}`);
  await page.getByText("No GL account gaps for this period", { exact: false })
    .waitFor({ state: "visible", timeout: 15000 });

  // --- Close the month. ---
  const closed = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/close" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Close period", exact: true }).click();
  await closed;
  // Recorded ONLY now that THIS flow's own close has actually committed — see the file-header
  // comment on why this can't be set any earlier (a guard failure must leave cleanup with nothing
  // to delete). `deleteClosePeriodFixture`'s own belt-and-suspenders `closedById` check (db-
  // fixtures.ts) means even this is redundant against ever touching a period this flow didn't
  // close, not just a lucky ordering.
  ctx.created.closePeriodYear = year;
  ctx.created.closePeriodMonth = month;

  const label = `${["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"][month - 1]} ${year}`;
  const row = periodRow(page, label);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.getByText("CLOSED", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("period-closed");

  // --- Export to GL, download the CSV, and confirm it balances. ---
  const exportedOnce = page.waitForResponse((res) =>
    /\/api\/receivables\/close\/[^/]+\/export$/.test(new URL(res.url()).pathname)
    && res.request().method() === "POST" && res.ok());
  await row.getByRole("button", { name: "Export to GL", exact: true }).click();
  await exportedOnce;
  await waitForCount(row.locator("ul li"), 1);
  await shot("exported-first");

  const firstFileHref = await row.locator("ul li").first().getByRole("link", { name: "File", exact: true }).getAttribute("href");
  const firstCsvRes = await page.request.get(new URL(firstFileHref, ctx.baseURL).toString());
  assert.equal(firstCsvRes.ok(), true, "the first export's CSV file must download");
  const firstCsv = sumCsv(await firstCsvRes.text());
  assert.ok(firstCsv.rowCount > 0, "the first export's CSV must not be empty");
  assert.equal(firstCsv.debitCents, firstCsv.creditCents,
    `the first export's CSV must balance — debit ${firstCsv.debitCents} vs credit ${firstCsv.creditCents} cents`);

  // --- Reopen the month, void the write-off application (the reachable correction unit — see the
  // file header), re-close, re-export, and confirm a non-empty, EXACTLY-balanced reversing delta
  // scoped to that one 30.00 event (uncontaminated by any other flow's own events — see the file
  // header on why this second assertion, unlike the first, can be exact). ---
  const reopened = armReopenDialogs(page, "E2E close-month-end flow: reopening to correct a write-off, demonstrating the reopen UX for the demo.");
  await row.getByRole("button", { name: "Reopen", exact: true }).click();
  await reopened;
  await row.getByText("REOPENED", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("period-reopened");

  await page.goto(`${ctx.baseURL}/receivables/batches/${ctx.created.closeBatchId}`);
  await batchHeading.waitFor({ state: "visible", timeout: 15000 });
  const paymentRowAgain = page.locator("tr").filter({ has: page.getByText(fixtures.closePaymentTypeName, { exact: true }) });
  await paymentRowAgain.waitFor({ state: "visible", timeout: 15000 });
  await paymentRowAgain.getByRole("button", { name: "Apply", exact: true }).click();

  // The EXISTING-applications table (with per-row Void buttons) is a DIFFERENT table from BOTH the
  // outer Payments table AND the candidate grid, but its OWN "Type"/"Invoice"/"Amount" column
  // headers are each individually ambiguous with one or the other (the outer Payments table has its
  // own "Type" column; the candidate grid has its own "Invoice"/"Amount" columns) — a columnheader
  // `ancestor::table[1]` lookup here resolves to TWO tables, not one (caught live: the outer
  // Payments table IS a literal DOM ancestor of this table, since ApplyPanel renders inside its
  // `<td colSpan={8}>`, so the outer table's OWN direct "Type" header is a SECOND, unrelated match).
  // Located instead via the ApplyPanel's OWN root div, itself found by its unique summary line (the
  // exact text already asserted above), then that div's FIRST nested `<table>` — the applications
  // table always renders (JSX order) before the candidate grid's own table.
  const applyPanel = page.locator("div.mt-2.rounded.border.bg-slate-50.p-3")
    .filter({ has: page.getByText("Payment 600.00 · Applied 400.00 · On account 200.00", { exact: true }) });
  const applicationsTable = applyPanel.locator("table").first();
  const writeOffRow = applicationsTable.locator("tbody tr")
    .filter({ has: page.getByText("Write-off", { exact: true }) });
  await writeOffRow.waitFor({ state: "visible", timeout: 15000 });
  await shot("write-off-application-before-void");

  const voidMessage = armPrompt(page, VOID_REASON);
  const voided = page.waitForResponse((res) =>
    /\/api\/receivables\/applications\/[^/]+$/.test(new URL(res.url()).pathname)
    && res.request().method() === "DELETE" && res.ok());
  await writeOffRow.getByRole("button", { name: "Void", exact: true }).click();
  const message = await voidMessage;
  assert.match(message, /^Void the Write-off application of 30\.00 against invoice/);
  await voided;
  await shot("write-off-application-voided");

  await page.goto(`${ctx.baseURL}/receivables/close?${query}`);
  await page.getByRole("heading", { name: "Month-End Close", exact: true }).waitFor({ state: "visible" });

  const rePrelimRes = await page.request.get(`${ctx.baseURL}/api/receivables/close/preliminary?${query}`);
  const rePrelim = await rePrelimRes.json();
  assert.equal(rePrelim.schedule.variance, 0,
    `preliminary schedule must still reconcile after the void — got ${JSON.stringify(rePrelim.schedule)}`);

  const reClosed = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/receivables/close" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Close period", exact: true }).click();
  await reClosed;
  const rowAgain = periodRow(page, label);
  await rowAgain.getByText("CLOSED", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("period-re-closed");

  const exportedTwice = page.waitForResponse((res) =>
    /\/api\/receivables\/close\/[^/]+\/export$/.test(new URL(res.url()).pathname)
    && res.request().method() === "POST" && res.ok());
  await rowAgain.getByRole("button", { name: "Export to GL", exact: true }).click();
  await exportedTwice;
  await waitForCount(rowAgain.locator("ul li"), 2); // newest export batch is first (exportNumber desc)
  await shot("exported-second");

  const secondFileHref = await rowAgain.locator("ul li").first().getByRole("link", { name: "File", exact: true }).getAttribute("href");
  const secondCsvRes = await page.request.get(new URL(secondFileHref, ctx.baseURL).toString());
  assert.equal(secondCsvRes.ok(), true, "the second export's CSV file must download");
  const secondCsv = sumCsv(await secondCsvRes.text());
  assert.ok(secondCsv.rowCount > 0, "the reversing delta must be non-empty");
  assert.equal(secondCsv.debitCents, secondCsv.creditCents,
    `the reversing delta must balance — debit ${secondCsv.debitCents} vs credit ${secondCsv.creditCents} cents`);
  // Uncontaminated by any other flow's own events (see the file header): every OTHER in-scope event
  // is unchanged between the two exports and so emits nothing, leaving the delta scoped to exactly
  // the one 30.00 write-off this flow itself voided.
  assert.equal(secondCsv.debitCents, WRITE_OFF_AMOUNT_CENTS,
    `the reversing delta must equal exactly the voided write-off (${WRITE_OFF_AMOUNT_CENTS} cents) — ` +
    `got debit ${secondCsv.debitCents} cents`);
  assert.equal(secondCsv.creditCents, WRITE_OFF_AMOUNT_CENTS,
    `the reversing delta must equal exactly the voided write-off (${WRITE_OFF_AMOUNT_CENTS} cents) — ` +
    `got credit ${secondCsv.creditCents} cents`);
}

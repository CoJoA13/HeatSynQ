// Flow 19 (Phase 6, Task 11): the quoting lifecycle, end to end (P6 design spec §5, plan Task 11).
// Creates an ending statement on the admin reference page and marks it the default; creates a
// quote for the fixture quoting customer and verifies the server-side entry defaults (allocated
// number, today's dates, THE default ending statement — ruling 13); builds the agreement out to
// one part-linked line carrying a price row WITH a price break plus one free-text line carrying
// its own each-weight (ruling 1's XOR); prints it and sees the archived QUOTE document appear in
// the page's own Documents list (Task 10's print→archive seam); keys an order through the real
// entry page and watches the "Quote #N" auto-link preview appear BEFORE saving (spec §5.2,
// ruling 7), then finds the stored link on the hub's Lines table (ruling 6 — the STORED link, not
// a re-fetch); ships the order complete and raises a DRAFT invoice whose single operation row
// names its source "Quote #N" (tier-1 wholesale substitution, ruling 4 — the fixture part
// deliberately carries NO PartPrice, so that row can ONLY have come from the quote, which the
// zero "needs price" assertion pins); closes the quote with a reason and sees the warn-and-list
// banner name the still-open, not-yet-fully-invoiced order (ruling 6's close warning — the
// invoice DELIBERATELY stays a draft so the order qualifies); and finally backdates a second
// quote to land in BOTH §5.4 worklist sections (follow-up due AND expired — the same-quote
// overlap the spec calls information, not a bug).
//
// The invoice is NEVER finalized, for three stacked reasons: (1) the close warning above needs a
// linked order that is not fully invoiced; (2) this flow runs AFTER close-month-end, which leaves
// the current month CLOSED until teardown — finalize is period-guarded (`assertPeriodOpen`) and
// would be refused, while draft creation is not a posting mutation; (3) a draft has no
// `finalizedAt`, so it can never contaminate the close flow's readiness/export scope (which is
// also why the quote fixtures carry no GL accounts).
//
// Never `page.waitForURL` for any list -> detail hop (the Phase 3/4/5 URL trap): every wait below
// is for post-navigation-ONLY content (the quote page's own "Quote #N" h1, the hub's "Order #N"
// h1, the invoice page's kind+number h1).
//
// HANDOFF §5a's select-inside-label trap is live on this page: the quote header's "Ending
// statement" and the New-quote section's pickers are `<select>`s nested inside their own
// `<label>`s, whose Playwright label-text is polluted by every option's text — so those are all
// located with the scoped `locator("label", { hasText: … }).locator("select")` shape, never
// `getByLabel`. Plain `<input>`s (the date fields) keep `getByLabel`. The invoice grid's amount
// is a React controlled `<input>` (value invisible to getByText — the same §5a trap the
// invoice-shipped-order flow documents), so it is read via `waitForValue` on its aria-label.
import assert from "node:assert/strict";
import { armPrompt, pickCombobox, waitForValue } from "../lib/ui.mjs";
import { startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const EM_DASH = "—";

const STATEMENT_TEXT = "Thank you for the opportunity to quote. E2E harness fixture statement.";
const FREE_TEXT_PART = "E2E-QUOTE-FT-1";
const FOLLOW_UP_PART = "E2E-QUOTE-FUP-1";
const CLOSE_REASON =
  "E2E quotes flow: intentional close, demonstrating the linked-order warning for the demo.";

/** The app's date-only "today" is the UTC calendar day — `todayDateOnly()` (src/lib/
 *  business-days.ts) floors to UTC midnight and `formatDateOnly` renders UTC fields — so at 10pm
 *  CDT the app's today is already the NEXT local date (caught live on this flow's first run:
 *  the entry-default assertion saw "tomorrow"). Every date this flow computes or asserts against
 *  therefore uses the UTC calendar, never the machine's local one. */
function utcIso(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return utcIso(d);
}

/** Same shape as e2e/lib/orders.mjs's module-private helper (not exported there): a leftover
 *  autosaved draft opens /orders/new with the Resume/Discard banner; this flow always wants a
 *  blank form. */
async function discardDraftIfOffered(page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  try {
    await discard.waitFor({ state: "visible", timeout: 2000 });
    await discard.click();
  } catch {
    // no banner — the normal case
  }
}

/** A page section located by its own heading — the invoice-shipped-order precedent. */
function sectionByHeading(page, name) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name }) });
}

/** Creates a quote from /quotes' New-quote section (customer + first line) and waits for the
 *  detail page; returns `{ id, number }`. `firstLine` is `{ partId }` or `{ partNumberText }` —
 *  the section's own XOR. */
async function createQuoteViaUi(page, ctx, firstLine) {
  await page.goto(`${ctx.baseURL}/quotes`);
  await page.getByRole("heading", { name: "Quotes", exact: true }).waitFor({ state: "visible" });
  const section = sectionByHeading(page, "New quote");
  await section.locator("label", { hasText: "Customer" }).locator("select")
    .selectOption(ctx.fixtures.quoteCustomerId);
  if (firstLine.partId) {
    await section.locator("label", { hasText: "First line: part" }).locator("select")
      .selectOption(firstLine.partId);
  } else {
    await section.locator("label", { hasText: "free-text part number" }).locator("input")
      .fill(firstLine.partNumberText);
  }
  await section.getByRole("button", { name: "New quote", exact: true }).click();
  // Post-navigation-only content: the detail page's own h1.
  const heading = page.getByRole("heading", { name: /^Quote #\d+/ });
  await heading.waitFor({ state: "visible", timeout: 20000 });
  const text = (await heading.textContent()) ?? "";
  const match = text.match(/#(\d+)/);
  assert.ok(match, `Could not parse a quote number out of the heading "${text}"`);
  return { id: page.url().split("/").pop(), number: Number(match[1]) };
}

/** Saves the quote form and waits for the PATCH round trip AND the dirty flag to clear (the
 *  "Unsaved changes" badge going away is the adopt() commit signal). */
async function saveQuoteForm(page, quoteId) {
  const saved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/quotes/${quoteId}`
    && res.request().method() === "PATCH" && res.ok());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  await page.getByText("Unsaved changes", { exact: true }).waitFor({ state: "hidden", timeout: 10000 });
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const today = utcIso(new Date());

  // ---------------------------------------------------------------------------------------
  // 1. The ending statement: created on the admin reference page WITH Default ticked (one
  //    audited create exercising the at-most-one-live-default promote; any pre-existing dev-DB
  //    default is demoted by the real service and restored by cleanup — db-fixtures.ts).
  // ---------------------------------------------------------------------------------------
  await page.goto(`${ctx.baseURL}/admin/reference`);
  await page.getByRole("heading", { name: "Reference data", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Ending statements", { exact: true }).click();

  // The "Text" placeholder only exists once the endingStatement table has remounted (key={kind})
  // — waiting on the generic "Name" placeholder could match the PREVIOUS kind's add row for a
  // render tick.
  await page.getByPlaceholder("Text").waitFor({ state: "visible", timeout: 10000 });
  const addRow = page.locator("tr").filter({ has: page.getByPlaceholder("Name") });
  await addRow.getByPlaceholder("Name").fill(fixtures.quoteEndingStatementName);
  await addRow.getByPlaceholder("Text").fill(STATEMENT_TEXT);
  // The add row's single checkbox is the Default draft (the boolean extra column).
  await addRow.locator('input[type="checkbox"]').check();
  await shot("ending-statement-drafted");
  await addRow.getByRole("button", { name: "Add", exact: true }).click();

  const statementRow = page.locator("tr").filter({ hasText: fixtures.quoteEndingStatementName });
  await statementRow.waitFor({ state: "visible", timeout: 10000 });
  // Extras render before Active, so the row's FIRST checkbox is the Default flag — checked.
  assert.equal(await statementRow.locator('input[type="checkbox"]').first().isChecked(), true,
    "the new ending statement must hold the Default flag");
  await shot("ending-statement-default");

  // ---------------------------------------------------------------------------------------
  // 2. The quote: created from /quotes with the part-linked first line; the detail page then
  //    surfaces the server-side entry defaults (spec §5.1).
  // ---------------------------------------------------------------------------------------
  const quote = await createQuoteViaUi(page, ctx, { partId: fixtures.quotePartId });
  await waitForValue(page.getByLabel("Quote date", { exact: true }), today);
  await waitForValue(page.getByLabel("Effective", { exact: true }), today);
  const expiry = await page.getByLabel("Expires", { exact: true }).inputValue();
  assert.ok(expiry >= today,
    `the default expiry (${expiry}) must be on or after the default effective date (${today})`);
  // The default ending statement (ruling 13): the header select sits on the fixture statement,
  // and its text renders beneath. Select-inside-label -> the scoped-locator shape (§5a).
  const statementSelect = page.locator("label", { hasText: "Ending statement" }).locator("select");
  const selectedStatement = await statementSelect.evaluate((el) => el.selectedOptions[0]?.textContent ?? "");
  assert.equal(selectedStatement, fixtures.quoteEndingStatementName,
    "a new quote must default to THE default ending statement");
  await page.getByText(STATEMENT_TEXT, { exact: true }).waitFor({ state: "visible" });
  await shot("quote-created-defaults");

  // ---------------------------------------------------------------------------------------
  // 3. Build the agreement: line 1 gets a priced operation (setup/unit/minimum) plus a price
  //    break; line 2 is free text with its own each-weight. One Save (the single-save form).
  // ---------------------------------------------------------------------------------------
  const linesSection = sectionByHeading(page, "Lines");
  const cards = linesSection.locator("div.space-y-4 > div");
  const card1 = cards.nth(0);

  await card1.locator(`select:has(option:text-is("Add operation: code…"))`)
    .selectOption({ label: `${fixtures.quoteStepCodeCode} ${EM_DASH} ${fixtures.quoteStepCodeName}` });
  await card1.getByLabel("Setup charge", { exact: true }).fill("25.00");
  await card1.getByLabel("Unit price", { exact: true }).fill("4.50");
  await card1.getByLabel("Minimum charge", { exact: true }).fill("50.00");
  await card1.locator("label", { hasText: "Quoted qty" }).locator("input").fill("10");
  await card1.getByPlaceholder("Threshold").fill("100");
  await card1.getByPlaceholder("Price").fill("4.00");
  await card1.getByRole("button", { name: "Add break", exact: true }).click();

  await linesSection.getByRole("button", { name: "Add line", exact: true }).click();
  const card2 = cards.nth(1);
  await card2.getByLabel("Part number (free text)", { exact: true }).fill(FREE_TEXT_PART);
  await card2.getByLabel("Name", { exact: true }).fill("E2E Free Text Widget");
  await card2.getByLabel("Each weight (lb)", { exact: true }).fill("2.5");
  await shot("quote-lines-drafted");

  await saveQuoteForm(page, quote.id);
  // The break survived the round trip: the breaks table (card 1's only table) holds one row,
  // its threshold input re-populated from server truth.
  assert.equal(await card1.locator("table tbody tr").count(), 1,
    "the saved price row must carry exactly the one break entered");
  await waitForValue(card1.locator("table tbody tr input").first(), "100");
  await shot("quote-saved");

  // ---------------------------------------------------------------------------------------
  // 4. Print: the Task 10 print→archive seam — the stored QUOTE document appears in the page's
  //    own Documents list.
  // ---------------------------------------------------------------------------------------
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const printed = page.waitForResponse((res) =>
    res.url().endsWith(`/api/quotes/${quote.id}/print`) && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await printed;
  await (await popup)?.close().catch(() => {});
  await sectionByHeading(page, "Documents").getByRole("link", { name: "Quote", exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("quote-printed-archived");

  // ---------------------------------------------------------------------------------------
  // 5. Order entry: the quoted part's line shows the auto-link preview BEFORE saving (spec
  //    §5.2 — the preview is display, ABSENT stays the wire state, the server resolves the
  //    same answer at save). Inlined rather than createOrderViaUi so the preview can be
  //    asserted between the part pick and the save.
  // ---------------------------------------------------------------------------------------
  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order" }).waitFor({ state: "visible" });
  await discardDraftIfOffered(page);
  await pickCombobox(page, "Customer", fixtures.quoteCustomerCode, new RegExp(`^${fixtures.quoteCustomerCode}`));
  await pickCombobox(page, "Line 1 part", fixtures.quotePartNumber, new RegExp(`^${fixtures.quotePartNumber}`));
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("10");

  await page.getByText(/Quote link \(auto\):/).waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("link", { name: `Quote #${quote.number}`, exact: true }).waitFor({ state: "visible" });
  await shot("order-entry-quote-preview");

  await page.getByText(`Rev 1 ${EM_DASH} locks at save`).first().waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const hubHeading = page.getByRole("heading", { name: /^Order #\d+/ });
  await hubHeading.waitFor({ state: "visible", timeout: 20000 });
  const headingText = (await hubHeading.textContent()) ?? "";
  const orderMatch = headingText.match(/#(\d+)/);
  assert.ok(orderMatch, `Could not parse an order number out of the hub heading "${headingText}"`);
  const order = { id: page.url().split("/").pop(), number: Number(orderMatch[1]) };

  // The hub's Lines table shows the STORED link (ruling 6) as a link to the quote.
  await page.getByRole("link", { name: `Quote #${quote.number}`, exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("order-hub-linked-quote");

  // ---------------------------------------------------------------------------------------
  // 6. Ship complete, then raise the DRAFT invoice; its one operation row names "Quote #N"
  //    and nothing needs a price (tier-1 wholesale substitution — the part has NO PartPrice,
  //    so the priced row can only be the quote's, and the amount is the quote's arithmetic in
  //    the 5A "Setup … Plus / Price per … Or / Minimum" reading: 25.00 setup + max(10 × 4.50,
  //    50.00 minimum) = 75 — the minimum beats the 45.00 unit total, and the 100-piece break is
  //    not reached).
  // ---------------------------------------------------------------------------------------
  await startNewShipment(page, ctx, fixtures.quoteCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await panel.getByLabel("Line 1 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("order-shipped");

  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readyRow = sectionByHeading(page, "Ready to invoice").locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  const invoiceCreated = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  await invoiceCreated;

  const invoiceRow = sectionByHeading(page, "Invoices").locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await invoiceRow.getByRole("link").click();
  await page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) })
    .waitFor({ state: "visible", timeout: 20000 });

  assert.equal(await page.locator("td", { hasText: "Operation" }).count(), 1,
    "the quote's single priced operation must produce exactly one OPERATION row");
  assert.equal(await page.locator("td", { hasText: "needs price" }).count(), 0,
    "the quote-priced line must resolve — the part has no PartPrice, so needs-price here would mean the link failed");
  await page.getByText(`Quote #${quote.number}`, { exact: true }).waitFor({ state: "visible" });
  const opRow = page.locator("tr").filter({ has: page.locator("td", { hasText: "Operation" }) });
  await waitForValue(opRow.getByLabel(/amount$/), "75");
  await shot("invoice-draft-quote-sourced");
  // DELIBERATELY not finalized — see the file header (close warning + closed month + close scope).

  // ---------------------------------------------------------------------------------------
  // 7. Close with a reason: the warn-and-list banner names the open, not-fully-invoiced linked
  //    order (ruling 6 — closing never re-prices; the stored link keeps pricing it).
  // ---------------------------------------------------------------------------------------
  await page.goto(`${ctx.baseURL}/quotes/${quote.id}`);
  await page.getByRole("heading", { name: /^Quote #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  const closeDialog = armPrompt(page, CLOSE_REASON);
  await page.getByRole("button", { name: "Close…", exact: true }).click();
  const closeMessage = await closeDialog;
  assert.match(closeMessage, /^Close quote #\d+\?/);
  assert.match(closeMessage, /Reason for closing \(recorded in the audit history\):/);

  await page.getByText(/1 open order\(s\) still price from this quote and are not yet fully/)
    .waitFor({ state: "visible", timeout: 15000 });
  // Scoped to the amber warning banner: the line card's own "Priced on order(s)" §5.14 indicator
  // links the SAME order number, so a page-wide link lookup resolves two elements.
  const warnBanner = page.locator("div.border-amber-300");
  await warnBanner.getByRole("link", { name: `#${order.number}`, exact: true }).waitFor({ state: "visible" });
  // Scoped to the CLOSED banner, for the same reason as the amber one above — and this scoping is
  // newly REQUIRED by #158. A page-wide lookup for the reason used to resolve one element; it now
  // resolves three, because the History panel refetches on close and shows the same text twice more
  // (the `update` row and its `closeReason: "" → …` diff). That the locator went ambiguous is the
  // fix working end to end: before this group the panel sat stale until a reload, so those two rows
  // simply were not on the page. Assert the banner, and assert the panel separately below.
  const closedBanner = page.locator("p.bg-slate-100").filter({ hasText: "Closed —" });
  await closedBanner.getByText(CLOSE_REASON).waitFor({ state: "visible" });
  // The other half, now that it is real: the panel shows the close WITHOUT a reload (#158). This is
  // the only end-to-end proof of the invalidation — the sweep cannot see an effect, and there is no
  // DOM test environment for one.
  await page.getByText(`closeReason: "" → "${CLOSE_REASON}"`, { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("quote-closed-linked-order-warning");

  // ---------------------------------------------------------------------------------------
  // 8. The §5.4 worklist: a second quote backdated into BOTH sections — follow-up date in the
  //    past AND already expired (the deliberate same-quote overlap). The closed first quote
  //    appears in neither (worklists are OPEN-only).
  // ---------------------------------------------------------------------------------------
  const quote2 = await createQuoteViaUi(page, ctx, { partNumberText: FOLLOW_UP_PART });
  await page.getByLabel("Effective", { exact: true }).fill(daysAgo(40));
  await page.getByLabel("Expires", { exact: true }).fill(daysAgo(2));
  await page.getByLabel("Follow-up", { exact: true }).fill(daysAgo(5));
  await saveQuoteForm(page, quote2.id);
  // The heading now carries the derived Expired badge (ruling 3).
  await page.getByRole("heading", { name: /^Quote #\d+.*Expired/ }).waitFor({ state: "visible", timeout: 10000 });
  await shot("quote2-backdated-expired");

  await page.goto(`${ctx.baseURL}/quotes`);
  await page.getByRole("heading", { name: "Quotes", exact: true }).waitFor({ state: "visible" });
  const followUpSection = sectionByHeading(page, /^Follow-up due/);
  const expiredSection = sectionByHeading(page, /^Expired/);
  await followUpSection.getByRole("link", { name: String(quote2.number), exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await expiredSection.getByRole("link", { name: String(quote2.number), exact: true })
    .waitFor({ state: "visible" });
  assert.equal(await followUpSection.getByRole("link", { name: String(quote.number), exact: true }).count(), 0,
    "the CLOSED first quote must not sit in the follow-up worklist");
  assert.equal(await expiredSection.getByRole("link", { name: String(quote.number), exact: true }).count(), 0,
    "the CLOSED first quote must not sit in the expired worklist");
  await shot("worklist-sections");
}

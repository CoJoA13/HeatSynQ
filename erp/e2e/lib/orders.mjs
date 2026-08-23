// Shared by the five Phase 4 flows (Task 20): keys an order through the REAL /orders/new entry
// page and lands on its hub. Unlike Phase 3's order flows (which share ctx.created's single
// order), each Phase 4 flow creates its own order(s), so this lives as a lib helper rather than
// being copy-pasted five times. Deliberately thin: customer + N part lines + quantities and Save
// — the entry page's own richer behaviours (drafts, serial ranges, warnings panel) are
// order-entry-full.mjs's job to demonstrate, not this helper's.
import { pickCombobox } from "./ui.mjs";

const EM_DASH = "—";

/**
 * A leftover autosaved draft makes /orders/new open with the "Draft from HH:MM — Resume /
 * Discard" banner instead of a blank form. createOrder clears the draft in the save's own
 * transaction, but the entry page's debounced autosave PUT can land AFTER the save committed
 * (typed-state written back a beat later), so a flow that keys two orders back-to-back — or any
 * flow running after another flow's order entry — can meet the banner. Discarding is always
 * right here: every Phase 4 flow wants a blank form.
 */
async function discardDraftIfOffered(page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  try {
    await discard.waitFor({ state: "visible", timeout: 2000 });
    await discard.click();
  } catch {
    // no banner — the normal case
  }
}

/**
 * Keys an order (customer + lines of `{ partNumber, qty }`) and returns `{ id, number }` once the
 * HUB is on screen. `expectWarnings: true` takes the save-with-warnings interstitial path (a
 * credit-hold customer's save always warns) and clicks through "Go to order".
 *
 * Never `waitForURL` (the Phase 3 trap, spec §13): the hub heading "Order #N" can only render
 * post-navigation, so waiting for it and then reading the URL is unambiguous.
 */
export async function createOrderViaUi(page, ctx, { customerCode, lines, expectWarnings = false }) {
  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order" }).waitFor({ state: "visible" });
  await discardDraftIfOffered(page);

  await pickCombobox(page, "Customer", customerCode, new RegExp(`^${customerCode}`));
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add part line" }).click();
    await pickCombobox(page, `Line ${i + 1} part`, line.partNumber, new RegExp(`^${line.partNumber}`));
    await page.getByLabel(`Line ${i + 1} quantity`, { exact: true }).fill(String(line.qty));
  }
  // The lead part's process preview ("Rev 1 — locks at save") is the signal the part state has
  // settled server-side — the same checkpoint order-entry-full.mjs waits on before saving.
  await page.getByText(`Rev 1 ${EM_DASH} locks at save`).first().waitFor({ state: "visible", timeout: 10000 });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  if (expectWarnings) {
    await page.getByText(/^Order #\d+ saved\.$/).waitFor({ state: "visible", timeout: 20000 });
    await page.getByRole("button", { name: "Go to order", exact: true }).click();
  }
  const hubHeading = page.getByRole("heading", { name: /^Order #\d+/ });
  await hubHeading.waitFor({ state: "visible", timeout: 20000 });
  const headingText = (await hubHeading.textContent()) ?? "";
  const match = headingText.match(/#(\d+)/);
  if (!match) throw new Error(`Could not parse an order number out of the hub heading "${headingText}"`);
  return { id: page.url().split("/").pop(), number: Number(match[1]) };
}

/**
 * Starts a shipment on /shipping/new for `customerId` and adds each order by id, waiting for its
 * panel (the h3 link "#N") to render. Returns nothing — the caller edits the panels and saves.
 */
export async function startNewShipment(page, ctx, customerId, orders) {
  await page.goto(`${ctx.baseURL}/shipping/new`);
  await page.getByRole("heading", { name: "New shipment" }).waitFor({ state: "visible" });
  await page.getByLabel("Customer", { exact: true }).selectOption(customerId);
  for (const order of orders) {
    await page.getByLabel("Add order", { exact: true }).selectOption(order.id);
    await page.getByRole("button", { name: "Add order", exact: true }).click();
    await page.getByRole("link", { name: `#${order.number}`, exact: true }).waitFor({ state: "visible", timeout: 15000 });
  }
}

/** The per-order panel on either shipment page, located by its h3 link text — `#N` on
 *  /shipping/new, `N-seq` (the ShipperOrder label) on /shipping/[id]. */
export function orderPanel(page, linkText) {
  return page.locator("section").filter({ has: page.getByRole("link", { name: linkText, exact: true }) });
}

/**
 * Waits for the shipment page (post-save or post-navigation) and returns
 * `{ id, shipperNumber }`. Never `waitForURL` — a `/\/shipping\/[^/?]+$/` pattern also matches
 * the literal `/shipping/new` route still on screen at the instant Save is clicked (the Phase 3
 * trap, spec §13 / task-20 brief Step 2). The "Packing List N" heading is shipment-page-only
 * content, so waiting for it and then reading the URL is unambiguous.
 */
export async function waitForShipmentPage(page) {
  const heading = page.getByRole("heading", { name: /^Packing List \d+/ });
  await heading.waitFor({ state: "visible", timeout: 20000 });
  const text = (await heading.textContent()) ?? "";
  const match = text.match(/Packing List (\d+)/);
  if (!match) throw new Error(`Could not parse a packing-list number out of "${text}"`);
  return { id: page.url().split("/").pop(), shipperNumber: Number(match[1]) };
}

/**
 * ONE order-board row, identified by its ORDER-NUMBER CELL.
 *
 * Never `page.locator("tr").filter({ has: page.getByText(String(n), { exact: true }) })` — which is
 * what all four board call sites did until #167a. That asks "does ANY cell of this row hold exactly
 * these digits", and the board prints six other bare-number columns beside the order number (PO,
 * Qty, Weight, Loads, VS #). It went red for real on 2026-08-22: `ship-partial-then-complete`'s
 * order is 100 x 10 lb + 40 x 5 lb, so its **Weight** cell reads exactly `1200`, and the moment the
 * order counter reached #1200 the filter resolved to two rows and Playwright's strict mode refused
 * both. Not a substring match — an exact match against the wrong column. Which digits are on screen
 * is ambient state; which COLUMN they sit in is not, so that is what this matches on.
 *
 * The column INDEX is read from the header rather than assumed to be the first: the board's columns
 * are user-arrangeable (a saved view reorders and hides them), so a positional guess would be one
 * more ambient assumption — the exact thing this helper exists to remove. A hidden Order # column
 * throws by name rather than silently matching nothing.
 *
 * Returns the row locator; the caller waits on it (a row that has not rendered yet is the normal
 * case immediately after a navigation).
 */
export async function boardRow(page, orderNumber) {
  // Anchored on the table that CARRIES the Order # header rather than on "the page's table"
  // (#167a fix round). `/` renders exactly one table today, so `page.locator("table thead th")`
  // was correct — and silently so: a second table on the page would have concatenated both
  // headers into one list and offset the column index, which is the same class of ambient
  // assumption this helper exists to remove. If two tables ever carry an Order # header the row
  // locator resolves across both and Playwright's strict mode says so out loud.
  const board = page.locator("table").filter({ has: page.locator("thead th", { hasText: "Order #" }) });
  const headers = board.locator("thead th");
  await headers.first().waitFor({ state: "visible", timeout: 15000 });
  // The sort indicator is part of the header's own text ("Order # ▲"), so it is stripped before
  // comparing rather than matched around.
  const labels = (await headers.allInnerTexts()).map((label) => label.replace(/[▲▼]/g, "").trim());
  const index = labels.indexOf("Order #");
  if (index < 0) {
    throw new Error(`the order board is showing no "Order #" column — headers: ${JSON.stringify(labels)}`);
  }
  return board.locator("tbody tr").filter({
    has: page.locator(`td:nth-child(${index + 1})`, { hasText: new RegExp(`^\\s*${orderNumber}\\s*$`) }),
  });
}

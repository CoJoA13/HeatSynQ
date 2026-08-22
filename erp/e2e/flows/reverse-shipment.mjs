// Flow (Round 3 Group B, #161): REVERSE a shipment — the correction for a load that has already
// been invoiced, and the only writer of `OrderStatus.REOPENED`.
//
// The route (`POST /api/shippers/[id]/reverse`) and its service have existed and been 17-test
// covered since Phase 4; until this flow there was no screen that could call either, so the whole
// reversal STORY the shipment page already knows how to tell — the #139 pair freeze, the #65 Void
// precedence, the `reversesShipperId` relationship, the board's own Reopened filter — had never once
// been reachable by a human. This walks it end to end:
//
//   1. ship an order complete, invoice it and FINALIZE — the order sits at Invoiced;
//   2. on the shipment, VOID is refused (§5.7: a finalized invoice freezes it) while REVERSE is
//      offered — the single most important assertion in this file, and the one that fails if the
//      Reverse gate is ever "tidied up" into a clone of the Void ladder beside it;
//   3. reverse it: a new packing list of negative lines, both documents frozen as a pair, and the
//      order at REOPENED — asserted on the board AND through the board's own Reopened filter,
//      which until now could never match anything;
//   4. unlock the invoice — the order settles on its ship-derived Partially shipped (never
//      Shipped: the reversal cleared the completion), and Void's blocker changes from the invoice
//      sentence to the reversal one (#65's precedence, both halves);
//   5. void the reversal — the blessed undo. The completion is restored, the order returns to
//      Shipped, and the pair unfreezes;
//   6. re-reverse. Step 5 + step 6 are literally the "void the reversal, then edit, then
//      re-reverse" instruction the server's own edit refusals print, walked with real buttons.
//
// Runs immediately after `invoice-shipped-order` and, like it, leaves its invoice UNLOCKED (a
// DRAFT has no `finalizedAt`, so it can never enter `close-month-end`'s readiness or export scope
// — see that flow's own header for why a finalized fixture invoice left in the current month is a
// trap for the flows behind it). It creates its own order against the invoicing fixture customer
// and nothing later depends on its state.
import assert from "node:assert/strict";
import { waitForValue } from "../lib/ui.mjs";
import { boardRow, createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const REVERSE_REASON =
  "E2E reverse-shipment flow: wrong parts loaded, demonstrating the reversal UX for the demo.";
const RE_REVERSE_REASON =
  "E2E reverse-shipment flow: re-reversing after voiding the first reversal, demonstrating the " +
  "correction loop the server's own edit refusals instruct.";
const UNLOCK_REASON =
  "E2E reverse-shipment flow: unlocking so the reversal pair can be corrected, demonstrating the " +
  "§5.7 escape route the disabled Void names.";
const VOID_REVERSAL_REASON =
  "E2E reverse-shipment flow: voiding the reversal, the blessed undo, for the demo.";

/**
 * A ONE-SHOT `prompt()` handler. `armPrompt` (ui.mjs) registers a PERSISTENT `page.on("dialog")`
 * listener that is never removed — fine for the flows that arm exactly one dialog per run, but this
 * flow arms FOUR on the same page (reverse, unlock, void, re-reverse) and a lingering earlier
 * listener would try to accept a later dialog a second time ("Cannot accept dialog which is already
 * handled!"). `page.once` self-removes; the `close-month-end.mjs` `armConfirmOnce` precedent, for
 * prompts instead of confirms.
 */
function armPromptOnce(page, responseText) {
  return new Promise((resolve, reject) => {
    page.once("dialog", (dialog) => {
      if (dialog.type() !== "prompt") {
        // DISMISS BEFORE REJECTING. Playwright blocks the page until a dialog is handled, so
        // rejecting while it is still open leaves the flow hanging on the next action rather than
        // failing here with the message that says what went wrong — a wrong diagnosis for whoever
        // reads the timeout. Reviewer-caught; reachable only if a `confirm` ever replaces one of
        // these four prompts, which is exactly when a clear failure matters most.
        dialog.dismiss()
          .catch(() => {})
          .finally(() => reject(new Error(`Expected a prompt dialog, got ${dialog.type()}`)));
        return;
      }
      const message = dialog.message();
      dialog.accept(responseText).then(() => resolve(message)).catch(reject);
    });
  });
}

/** Both `/invoicing`'s sections are plain `<section>`s headed by their own `<h2>` — the
 *  `invoice-shipped-order.mjs` `sectionByHeading` precedent. */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

const reverseButton = (page) => page.getByRole("button", { name: "Reverse shipment", exact: true });
const voidButton = (page) => page.getByRole("button", { name: "Void shipment", exact: true });

/**
 * Polls until `locator` is genuinely enabled.
 *
 * Not paranoia: the shipment page runs TWO independent fetches, and the heading
 * `waitForShipmentPage` waits on is gated only on the shipment detail. `usePermissions` is the
 * other, and every gate reads an in-flight (`undefined`) permission array as "no grants"
 * (src/lib/permission-ui.ts — deliberately, so a control never flashes open and then locks). So a
 * control that will settle ENABLED can legitimately render disabled for a beat after the heading
 * appears, and a one-shot `isDisabled()` read can catch that beat. The DISABLED assertions in this
 * flow need no equivalent wait: every rung this flow asserts a title for sits ABOVE the permission
 * rung in its ladder, so its verdict is the same either way.
 */
async function waitForEnabled(locator, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await locator.isDisabled())) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what} to become enabled (title: ${await locator.getAttribute("title")})`);
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

/**
 * The board, narrowed to one order by its OWN inline search box (placeholder "Order #, PO, VS #,
 * lead part, customer" — distinct from the Shell's global search, HANDOFF §5a), then asserted to
 * carry `statusText`. Returns the row locator so a caller can go on to drive the status filters.
 */
async function boardRowFor(page, ctx, orderNumber) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  await page.getByPlaceholder("Order #, PO, VS #, lead part, customer").fill(String(orderNumber));
  // #167a: narrowing by the board's own search is not enough on its own — the search matches PO,
  // VS #, lead part and customer too, so it can still return several rows, and the row picked out
  // of them must be picked by the ORDER-NUMBER CELL (e2e/lib/orders.mjs's `boardRow`), never by
  // "any cell holding these digits".
  return boardRow(page, orderNumber);
}

async function assertBoardStatus(page, ctx, orderNumber, statusText) {
  const row = await boardRowFor(page, ctx, orderNumber);
  await row.getByText(statusText, { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  return row;
}

/**
 * Waits for the REVERSAL's page after the navigate `reverseAction` fires. Never
 * `waitForShipmentPage` alone: the original's page carries a "Packing List N" heading too, so that
 * wait can be satisfied by the page we are leaving. The #139 freeze banner naming the original is
 * reversal-page-only content, so waiting for it and then reading the heading/URL is unambiguous —
 * the same reasoning `waitForShipmentPage`'s own doc comment gives for not using `waitForURL`.
 */
async function waitForReversalPage(page, originalNumber) {
  await page.getByText(new RegExp(`This is a reversal of Packing List ${originalNumber}\\b`))
    .waitFor({ state: "visible", timeout: 30000 });
  const shipment = await waitForShipmentPage(page);
  assert.notEqual(shipment.shipperNumber, originalNumber,
    "the reversal must be its OWN packing list, never the original's number reused");
  return shipment;
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- 1. An order, shipped complete. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.invCustomerCode,
    lines: [{ partNumber: fixtures.invPartNumber, qty: 10 }],
  });
  await startNewShipment(page, ctx, fixtures.invCustomerId, [order]);
  const newPanel = orderPanel(page, `#${order.number}`);
  await waitForValue(newPanel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await newPanel.getByLabel("Line 1 complete", { exact: true }).check();
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);

  // Before any invoice exists, Reverse is simply available — the base case of the gate.
  await waitForEnabled(reverseButton(page), "Reverse on a live shipment");
  assert.equal(await reverseButton(page).isDisabled(), false,
    "Reverse must be offered on a live, un-reversed shipment");
  assert.equal(await reverseButton(page).getAttribute("title"), null,
    "an available Reverse control carries no refusal title");
  await shot("shipped-reverse-available");

  // --- 2. Invoice it and FINALIZE. ---
  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readyRow = sectionByHeading(page, "Ready to invoice").locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  const created = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  await created;

  const invoiceRow = sectionByHeading(page, "Invoices").locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await invoiceRow.getByRole("link").click();
  const invoiceHeading = page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) });
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  const invoiceId = page.url().split("/").pop();
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.getByText("Finalized", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await assertBoardStatus(page, ctx, order.number, "· Invoiced");
  await shot("invoiced");

  // --- 3. THE POINT OF THIS FEATURE. On an invoiced shipment the Void is refused — and Reverse,
  // which is the correction for exactly that refusal, is offered. `reverseShipper` carries no
  // invoice guard at all (src/server/shippers.ts); a Reverse gate built by copying `voidGate`'s
  // ladder would disable the control here, in the one case it exists for. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  await waitForEnabled(reverseButton(page), "Reverse on an invoiced shipment");
  assert.equal(await voidButton(page).isDisabled(), true, "a finalized invoice must freeze the Void (§5.7)");
  const voidTitle = await voidButton(page).getAttribute("title");
  assert.match(voidTitle, /^This shipment cannot be voided — Invoice .* is finalized; unlock it or raise a credit/,
    `the Void title must be the server's own invoice refusal, got: ${voidTitle}`);
  assert.equal(await reverseButton(page).isDisabled(), false,
    "Reverse must stay AVAILABLE while a finalized invoice blocks the Void — it is the correction for it");
  assert.equal(await reverseButton(page).getAttribute("title"), null,
    "an available Reverse control carries no refusal title");
  await shot("invoiced-void-blocked-reverse-offered");

  // --- 4. Reverse it. ---
  const reversePrompt = armPromptOnce(page, REVERSE_REASON);
  await reverseButton(page).click();
  const reverseMessage = await reversePrompt;
  assert.match(reverseMessage, new RegExp(`Reverse shipment \\(Packing List ${shipment.shipperNumber}\\)\\?`));
  assert.match(reverseMessage, /Reason for reversing \(recorded in the audit history\):/);
  const reversal = await waitForReversalPage(page, shipment.shipperNumber);

  // The reversal is mirror paper: the same order line, negated.
  const reversalPanel = orderPanel(page, `${order.number}-2`);
  await waitForValue(reversalPanel.getByLabel("Line 1 ship-now quantity", { exact: true }), "-10");
  // It is frozen on BOTH the header and its own Reverse control (#139 + the gate's second rung).
  const routeField = page.getByLabel("Route", { exact: true });
  assert.equal(await routeField.evaluate((el) => el.readOnly), true,
    "a reversal is machine-generated mirror paper — its header must be read-only");
  assert.equal(await reverseButton(page).isDisabled(), true, "a reversal cannot itself be reversed");
  assert.equal(
    await reverseButton(page).getAttribute("title"),
    `This shipment is itself a reversal of Packing List ${shipment.shipperNumber} — reverse the original shipment instead`);
  // The REVERSAL's own Void, while the invoice is still finalized. `voidShipper` runs
  // `refuseIfInvoiced` over the pair's orders BEFORE its #65 blocker, and a reversal's orders are
  // its original's — so the invoice sentence wins here too, and "voiding a reversal is the blessed
  // undo" is true only once the invoice is out of the way (step 7 does that, and step 9 then voids
  // it for real). This is the half that makes #182 concrete: the pair-freeze BANNER says "void the
  // reversal first" unconditionally, while both Void buttons correctly say "unlock the invoice
  // first". Pinned here so the follow-up changes a state this flow already describes.
  assert.match(await voidButton(page).getAttribute("title"), /^This shipment cannot be voided — Invoice /,
    "the reversal's own Void must name the invoice too while it is finalized — the banner's 'void the reversal first' is one step short here (#182)");
  await shot("reversal-created");

  // --- 5. `OrderStatus.REOPENED`, reachable from a screen for the first time — and the board's
  // Reopened filter, which until this feature existed could never match anything. ---
  const reopenedRow = await assertBoardStatus(page, ctx, order.number, "· Reopened");
  await page.getByLabel("Reopened", { exact: true }).check();
  await reopenedRow.getByText("· Reopened", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("board-reopened-filter-matches");
  // ...and it is a real filter, not a no-op that shows everything: narrowing to Open drops the row.
  await page.getByLabel("Reopened", { exact: true }).uncheck();
  await page.getByLabel("Open", { exact: true }).check();
  await page.getByText("No orders match these filters.").waitFor({ state: "visible", timeout: 15000 });
  await page.getByLabel("Open", { exact: true }).uncheck();

  // --- 6. Back on the ORIGINAL: the pair is frozen, Reverse names the reversal to void first, and
  // Void still names the INVOICE — `voidShipper` checks `refuseIfInvoiced` BEFORE its reversal
  // blocker, so sending the operator at "void the reversal first" here would be an action the
  // server also refuses (the Codex PR #141 precedence). ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  await page.getByText(
    `This shipment has been reversed by Packing List ${reversal.shipperNumber} — void the reversal first, then edit, then re-reverse`,
    { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await reverseButton(page).isDisabled(), true, "an already-reversed original cannot be reversed again");
  assert.equal(
    await reverseButton(page).getAttribute("title"),
    `This shipment has already been reversed by Packing List ${reversal.shipperNumber} — void that reversal first`);
  assert.match(await voidButton(page).getAttribute("title"), /^This shipment cannot be voided — Invoice /,
    "while the invoice is finalized the Void must keep naming it, not the reversal");
  await shot("original-frozen-by-the-pair");

  // --- 7. Unlock the invoice (the step the Void title names). The order leaves the invoice-owned
  // REOPENED for its ship-derived value — Partially shipped, never Shipped, because the reversal
  // cleared the completion. ---
  await page.goto(`${ctx.baseURL}/invoicing/${invoiceId}`);
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  const unlockPrompt = armPromptOnce(page, UNLOCK_REASON);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await unlockPrompt;
  await page.getByText("Draft", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await assertBoardStatus(page, ctx, order.number, "· Partially shipped");
  await shot("invoice-unlocked-order-partially-shipped");

  // --- 8. With the invoice unfrozen, the Void's blocker becomes the REVERSAL (#65) — the second
  // rung of the same ladder, now reachable. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  assert.equal(await voidButton(page).isDisabled(), true, "an original with a live reversal cannot be voided");
  assert.equal(
    await voidButton(page).getAttribute("title"),
    `This shipment has been reversed by Packing List ${reversal.shipperNumber} — void the reversal first`);
  await shot("void-now-names-the-reversal");

  // --- 9. Void the reversal: the blessed undo. Every control on it locks — including the Reverse
  // control this feature added, which is what keeps `void-shipment.mjs`'s lock-every-control sweep
  // honest on the one document type only this flow can produce. ---
  await page.goto(`${ctx.baseURL}/shipping/${reversal.id}`);
  await waitForShipmentPage(page);
  const voidPrompt = armPromptOnce(page, VOID_REVERSAL_REASON);
  await voidButton(page).click();
  await voidPrompt;
  await page.getByText(`Voided — ${VOID_REVERSAL_REASON}`).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await reverseButton(page).isDisabled(), true, "a voided shipment locks every control (§5.6)");
  assert.equal(await reverseButton(page).getAttribute("title"), "Shipment is voided");
  const unlocked = await page.$$eval("main input, main select, main textarea, main button", (els) =>
    els.filter((el) => !(el.disabled === true || el.readOnly === true))
      .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}]`));
  assert.deepEqual(unlocked, [], `a voided reversal must lock every control; still unlocked: ${unlocked.join(", ")}`);
  await shot("reversal-voided");

  // --- 10. The original is free again — the completion restored (Shipped), the pair banner gone,
  // and Reverse offered once more. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  await waitForEnabled(reverseButton(page), "Reverse after the reversal was voided");
  await waitForEnabled(voidButton(page), "Void after the reversal was voided");
  assert.equal(await reverseButton(page).isDisabled(), false, "voiding the reversal must free the original to reverse again");
  assert.equal(await reverseButton(page).getAttribute("title"), null);
  assert.equal(await voidButton(page).isDisabled(), false, "voiding the reversal must free the original's own Void too");
  assert.equal(await page.getByText(/void the reversal first, then edit, then re-reverse/).count(), 0,
    "the pair-freeze banner must clear once the reversal is voided");
  await assertBoardStatus(page, ctx, order.number, "· Shipped");
  await shot("original-unfrozen");

  // --- 11. Re-reverse. Steps 9-11 together are the "void the reversal, then edit, then re-reverse"
  // instruction the server's own edit refusals print — every step of it now has a button. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  const rePrompt = armPromptOnce(page, RE_REVERSE_REASON);
  await reverseButton(page).click();
  await rePrompt;
  const reversal2 = await waitForReversalPage(page, shipment.shipperNumber);
  assert.ok(reversal2.shipperNumber > reversal.shipperNumber,
    "a re-reversal takes a NEW packing-list number — the voided reversal's is never reused");
  await shot("re-reversed");
}

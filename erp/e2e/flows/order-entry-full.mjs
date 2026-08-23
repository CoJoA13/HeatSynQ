// Flow 7: order entry end to end (design spec §11/§5) — the first Phase 3 flow, and the first
// caller of `lockCurrentRevision` this harness exercises through the REAL app rather than through
// db-fixtures.ts's `lockRevision` stand-in (that stand-in is what flow 3's revision-cut uses; this
// flow instead keys a genuine order through /orders/new, which is what actually locks a revision
// in production). Keys a two-line order (lead + a serialized rider, serials via the `{001-025}`
// range shorthand spec §12.6 describes), exercises the draft-resume banner mid-flow (cheap, since
// the state is already there to verify), and saves through the credit-hold warnings interstitial
// (HANDOFF issue #4 heritage: a degraded-but-successful save is shown, never raced past) onto the
// hub, where the lead line's "Lead · Rev N locked" badge is the on-screen proof the lock landed.
//
// `ctx.created.orderId`/`orderNumber` are set at the end for the three flows that follow
// (board-search-scan, loads-after-print, void-order all operate on THIS SAME order) — the
// `created.templateIds` precedent (template-build-and-load.mjs), generalized to a single id
// rather than an array since there is only ever one order across this whole run.
import assert from "node:assert/strict";
import { pickCombobox, assertNeverVisible, waitForValue } from "../lib/ui.mjs";

const EM_DASH = "—";
const MIDDOT = "·";

export async function run(page, shot, ctx) {
  const { fixtures, created } = ctx;
  const { orderCustomerCode, orderLeadPartNumber, orderRiderPartNumber } = fixtures;

  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order" }).waitFor({ state: "visible" });
  await shot("entry-blank");

  // --- Customer: picks the fixture customer that carries creditHold: true, so the eventual save
  // returns a non-empty warnings[] regardless of anything else this flow does. ---
  await pickCombobox(page, "Customer", orderCustomerCode, new RegExp(`^${orderCustomerCode}`));
  await page.getByText("is on credit hold").waitFor({ state: "visible" });
  await shot("customer-credit-hold");

  // --- Lead line (position 1): the part that will lock a revision at save. ---
  await pickCombobox(page, "Line 1 part", orderLeadPartNumber, new RegExp(`^${orderLeadPartNumber}`));
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("50");
  await page.getByText(`Rev 1 ${EM_DASH} locks at save`).waitFor({ state: "visible", timeout: 10000 });
  await shot("lead-part-picked");

  // --- Rider line (position 2): serialization-required, so it starts with the live inline
  // warning until serials are entered — the "two-line" order the brief calls for. ---
  await page.getByRole("button", { name: "Add part line" }).click();
  await pickCombobox(page, "Line 2 part", orderRiderPartNumber, new RegExp(`^${orderRiderPartNumber}`));
  await page.getByLabel("Line 2 quantity", { exact: true }).fill("20");
  await page.getByText("Serialization required — no serials entered yet.").waitFor({ state: "visible" });
  await shot("rider-needs-serials");

  // Serial range shorthand, per the brief: "{001-005}" expands to five rows (serial-range.ts).
  const addSerialInput = page.getByLabel("Line 2 add serial", { exact: true });
  await addSerialInput.fill("R{001-005}");
  await addSerialInput.press("Enter");
  await waitForValue(page.getByLabel("Line 2 serial 5", { exact: true }), "R005");
  await assertNeverVisible(
    page.getByText("Serialization required — no serials entered yet."),
    "the serialization warning should clear once 5 serials are entered",
    500,
  );
  await shot("serials-expanded");

  // --- Draft-resume, mid-flow (cheap: the state to verify is already sitting in the form). Arm
  // the wait for the debounced autosave PUT BEFORE reloading, so this doesn't race the 2s
  // debounce with a blind sleep — the harness waits for the actual network response instead. ---
  const draftSaved = page.waitForResponse((res) =>
    res.url().includes("/api/order-drafts") && res.request().method() === "PUT" && res.ok());
  await draftSaved;
  await page.reload();
  await page.getByText("Draft from", { exact: false }).waitFor({ state: "visible", timeout: 10000 });
  await shot("draft-resume-prompt");
  await page.getByRole("button", { name: "Resume" }).click();
  // Spot-check rather than re-verifying every field: the lead quantity and the last serial round
  // trip through JSON and back, which is representative of the whole draft (task-13's own unit +
  // integration coverage already proves every field shape survives this path).
  await waitForValue(page.getByLabel("Line 1 quantity", { exact: true }), "50");
  await waitForValue(page.getByLabel("Line 2 serial 5", { exact: true }), "R005");
  await shot("draft-resumed");

  // --- Save (not Save & Print — printing is loads-after-print's job) — the customer's credit
  // hold means this always returns a non-empty warnings[], so the save-with-warnings interstitial
  // fires deterministically rather than depending on some other, more fragile condition. ---
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedHeading = page.getByText(/^Order #\d+ saved\.$/);
  await savedHeading.waitFor({ state: "visible", timeout: 15000 });
  const savedText = (await savedHeading.textContent()) ?? "";
  const match = savedText.match(/#(\d+)/);
  assert.ok(match, `Could not parse an order number out of "${savedText}"`);
  await page.getByText("is on credit hold").waitFor({ state: "visible" });
  await shot("save-warnings-panel");

  await page.getByRole("button", { name: "Go to order", exact: true }).click();
  // NOT `page.waitForURL(/\/orders\/[^/?]+$/)` — that pattern also matches "/orders/new" (the
  // entry page itself, still on screen at the instant the click fires), so `waitForURL` resolved
  // against the CURRENT url immediately rather than the navigation this click triggers, and
  // `created.orderId` ended up literally `"new"` (caught live in this task's own stabilization
  // run — every later flow then landed back on the entry page and never found the hub). Waiting
  // for hub-only content sidesteps the whole ambiguity: this text can only ever render once the
  // hub has actually loaded, so reading the URL right after it appears is unambiguous.
  await page.getByText(`Lead ${MIDDOT} Rev 1 locked`).waitFor({ state: "visible", timeout: 15000 });
  // The two later flows (board-search-scan navigates by number; loads-after-print/void-order
  // navigate straight to the id) both need this — set on the SHARED `created` object exactly like
  // template-build-and-load.mjs's `created.templateIds.push(...)`, just a single id/number pair
  // rather than an array, since this run only ever creates the one order.
  created.orderId = page.url().split("/").pop();
  created.orderNumber = Number(match[1]);
  await shot("hub-lead-rev-locked");
}

// Flow 10 (last): void the order order-entry-full created, with a reason, and confirm the board
// hides it until "Include voided" is checked (design spec §5c — voided orders block nothing,
// never free their number, and leave the board unless the toggle is on). Runs last of the four
// order flows on purpose: board-search-scan needs the order live to find it, and once this flow
// voids it there is nothing left for a later flow to build on.
import assert from "node:assert/strict";
import { armPrompt, assertNeverVisible } from "../lib/ui.mjs";
import { boardRow } from "../lib/orders.mjs";

const REASON = "E2E void-order flow: intentional test void, demonstrating the void UX for the demo.";

export async function run(page, shot, ctx) {
  const { created } = ctx;
  assert.ok(
    created.orderId && created.orderNumber,
    "void-order requires order-entry-full to have set ctx.created.orderId/orderNumber",
  );

  await page.goto(`${ctx.baseURL}/orders/${created.orderId}`);
  await page.getByRole("heading", { name: `Order #${created.orderNumber}` }).waitFor({ state: "visible" });
  await shot("hub-before-void");

  const dialogMessage = armPrompt(page, REASON);
  await page.getByRole("button", { name: "Void order" }).click();
  const message = await dialogMessage;
  assert.match(message, new RegExp(`Void order #${created.orderNumber}\\?`));
  assert.match(message, /Reason for voiding \(recorded in the audit history\):/);

  // The voided banner surfaces in TWO stages, three sequential requests deep: the DELETE commits the
  // void, then load() reflips `voided` and the banner appears reading "Voided — see History for the
  // reason", then a SEPARATE admin-audit read (the page effect keyed on `voided`) resolves the
  // recorded reason and the banner becomes "Voided — <reason>". So the exact-reason text is gated on
  // the whole chain landing, and on a loaded CI runner the audit leg alone can push it past a few
  // seconds. Wait for the banner to appear at all first (the void itself committed and reloaded), then
  // for the reason to resolve — two checkpoints so a genuine void regression reports distinctly from a
  // slow/absent audit read. Both inherit the context-wide 45s budget (run.mjs setDefaultTimeout); the
  // prior single wait pinned an explicit 10s cap TIGHTER than that default and occasionally tripped it
  // on a void that had in fact fully succeeded (#190 — the recurring void-order flake).
  await page.getByText("Voided —").waitFor({ state: "visible" });
  await page.getByText(`Voided — ${REASON}`).waitFor({ state: "visible" });
  await shot("hub-voided");

  // Board: a voided order leaves the list by default (spec §5c).
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  // #167a fix round: this was the FIFTH board locator and the only one that could pass while
  // WRONG. `page.locator("tr", { hasText: n })` is a substring match over every cell, and it sat
  // inside an `assert.rejects` — so a voided row still on the board plus one ambient cell holding
  // the same digits is two matches, a strict-mode violation, a rejected promise and a PASS. Both
  // halves are fixed: `boardRow` matches the order-number CELL, and `assertNeverVisible` requires
  // the rejection to be the timeout rather than accepting any rejection at all.
  //
  // `boardRow` is awaited OUTSIDE the absence assertion on purpose: it reads the table header, and
  // a board rendering no "Order #" column must fail loudly rather than be swallowed as "absent".
  const hiddenRow = await boardRow(page, created.orderNumber);
  await assertNeverVisible(
    hiddenRow,
    "a voided order should not appear on the board while Include voided is off",
  );
  await shot("board-hides-voided");

  await page.getByRole("checkbox", { name: "Include voided" }).check();
  const row = await boardRow(page, created.orderNumber);
  // Inherit the 45s context default (run.mjs) rather than a tighter explicit cap — same reasoning as
  // the void banner above: this waits out a fresh navigation plus a board re-render on a shared runner.
  await row.waitFor({ state: "visible" });
  // A voided row renders the plain word "Voided" in place of the colored light dot + status —
  // board-search-scan already confirmed the dot for this SAME order while it was still live.
  await assertNeverVisible(row.locator("span.rounded-full"), "a voided row should show no colored light", 1000);
  await row.getByText("Voided", { exact: true }).waitFor({ state: "visible" });
  await shot("board-shows-with-include-voided");
}

// Flow 9: print the traveler, watch the documents archive grow, then edit the order's one
// auto-split load and confirm the "already printed" nudge (design spec §5b/§5.4 — loads stay
// editable after a traveler prints, owner ruling §3.3; the nudge is advisory, never a block).
//
// The fixture lead part (db-fixtures.ts) leaves loadQty/loadWeight both null, so splitLoads
// (src/lib/load-split.ts) returns exactly ONE load covering the order's full qty/weight — this
// flow edits THAT one row rather than juggling several.
//
// Printing calls `window.open(url, "_blank")` on the freshly rendered PDF (DocumentsSection.tsx).
// Whether that succeeds or gets blocked depends on this environment's popup policy for a call
// that happens after an `await fetch(...)` rather than synchronously inside the click — the app's
// own fallback banner covers the blocked case, and this flow doesn't assert which branch fires
// (best-effort: capture a popup if one appears, for a bonus screenshot). What IS asserted, either
// way, is the one thing both branches guarantee: the documents table gains a row with a working
// `/api/documents/[id]` link, which this flow fetches directly (same session, via the page's request context)
// to archive `traveler.pdf` alongside the numbered screenshots — the source for the demo doc's
// "printed traveler PDF page" screenshot (rendered to PNG afterward with a local PDF tool; the
// flow itself only touches portable Node/Playwright APIs, no new system dependency).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function run(page, shot, ctx) {
  const { created } = ctx;
  assert.ok(created.orderId, "loads-after-print requires order-entry-full to have set ctx.created.orderId");

  await page.goto(`${ctx.baseURL}/orders/${created.orderId}`);
  await page.getByRole("heading", { name: `Order #${created.orderNumber}` }).waitFor({ state: "visible" });
  await page.getByText("Nothing printed yet.").waitFor({ state: "visible" });
  await shot("hub-before-print");

  const popupPromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);

  await page.getByRole("button", { name: "Print traveler" }).click();
  const travelerLink = page.getByRole("link", { name: "Traveler" }).first();
  await travelerLink.waitFor({ state: "visible", timeout: 20000 });
  const docsShotPath = await shot("documents-list-grown");
  const flowDir = path.dirname(docsShotPath);

  // Best-effort popup screenshot — see the top-of-file comment on why this isn't asserted either
  // way. `close()` afterward so a rendered popup doesn't linger and confuse the next `waitForEvent`
  // this same context might see (none in this flow, but cheap to be tidy).
  const popup = await popupPromise;
  if (popup) {
    try {
      await popup.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
      await popup.waitForTimeout(500); // let a PDF viewer, if any, finish painting
      await popup.screenshot({ path: path.join(flowDir, "printed-traveler-popup.png") }).catch(() => {});
    } finally {
      await popup.close().catch(() => {});
    }
  }

  // Archive the actual PDF bytes regardless of the popup outcome — the page's request context shares
  // the logged-in page's cookies, so this GET is authenticated the same way clicking the link would be.
  const docHref = await travelerLink.getAttribute("href");
  assert.match(docHref ?? "", /^\/api\/documents\/[^/]+$/, "the archived row links to /api/documents/[id]");
  const pdfResp = await page.request.get(new URL(docHref, ctx.baseURL).toString());
  // #233 item 3: this GET's response was never checked, so the header's "a working
  // /api/documents/[id] link, which this flow fetches directly" was a claim the flow did not
  // verify — a 404 or 500 wrote its error body to traveler.pdf and the flow passed. Assert the
  // link WORKS, which is what the header promises and the one guarantee both popup branches share.
  assert.equal(pdfResp.status(), 200, "the archived traveler link serves the stored PDF");
  const pdfBytes = await pdfResp.body();
  assert.ok(pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-", "the archived bytes are a PDF");
  await fs.writeFile(path.join(flowDir, "traveler.pdf"), pdfBytes);

  // Edit the order's one load — its aria-label is "Load 1 ..." (splitLoads returns a single
  // qty-70/weight-550 load here; loadNumber is always 1-based).
  await page.getByLabel("Load 1 weight", { exact: true }).fill("999.99");
  await page.getByRole("button", { name: "Save loads" }).click();
  await page.getByText("A traveler has already printed — print a fresh one").waitFor({ state: "visible", timeout: 10000 });
  await shot("amber-printed-warning");
}

// Flow 12 (Phase 4, Task 20): one shipment covering two orders (design spec §13.2) — the
// emergent multi-order shipment (owner ruling §3.10: several orders on one truck is one shipment
// with one ship-to; there is no MOS layout, §3.20 — the tickets stay one sheet per order and the
// BOL is the one multi-order document). Prints the tickets (asserting the archived PDF really
// carries TWO sheets via the uncompressed /Count page marker) and the BOL, and confirms BOTH
// order hubs list the same stored documents.
//
// This flow is also the durable browser recapture of the Task 14 shipment page (its original
// browser verification was lost in the machine move; both fix rounds were code-verified only):
// a two-order shipment rendered as one panel per order, and a LINE EDIT through the edit page's
// grid (PUT …/lines) round-tripping through the server.
//
// The tail end pins the Task 19 fix-round contract (§9 amendment 2026-08-05) in a real browser:
// after this order's only cert is VOIDED, printing tickets with the cert checkbox still ticked
// prints the tickets and WARNS — x-print-warnings decoded and rendered amber — never refuses.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { armPrompt, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";

const CERT_VOID_REASON = "E2E multi-order flow: voiding the cert to demonstrate the print-time missing-cert warning.";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Two orders for the same customer: C carries the cert-required part (its ORDER-scope cert
  // is created by the order save itself, spec §6.2), D a plain part. ---
  const orderC = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.certPartNumber, qty: 12 }],
  });
  const orderD = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 10 }],
  });

  // --- One shipment, both orders (each at its full prefilled remainder). ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [orderC, orderD]);
  await shot("two-order-panels");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);
  // One panel per order, each labeled with its own never-reused sequence (spec §4.2).
  await page.getByRole("link", { name: `${orderC.number}-1`, exact: true }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: `${orderD.number}-1`, exact: true }).waitFor({ state: "visible" });
  await shot("shipment-saved");

  // --- Line edit through the EDIT page's grid (the Task 14 recapture): ship 8 of D's 10. ---
  const panelD = orderPanel(page, `${orderD.number}-1`);
  await panelD.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("8");
  await panelD.getByLabel("Line 1 ship-now weight", { exact: true }).fill("80");
  const linesSaved = page.waitForResponse((res) =>
    res.url().includes("/lines") && res.request().method() === "PUT" && res.ok());
  await panelD.getByRole("button", { name: "Save lines", exact: true }).click();
  await linesSaved;
  // The grid re-composes from the server's own fresh response — the round-tripped value.
  await waitForValue(panelD.getByLabel("Line 1 ship-now quantity", { exact: true }), "8");
  await shot("line-edited");

  // --- Print all tickets (cert checkbox is pre-ticked, §3.14). The whole-set ticket archives as
  // ONE document scoped "Whole shipment"; order C's cert archives as its own CERT document
  // (surfaced via the info line — cert documents live on the cert page and the order hubs, not
  // in the shipment's own list). ---
  const popup1 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print all tickets", exact: true }).click();
  const ticketLink = page.getByRole("link", { name: "Shipping ticket", exact: true }).first();
  await ticketLink.waitFor({ state: "visible", timeout: 30000 });
  await page.getByText(/1 certification archived/).waitFor({ state: "visible" });
  await page.getByText("Whole shipment", { exact: true }).waitFor({ state: "visible" });
  const shotPath = await shot("tickets-printed");
  const flowDir = path.dirname(shotPath);
  await (await popup1)?.close().catch(() => {});

  // Two orders on the truck = two ticket sheets in the one archived PDF (§3.20: one ticket per
  // order, never a merged MOS sheet). The page-tree "/Count 2" marker is written uncompressed by
  // this PDF stack (the P3 test technique), so it is grep-able straight off the stored bytes.
  const ticketHref = await ticketLink.getAttribute("href");
  const ticketPdf = await (await page.request.get(new URL(ticketHref, ctx.baseURL).toString())).body();
  assert.ok(ticketPdf.subarray(0, 5).toString() === "%PDF-", "the stored ticket document must be a PDF");
  assert.match(ticketPdf.toString("latin1"), /\/Count 2/,
    "the whole-set ticket PDF must carry exactly two sheets (one per order)");
  await fs.writeFile(path.join(flowDir, "tickets.pdf"), ticketPdf);

  // --- Print the BOL: lazily allocates the BOL number (§3.19), archives as its own document. ---
  const popup2 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print BOL", exact: true }).click();
  const bolLink = page.getByRole("link", { name: "Bill of lading", exact: true }).first();
  await bolLink.waitFor({ state: "visible", timeout: 30000 });
  await (await popup2)?.close().catch(() => {});
  const bolPdf = await (await page.request.get(new URL(await bolLink.getAttribute("href"), ctx.baseURL).toString())).body();
  await fs.writeFile(path.join(flowDir, "bol.pdf"), bolPdf);
  // The heading's "· BOL N" badge reads the shipper state loaded at page load — reload to see
  // the just-allocated number.
  await page.reload();
  await waitForShipmentPage(page);
  await page.getByText(/· BOL \d+/).waitFor({ state: "visible" });
  await shot("bol-printed");

  // --- Both order hubs list the SAME stored documents (the §8 union: a shipment's documents
  // surface on every order it covers). The hub's generic list renders non-traveler kinds by
  // their raw kind name. ---
  await page.goto(`${ctx.baseURL}/orders/${orderC.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  const bolOnC = page.getByRole("link", { name: "BOL", exact: true });
  await bolOnC.waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("link", { name: "SHIPPER", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "CERT", exact: true }).waitFor({ state: "visible" });
  const bolHrefOnC = await bolOnC.getAttribute("href");
  await shot("hub-c-documents");

  await page.goto(`${ctx.baseURL}/orders/${orderD.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  const bolOnD = page.getByRole("link", { name: "BOL", exact: true });
  await bolOnD.waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("link", { name: "SHIPPER", exact: true }).waitFor({ state: "visible" });
  assert.equal(await bolOnD.getAttribute("href"), bolHrefOnC,
    "both hubs must list the SAME stored BOL document, not two copies");
  // D's Shipments section names its own slice of the shared shipment.
  await page.getByRole("link", { name: `${orderD.number}-1`, exact: true }).waitFor({ state: "visible" });
  await page.getByText("(+1 other order)", { exact: true }).waitFor({ state: "visible" });
  await shot("hub-d-documents");

  // --- The Task 19 pin: void order C's cert, then print tickets WITH the cert box ticked. The
  // tickets print and the §9-amended warning arrives via x-print-warnings, rendered amber. ---
  await page.goto(`${ctx.baseURL}/orders/${orderC.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  // The Certifications section row links to the cert by its scope label ("By order").
  await page.getByRole("link", { name: "By order", exact: true }).click();
  await page.getByRole("heading", { name: /^Certification #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  const certPrompt = armPrompt(page, CERT_VOID_REASON);
  await page.getByRole("button", { name: "Void certification", exact: true }).click();
  assert.match(await certPrompt, /Void certification #\d+\?/);
  await page.getByText(`Voided — ${CERT_VOID_REASON}`).waitFor({ state: "visible", timeout: 10000 });
  await shot("cert-voided");

  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  const popup3 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print all tickets", exact: true }).click();
  await page.getByText(/requires a certification and none exists to print/).waitFor({ state: "visible", timeout: 30000 });
  await page.getByText(/its ticket printed without one/).waitFor({ state: "visible" });
  await (await popup3)?.close().catch(() => {});
  await shot("print-warns-missing-cert");
}

// Round 3 Group B (#165): raising a certification BY HAND, at a scope the operator chooses.
//
// Two of the three cert-creation routes had no screen able to call them. `POST /api/certs` — the
// ORDER-scope surface — had no client reference anywhere in the application, and SHIPMENT scope
// had no route at all: `POST /api/certs` is `.strict()` and deliberately omits `shipperId`, so it
// "structurally cannot produce a SHIPMENT-scope cert" (its own docblock). The fix keeps that
// decision and routes around it — `POST /api/shippers/[id]/certs` resolves the shipper FROM ITS
// PATH, the way `POST /api/orders/[id]/certs` already resolves the order for LOAD scope.
//
// This flow drives both from the order hub's Certifications section: raise the ORDER-scope cert
// on an order whose part requires none (the "a missed certificate must be raisable by hand" case
// the owner ruled on), ship it, raise the SHIPMENT-scope cert against the real shipment, and hit
// the collision on each — where the point is not the refusal but what sits beside it. A blind
// create used to collide with an eagerly-created cert and say only "This order already has a
// certification for that scope", naming nothing the operator could open. It now names the live
// cert and links to it (§5.14).
//
// The picker's SHIPMENT options are derived from this order's LIVE shipments, so the flow also
// pins the negative: before anything has shipped, there is no shipment target to pick.
import assert from "node:assert/strict";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";
import { waitForValue } from "../lib/ui.mjs";

const PICKER = "#cert-raise-target";

/** The one create control, and the response its click must produce. `expectOk` false is the
 *  collision path — a 400 is the point there, so `waitForResponse` must not require `ok()`. */
async function raise(page, pathname, expectOk) {
  const settled = page.waitForResponse((res) =>
    new URL(res.url()).pathname === pathname
    && res.request().method() === "POST"
    && (expectOk ? res.ok() : res.status() === 400));
  await page.getByRole("button", { name: "Create certification", exact: true }).click();
  await settled;
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- An order whose part needs NO certification (certRequired: false on the fixture part), so
  // order save mints nothing: every cert below is one this surface raised. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 10 }],
  });
  await page.getByText("None — this order does not require a certification.").waitFor({ state: "visible", timeout: 15000 });

  // --- The picker offers this order, and — nothing having shipped — no shipment. The shipments
  // GET is awaited explicitly so the absence is a settled fact, not a race. ---
  const shipmentsListed = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/orders/${order.id}/shipments`
    && res.request().method() === "GET" && res.ok());
  await page.reload();
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 20000 });
  await shipmentsListed;
  await page.locator(PICKER).waitFor({ state: "visible" });
  assert.equal(
    await page.locator(`${PICKER} option[value="ORDER"]`).count(), 1,
    "the scope picker must offer this order as a target",
  );
  assert.equal(
    await page.locator(`${PICKER} option[value^="SHIPMENT:"]`).count(), 0,
    "nothing has shipped yet, so there is no shipment-scope target to offer",
  );
  await shot("picker-before-shipping");

  // --- ORDER scope by hand: POST /api/certs, which had no caller in the application at all. ---
  await page.locator(PICKER).selectOption("ORDER");
  await raise(page, "/api/certs", true);
  await page.getByRole("link", { name: "By order", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("order-scope-raised");

  // --- The same target again: refused by the service (uniqueness lives under the order claim,
  // never in this screen), and the screen now names WHICH cert is in the way. ---
  await raise(page, "/api/certs", false);
  await page.getByText("This order already has a certification for that scope").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("A live certification already covers this order.").waitFor({ state: "visible", timeout: 10000 });
  const openIt = page.getByRole("link", { name: "Open it", exact: true });
  await openIt.waitFor({ state: "visible" });
  const orderCertHref = await openIt.getAttribute("href");
  assert.match(
    orderCertHref ?? "", /^\/certs\/.+/,
    `the collision notice must link to the cert that is blocking — got "${orderCertHref}"`,
  );
  await shot("order-scope-collision-named");

  // --- Ship the order in full, so a real shipment exists to certify. ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);

  // --- SHIPMENT scope by hand, against the new route. The picker's option carries the shipment's
  // OWN id — the id the route then reads off its path, never off a body. ---
  await page.goto(`${ctx.baseURL}/orders/${order.id}`);
  await page.getByRole("heading", { name: `Order #${order.number}` }).waitFor({ state: "visible", timeout: 20000 });
  const shipmentOption = page.locator(`${PICKER} option[value="SHIPMENT:${shipment.id}"]`);
  await shipmentOption.waitFor({ state: "attached", timeout: 15000 });
  assert.equal(
    (await shipmentOption.textContent())?.trim(), `By shipment — Shipper #${shipment.shipperNumber}`,
    "the shipment target must be named by its packing-list number",
  );
  await page.locator(PICKER).selectOption(`SHIPMENT:${shipment.id}`);
  await shot("picker-with-shipment");

  await raise(page, `/api/shippers/${shipment.id}/certs`, true);
  await page.getByRole("link", { name: "By shipment", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  // The section's own subject column resolves the cert back to the shipment it certifies.
  await page.getByText(`Shipper #${shipment.shipperNumber}`, { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await shot("shipment-scope-raised");

  // --- And its collision names the SHIPMENT, not merely "this order" — the two live certs on
  // this order are different scope instances, and the notice has to tell them apart. ---
  await raise(page, `/api/shippers/${shipment.id}/certs`, false);
  await page.getByText(`A live certification already covers Shipper #${shipment.shipperNumber}.`)
    .waitFor({ state: "visible", timeout: 10000 });
  const shipmentCertHref = await page.getByRole("link", { name: "Open it", exact: true }).getAttribute("href");
  assert.notEqual(
    shipmentCertHref, orderCertHref,
    "the notice must link to the SHIPMENT-scope cert, not to the order-scope one raised earlier",
  );
  await shot("shipment-scope-collision-named");
}

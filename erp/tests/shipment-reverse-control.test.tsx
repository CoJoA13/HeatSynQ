import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReverseShipmentButton, reverseGate, type ShipperDetail } from "@/app/shipping/[id]/ShipmentDetail";

// #161: the shipment page grew a Reverse control beside Void. This pins its GATE — the reason each
// rung fires, and that the reason reaches the rendered `disabled` attribute.
//
// **The whole point of this file is the second test.** `voidGate` (the control beside this one) is a
// four-rung ladder whose second rung is `invoiceVoidBlock`: a finalized invoice freezes the shipment
// against a VOID. Reversal is the correction for exactly that situation — `reverseShipper`
// (src/server/shippers.ts:2106) carries no invoice guard at all, and its own suite finalizes an
// invoice and then reverses, which is what writes `Order.status = REOPENED`
// (tests/shipper-reverse.test.ts:134). A cloned ladder would disable Reverse in the one case it
// exists for and would look correct in review, because it would match the button beside it.
//
// No DOM env here (vitest.config.ts is `environment: "node"`), so the CLICK is Playwright's
// (e2e/flows/reverse-shipment.mjs). Initial render is not: the `receivables-void-control` /
// `loads-section` precedent renders to static markup, which is why `ReverseShipmentButton` is split
// out of the page at all.

const PERMS_WITH_ACTION = ["shipping.view", "shipping.edit", "action.void_shipper"];
/** Every shipping CRUD grant there is, and NOT the special action — the route runs
 *  `mustDo(user, "void_shipper")`, so none of these substitutes for it. */
const PERMS_WITHOUT_ACTION = ["shipping.view", "shipping.create", "shipping.edit", "shipping.delete"];

function shipment(over: Partial<ShipperDetail> = {}): ShipperDetail {
  return {
    id: "shp-1", shipperNumber: 5001, bolNumber: null,
    customerId: "cus-1", customerCode: "ACME", customerName: "Acme Heat",
    customerCreditHold: false,
    shipToAddressId: null, shipDate: "2026-08-04",
    carrierId: null, carrierName: null, route: "", comments: "",
    billFreight: false, freightAmount: null, freightTerms: "PREPAID",
    freightClass: "", freightDescription: "", packageCount: null,
    proNumber: "", scacCode: "",
    reversesShipperId: null, reversesShipperNumber: null,
    reversedByShipperNumber: null,
    invoiceVoidBlock: null,
    deletedAt: null,
    orders: [],
    ...over,
  };
}

/** The §5.7 invoice freeze exactly as `invoiceBlockMessage` words it server-side — the sentence the
 *  Void button beside this one shows, and the one this control must IGNORE. */
const INVOICE_BLOCK =
  "This shipment cannot be voided — Invoice 300 is finalized; unlock it or raise a credit (see /invoicing/inv-1)";

function render(perms: string[] | undefined, detail: ShipperDetail, busy = false): string {
  return renderToStaticMarkup(
    <ReverseShipmentButton gate={reverseGate(perms, detail)} busy={busy} onClick={() => {}} />,
  );
}

/** The button's own opening tag, so `disabled`/`title` are read off the control rather than off any
 *  attribute anywhere in the markup. Also asserts the control is RENDERED — §5.16 is
 *  disabled-with-the-reason, never hidden. */
function buttonTag(html: string): string {
  const at = html.indexOf(">");
  expect(html.startsWith("<button")).toBe(true);
  return html.slice(0, at + 1);
}

/**
 * Is the button REALLY disabled — the attribute, not the word?
 *
 * `toContain("disabled")` is vacuous here: the Tailwind classes are
 * `disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400`, so the word is in
 * every render, enabled or not, and the substring form would pass with the whole gate deleted. React
 * SSR emits a true boolean attribute as `disabled=""` (receivables-void-control.test.tsx's own
 * lesson, kept verbatim).
 */
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

const titleOf = (tag: string) => tag.match(/\stitle="([^"]*)"/)?.[1];

describe("the Reverse control's gate (#161)", () => {
  it("renders ENABLED on a live shipment when the caller holds void_shipper", () => {
    const tag = buttonTag(render(PERMS_WITH_ACTION, shipment()));
    expect(isDisabled(tag)).toBe(false);
    expect(titleOf(tag)).toBe(undefined);
  });

  // THE TRAP. A finalized invoice is what `invoiceVoidBlock` reports, and it is precisely the
  // situation reversal exists to correct.
  it("stays ENABLED when a finalized invoice blocks the VOID beside it", () => {
    const tag = buttonTag(render(PERMS_WITH_ACTION, shipment({ invoiceVoidBlock: INVOICE_BLOCK })));
    expect(isDisabled(tag)).toBe(false);
    expect(tag).not.toContain("cannot be voided");
    // And the block is not merely absent from the title — it is absent from the DECISION.
    expect(reverseGate(PERMS_WITH_ACTION, shipment({ invoiceVoidBlock: INVOICE_BLOCK })))
      .toEqual(reverseGate(PERMS_WITH_ACTION, shipment()));
  });

  // The rung `e2e/flows/void-shipment.mjs` depends on: that flow sweeps EVERY `main button` on a
  // voided shipment and asserts the unlocked set is empty, so a present-but-enabled Reverse control
  // reds a flow this feature does not otherwise touch.
  it("is DISABLED on a voided shipment, naming the void", () => {
    const tag = buttonTag(render(PERMS_WITH_ACTION, shipment({ deletedAt: "2026-08-05T10:00:00.000Z" })));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe("Shipment is voided");
  });

  it("is DISABLED on a reversal document, naming the original to reverse instead", () => {
    const tag = buttonTag(render(PERMS_WITH_ACTION,
      shipment({ reversesShipperId: "shp-0", reversesShipperNumber: 5000 })));
    expect(isDisabled(tag)).toBe(true);
    // `reverseShipperInTx` step 3's own operative wording (shippers.ts:1948).
    expect(titleOf(tag)).toBe(
      "This shipment is itself a reversal of Packing List 5000 — reverse the original shipment instead");
  });

  it("is DISABLED on an already-reversed original, naming the reversal to void first", () => {
    const tag = buttonTag(render(PERMS_WITH_ACTION, shipment({ reversedByShipperNumber: 5002 })));
    expect(isDisabled(tag)).toBe(true);
    // Verbatim `reverseShipperInTx` step 3b (shippers.ts:1963-1965), so title and 400 cannot drift.
    expect(titleOf(tag)).toBe(
      "This shipment has already been reversed by Packing List 5002 — void that reversal first");
  });

  it("is DISABLED without the void_shipper action — no shipping.* CRUD grant substitutes", () => {
    const tag = buttonTag(render(PERMS_WITHOUT_ACTION, shipment()));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe("Requires void_shipper");
  });

  it("is DISABLED while the permission fetch is still in flight (permissions undefined)", () => {
    const tag = buttonTag(render(undefined, shipment()));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe("Requires void_shipper");
  });

  // A VOIDED reversal is both things at once. The voided rung must win, or the sweep above breaks on
  // exactly the document this feature creates.
  it("puts the voided rung FIRST on a voided reversal", () => {
    const tag = buttonTag(render(PERMS_WITH_ACTION, shipment({
      reversesShipperId: "shp-0", reversesShipperNumber: 5000, deletedAt: "2026-08-05T10:00:00.000Z",
    })));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe("Shipment is voided");
  });

  it("disables itself while a reversal is in flight, and says so", () => {
    const html = render(PERMS_WITH_ACTION, shipment(), true);
    expect(isDisabled(buttonTag(html))).toBe(true);
    expect(html).toContain("Reversing…");
  });

  it("labels itself 'Reverse shipment' at rest", () => {
    expect(render(PERMS_WITH_ACTION, shipment())).toContain("Reverse shipment");
  });
});

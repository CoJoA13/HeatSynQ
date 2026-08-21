import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CertificationsSection, coveringCert, coverageNotice, parseTarget, targetKey,
  type CertRow,
} from "@/app/orders/[id]/CertificationsSection";

/**
 * #165: the hub's by-hand cert raise. Initial render only — `vitest.config.ts` sets
 * `environment: "node"`, so there is no jsdom and no events; a CLICK and anything that needs a
 * fetch to land belong to the Playwright flow (`e2e/flows/cert-scope-create.mjs`). What IS
 * testable here is props-in/markup-out — which targets the picker offers, and whether the create
 * control is disabled WITH ITS REASON — plus the pure helpers behind the §5.14 collision notice
 * (the `receivables-void-control.test.tsx` precedent).
 */

const gate = (allowed: boolean, title?: string) => ({ allowed, disabled: !allowed, title });
const ALLOWED = gate(true);

const LOADS = [
  { id: "load-1", loadNumber: 1, qty: 5, weight: 50 },
  { id: "load-2", loadNumber: 2, qty: 5, weight: 50 },
];

function render(opts: {
  createGate?: ReturnType<typeof gate>;
  shipmentsGate?: ReturnType<typeof gate>;
} = {}): string {
  return renderToStaticMarkup(
    <CertificationsSection
      orderId="order-1" loads={LOADS} certRequired certScope="LOAD"
      viewGate={ALLOWED}
      createGate={opts.createGate ?? ALLOWED}
      shipmentsGate={opts.shipmentsGate ?? ALLOWED}
    />,
  );
}

/** The Create control's own opening tag, so `disabled`/`title` are read off the button rather
 *  than off any attribute anywhere in the section (the picker beside it is disabled too). */
function createButtonTag(html: string): string {
  const at = html.indexOf(">Create certification<");
  expect(at).toBeGreaterThan(-1);      // rendered, never hidden (§5.16)
  return html.slice(html.lastIndexOf("<button", at), at + 1);
}

/**
 * The attribute, not the word. The button's Tailwind classes include
 * `disabled:cursor-not-allowed disabled:bg-slate-400`, so `toContain("disabled")` is true of
 * every render, enabled or not, and would pass with the gate deleted. React SSR emits a true
 * boolean attribute as `disabled=""`.
 */
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

describe("the hub's scope picker (#165)", () => {
  it("offers an order target and one per load, by their real option values", () => {
    const html = render();
    // `[ >]`-anchored, not a bare substring: React marks the selected option with `selected=""`,
    // so `<option value="ORDER">` matches nothing while `value="ORDER"` alone would also match a
    // `LOAD:` key that merely started with it.
    expect(html).toMatch(/<option value="ORDER"[ >]/);
    expect(html).toMatch(/<option value="LOAD:1"[ >]/);
    expect(html).toMatch(/<option value="LOAD:2"[ >]/);
    // SHIPMENT targets come from a fetch, which SSR never runs — proven end to end by the flow.
    expect(html).not.toContain('value="SHIPMENT:');
  });

  it("renders the create control enabled when certs.create is held", () => {
    const tag = createButtonTag(render());
    expect(isDisabled(tag)).toBe(false);
  });

  it("renders it DISABLED, naming the reason, when the gate refuses", () => {
    // The exact shape the page hands down for a voided order (`voidLocked`), which is also how a
    // missing certs.create arrives — one gate, one title, §5.16's disabled-with-the-reason.
    const tag = createButtonTag(render({ createGate: gate(false, "Order is voided") }));
    expect(isDisabled(tag)).toBe(true);
    expect(tag).toContain("Order is voided");
  });

  it("says WHY shipment targets are missing rather than looking like nothing shipped", () => {
    const html = render({ shipmentsGate: gate(false, "Requires shipping.view") });
    expect(html).toContain("Shipment-scope targets are not listed");
    expect(html).toContain("Requires shipping.view");
    expect(render()).not.toContain("Shipment-scope targets are not listed");
  });
});

describe("coveringCert — the §5.14 identification behind a collision", () => {
  const row = (over: Partial<CertRow>): CertRow => ({
    id: "cert-1", scope: "ORDER", loadNumber: null, shipperId: null, shipperNumber: null,
    sequence: null, printedAt: null, deletedAt: null,
    readingCount: 0, passedCount: 0, failCount: 0, ...over,
  });

  it("finds the live order-scope cert", () => {
    const live = row({ id: "live" });
    expect(coveringCert([live], { scope: "ORDER" })?.id).toBe("live");
  });

  it("ignores a VOIDED cert — voiding is exactly how the operator frees the scope instance", () => {
    const voided = row({ id: "voided", deletedAt: "2026-08-20T00:00:00.000Z" });
    expect(coveringCert([voided], { scope: "ORDER" })).toBeUndefined();
  });

  it("matches a load only by its own number", () => {
    const one = row({ id: "load-1-cert", scope: "LOAD", loadNumber: 1 });
    expect(coveringCert([one], { scope: "LOAD", loadNumber: 1 })?.id).toBe("load-1-cert");
    expect(coveringCert([one], { scope: "LOAD", loadNumber: 2 })).toBeUndefined();
  });

  it("matches a shipment by its shipper id, never merely by being shipment-scoped", () => {
    const a = row({ id: "ship-a-cert", scope: "SHIPMENT", shipperId: "ship-a", shipperNumber: 1042 });
    expect(coveringCert([a], { scope: "SHIPMENT", shipperId: "ship-a" })?.id).toBe("ship-a-cert");
    expect(coveringCert([a], { scope: "SHIPMENT", shipperId: "ship-b" })).toBeUndefined();
  });

  it("names the scope instance the way the rest of the section does", () => {
    expect(coverageNotice(row({}))).toBe("A live certification already covers this order.");
    expect(coverageNotice(row({ scope: "LOAD", loadNumber: 3 })))
      .toBe("A live certification already covers Load 3.");
    expect(coverageNotice(row({ scope: "SHIPMENT", shipperId: "s", shipperNumber: 1042 })))
      .toBe("A live certification already covers Shipper #1042.");
  });
});

describe("targetKey / parseTarget", () => {
  it("round-trips every scope instance", () => {
    for (const target of [
      { scope: "ORDER" } as const,
      { scope: "LOAD", loadNumber: 7 } as const,
      { scope: "SHIPMENT", shipperId: "cm-abc" } as const,
    ]) {
      expect(parseTarget(targetKey(target))).toEqual(target);
    }
  });

  it("returns null for a key it did not emit — never a silent fallback to ORDER", () => {
    for (const key of ["", "nonsense", "LOAD:", "LOAD:abc", "LOAD:0", "SHIPMENT:", "order"]) {
      expect(parseTarget(key)).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadsSection } from "@/app/orders/[id]/LoadsSection";

// #41: the printed-traveler warning must be visible the moment the loads editor renders — it is
// derived from ORDER STATE (`OrderDetail.travelerPrinted`, computed server-side and pinned in
// orders.test.ts), not from a mutation's response warnings, which only exist after a save and are
// cleared by the next warning-less mutation. The repo has no DOM test env (practice-banner
// .test.tsx's own precedent), so the section renders to static markup — initial hook state is all
// the notice depends on — and the assertion is on the element tree's text, not pixels.

const editGate = { allowed: true, disabled: false, title: undefined };
const applyMutation = async () => {};
const onError = () => {};

function render(travelerPrinted: boolean): string {
  return renderToStaticMarkup(
    <LoadsSection
      orderId="order-1"
      loads={[{ id: "load-1", loadNumber: 1, qty: 40, weight: 540 }]}
      travelerPrinted={travelerPrinted}
      editGate={editGate}
      applyMutation={applyMutation}
      onError={onError}
    />,
  );
}

describe("LoadsSection (#41 — the printed-traveler notice)", () => {
  it("shows the reprint notice on first render when a traveler has already printed", () => {
    expect(render(true)).toContain("A traveler has already printed");
  });

  it("shows no notice when no traveler has printed", () => {
    expect(render(false)).not.toContain("A traveler has already printed");
  });
});

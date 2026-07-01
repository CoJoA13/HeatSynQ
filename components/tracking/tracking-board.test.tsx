import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackingBoard } from "./tracking-board";
import type { WorkOrder, Customer, OrderStep } from "@/lib/domain";

function ostep(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "track" | "state" | "areaId">): OrderStep {
  return { equip: "", instr: "", params: [], operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p };
}
const cust: Customer = {
  id: "c1", createdAt: "", updatedAt: "", version: 1, customerNumber: "1", name: "Apex Aerospace",
  initials: "AA", city: "", billingAddress: "", phone: "", terms: "Net 30", status: "active",
  priceKeyId: null, taxExempt: false, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0,
};
function order(id: string, steps: OrderStep[], status: WorkOrder["status"] = "in_process", due = "2026-08-01T00:00:00.000Z"): WorkOrder {
  return {
    id, createdAt: "", updatedAt: "", version: 1, number: id.toUpperCase(), customerId: "c1", customerPO: "",
    quoteId: null, processSummary: "Carburize", processMasterId: null, status, orderedDate: "2026-06-01T00:00:00.000Z",
    due, certifyRequired: false, certSpecId: null, orderValueCents: 1000, progressPct: 0, lines: [], pricing: [],
    steps, activity: [],
  };
}
const AS_OF = "2026-07-01T00:00:00.000Z";
const handlers = { onTrackIn: () => {}, onTrackOut: () => {} };

describe("TrackingBoard", () => {
  it("places a card in its active step's area column", () => {
    const o = order("wo-a", [
      ostep({ n: 1, op: "Wash & rack", track: "track_in_out", state: "done", areaId: "rack" }),
      ostep({ n: 2, op: "Carburize", track: "track_in_out", state: "in_process", areaId: "in_process" }),
    ]);
    render(<TrackingBoard orders={[o]} customers={[cust]} asOf={AS_OF} busy={false} {...handlers} />);
    const col = screen.getByTestId("area-col-in_process");
    expect(within(col).getByTestId("board-card-WO-A")).toBeInTheDocument();
  });

  it("flags a late, unshipped order", () => {
    const o = order("wo-overdue", [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process", areaId: "in_process" })], "in_process", "2026-06-01T00:00:00.000Z");
    render(<TrackingBoard orders={[o]} customers={[cust]} asOf={AS_OF} busy={false} {...handlers} />);
    expect(within(screen.getByTestId("board-card-WO-OVERDUE")).getByText(/late/i)).toBeInTheDocument();
  });

  it("fires onTrackOut from the card quick action", async () => {
    const onTrackOut = vi.fn();
    const o = order("wo-b", [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process", areaId: "in_process" })]);
    render(<TrackingBoard orders={[o]} customers={[cust]} asOf={AS_OF} busy={false} onTrackIn={() => {}} onTrackOut={onTrackOut} />);
    const card = screen.getByTestId("board-card-WO-B");
    await userEvent.click(within(card).getByRole("button", { name: "Track Out" }));
    expect(onTrackOut).toHaveBeenCalledWith(o, 1, undefined);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShopFloorGrid } from "./shop-floor-grid";
import { EQUIPMENT } from "@/lib/domain/enums";
import type { WorkOrder, OrderStep, Customer } from "@/lib/domain";

const AS_OF = "2026-07-01T00:00:00.000Z";
const cust: Customer = {
  id: "c1", createdAt: "", updatedAt: "", version: 1, customerNumber: "1", name: "Apex Aerospace",
  initials: "AA", city: "", billingAddress: "", phone: "", terms: "Net 30", status: "active",
  priceKeyId: null, taxExempt: false, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0,
};
function step(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "equip" | "state">): OrderStep {
  return { track: "track_in_out", areaId: "in_process", instr: "", params: [], operatorId: null,
    operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p };
}
function wo(id: string, steps: OrderStep[], status: WorkOrder["status"] = "in_process"): WorkOrder {
  return { id, number: id.toUpperCase(), createdAt: "", updatedAt: "", version: 1, customerId: "c1",
    customerPO: "", quoteId: null, processSummary: "", processMasterId: null, status,
    orderedDate: "2026-06-01T00:00:00.000Z", due: "2026-08-01T00:00:00.000Z", certifyRequired: false,
    certSpecId: null, orderValueCents: 0, progressPct: 50, lines: [], pricing: [], steps, activity: [] };
}

describe("ShopFloorGrid", () => {
  it("renders one tile per roster unit with a summary strip", () => {
    render(<ShopFloorGrid orders={[]} customers={[cust]} asOf={AS_OF} onSelect={() => {}} />);
    for (const e of EQUIPMENT) expect(screen.getByTestId(`equipment-tile-${e.id}`)).toBeInTheDocument();
    const summary = screen.getByTestId("shopfloor-summary");
    expect(within(summary).getByText("Idle").parentElement).toHaveTextContent("10");
  });

  it("shows a running load on the right unit and drills in", async () => {
    const onSelect = vi.fn();
    const o = wo("wo-1", [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process" })]);
    render(<ShopFloorGrid orders={[o]} customers={[cust]} asOf={AS_OF} onSelect={onSelect} />);
    const tile = screen.getByTestId("equipment-tile-eq-pit-1");
    expect(within(tile).getByText("WO-1")).toBeInTheDocument();
    expect(within(tile).getByText("Apex Aerospace")).toBeInTheDocument();
    await userEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith("wo-1");
  });
});

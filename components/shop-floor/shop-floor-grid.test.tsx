import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShopFloorGrid } from "./shop-floor-grid";
import type { WorkOrder, OrderStep, Customer, Equipment, Maintenance } from "@/lib/domain";

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
function equip(p: Partial<Equipment> & Pick<Equipment, "id" | "name" | "kind">): Equipment {
  return { createdAt: "", updatedAt: "", version: 0, availability: "available", note: null, ...p };
}
const ROSTER: Equipment[] = [
  equip({ id: "eq-iq-1", name: "Batch IQ #1", kind: "batch_iq" }),
  equip({ id: "eq-iq-2", name: "Batch IQ #2", kind: "batch_iq" }),
  equip({ id: "eq-iq-3", name: "Batch IQ #3", kind: "batch_iq" }),
  equip({ id: "eq-temper-1", name: "Temper Oven #1", kind: "temper" }),
  equip({ id: "eq-temper-2", name: "Temper Oven #2", kind: "temper" }),
  equip({ id: "eq-vac-1", name: "Vacuum Furnace #1", kind: "vacuum" }),
  equip({ id: "eq-pit-1", name: "Pit Furnace #1", kind: "pit" }),
  equip({ id: "eq-belt-1", name: "Continuous Belt #1", kind: "continuous" }),
  equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" }),
  equip({ id: "eq-inspect-1", name: "Inspection", kind: "inspect" }),
];

describe("ShopFloorGrid", () => {
  it("renders one tile per roster unit with a summary strip", () => {
    render(<ShopFloorGrid orders={[]} customers={[cust]} equipment={ROSTER} maintenance={[]} asOf={AS_OF} onSelect={() => {}} />);
    for (const e of ROSTER) expect(screen.getByTestId(`equipment-tile-${e.id}`)).toBeInTheDocument();
    const summary = screen.getByTestId("shopfloor-summary");
    expect(within(summary).getByText("Idle").parentElement).toHaveTextContent("10");
  });

  it("shows a running load on the right unit and drills in", async () => {
    const onSelect = vi.fn();
    const o = wo("wo-1", [step({ n: 2, op: "Nitride", equip: "Pit Furnace #1", state: "in_process" })]);
    render(<ShopFloorGrid orders={[o]} customers={[cust]} equipment={ROSTER} maintenance={[]} asOf={AS_OF} onSelect={onSelect} />);
    const tile = screen.getByTestId("equipment-tile-eq-pit-1");
    expect(within(tile).getByText("WO-1")).toBeInTheDocument();
    expect(within(tile).getByText("Apex Aerospace")).toBeInTheDocument();
    await userEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith("wo-1");
  });

  it("shows out-of-service and pyrometry-due KPIs", () => {
    const roster = ROSTER.map((e) => e.id === "eq-temper-2" ? { ...e, availability: "down" as const } : e);
    const maintenance: Maintenance[] = [{
      id: "mnt-1", createdAt: "", updatedAt: "", version: 0, equipmentId: "eq-iq-1", type: "sat",
      specificationId: "spec-ams2750", intervalDays: 30,
      lastDoneAt: "2026-05-01T00:00:00.000Z", nextDueAt: "2026-06-01T00:00:00.000Z",
    }];
    render(<ShopFloorGrid orders={[]} customers={[cust]} equipment={roster} maintenance={maintenance} asOf={AS_OF} onSelect={() => {}} />);
    const summary = screen.getByTestId("shopfloor-summary");
    expect(within(summary).getByText("Out of service").parentElement).toHaveTextContent("1");
    expect(within(summary).getByText("Pyrometry due").parentElement).toHaveTextContent("1");
  });
});

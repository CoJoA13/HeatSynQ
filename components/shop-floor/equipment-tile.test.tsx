import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EquipmentTile } from "./equipment-tile";
import type { Equipment } from "@/lib/domain";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

function equip(p: Partial<Equipment> & Pick<Equipment, "id" | "name" | "kind">): Equipment {
  return { createdAt: "", updatedAt: "", version: 0, availability: "available", note: null, ...p };
}
const iq3 = equip({ id: "eq-iq-3", name: "Batch IQ #3", kind: "batch_iq" });

function loaded(over: Partial<NonNullable<EquipmentLoad["load"]>> = {}): EquipmentLoad {
  return {
    equipmentId: "eq-iq-3", state: "running", queued: 0,
    load: {
      workOrderId: "wo-1", workOrderNumber: "WO-1", customerId: "c1", op: "Carburize",
      progressPct: 40, operatorInitials: "DM", setpoint: "1700°F",
      estFinishIso: "2026-07-01T14:00:00.000Z", late: false, trackedInAt: "2026-07-01T06:00:00.000Z", ...over,
    },
  };
}

describe("EquipmentTile", () => {
  it("shows the load and drills in on click", async () => {
    const onSelect = vi.fn();
    render(<EquipmentTile equipment={iq3} entry={loaded()} customerName="Apex Aerospace" onSelect={onSelect} />);
    expect(screen.getByText("WO-1")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("Carburize")).toBeInTheDocument();
    expect(screen.getByText(/Setpoint 1700°F/)).toBeInTheDocument();
    expect(screen.getByText(/Est\. finish/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("equipment-tile-eq-iq-3"));
    expect(onSelect).toHaveBeenCalledWith("eq-iq-3");
  });

  it("shows a LATE pill and queued count", () => {
    render(<EquipmentTile equipment={iq3} entry={{ ...loaded({ late: true }), queued: 2 }} customerName="Apex Aerospace" onSelect={() => {}} />);
    expect(screen.getByText(/late/i)).toBeInTheDocument();
    expect(screen.getByText(/\+2 queued/)).toBeInTheDocument();
  });

  it("renders an idle tile that is a button and fires onSelect with the equipment id", async () => {
    const onSelect = vi.fn();
    render(<EquipmentTile equipment={iq3} entry={{ equipmentId: "eq-iq-3", state: "idle", load: null, queued: 0 }} customerName={null} onSelect={onSelect} />);
    expect(screen.getByText(/no load · available/i)).toBeInTheDocument();
    const button = screen.getByRole("button");
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("eq-iq-3");
  });

  it("shows the on-hold state pill", () => {
    render(<EquipmentTile equipment={iq3} entry={{ ...loaded(), state: "on_hold" }} customerName="Apex Aerospace" onSelect={() => {}} />);
    expect(screen.getByText("On hold")).toBeInTheDocument();
  });

  it("shows the availability note when the unit is down", () => {
    const downUnit = equip({ id: "eq-temper-2", name: "Temper Oven #2", kind: "temper", availability: "down", note: "Control board fault" });
    render(<EquipmentTile equipment={downUnit} entry={{ equipmentId: "eq-temper-2", state: "down", load: null, queued: 0 }} customerName={null} />);
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(screen.getByText("Control board fault")).toBeInTheDocument();
    expect(screen.queryByText("No load · available")).not.toBeInTheDocument();
  });
});

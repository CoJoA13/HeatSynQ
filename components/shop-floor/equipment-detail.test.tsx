import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EquipmentDetail } from "./equipment-detail";
import type { Equipment, Maintenance } from "@/lib/domain";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

const ASOF = "2026-06-30T12:00:00.000Z";

function equip(p: Partial<Equipment> & Pick<Equipment, "id" | "name" | "kind">): Equipment {
  return { createdAt: "", updatedAt: "", version: 0, availability: "available", note: null, ...p };
}
function task(p: Partial<Maintenance> & Pick<Maintenance, "id" | "type" | "nextDueAt">): Maintenance {
  return {
    createdAt: "", updatedAt: "", version: 0, equipmentId: "eq-wash-1",
    specificationId: "spec-ams2750", intervalDays: 30, lastDoneAt: "2026-05-31T00:00:00.000Z", ...p,
  };
}
const specs = new Map([["spec-ams2750", "AMS 2750"]]);

const runningEntry: EquipmentLoad = {
  equipmentId: "eq-wash-1", state: "running", queued: 0,
  load: {
    workOrderId: "wo-1", workOrderNumber: "WO-1", customerId: "c1", op: "Wash & rack",
    progressPct: 20, operatorInitials: "DM", setpoint: null,
    estFinishIso: null, late: false, trackedInAt: "2026-06-30T06:00:00.000Z",
  },
};
const idleEntry: EquipmentLoad = { equipmentId: "eq-wash-1", state: "idle", load: null, queued: 0 };

describe("EquipmentDetail", () => {
  it("renders header, state pill, and load card with a WO link", () => {
    const unit = equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" });
    render(
      <EquipmentDetail
        equipment={unit} entry={runningEntry} customerName="Apex Aerospace" tasks={[]}
        specCodeById={specs} asOf={ASOF} canMaintain={false} busy={false}
        onSetAvailability={() => {}} onComplete={() => {}}
      />
    );
    expect(screen.getByTestId("equipment-state-pill")).toHaveTextContent("Running");
    const link = screen.getByRole("link", { name: /WO-1/ });
    expect(link).toHaveAttribute("href", "/orders/wo-1");
  });

  it("shows availability controls for an available unit and fires onSetAvailability(down, note) via the dialog", async () => {
    const user = userEvent.setup();
    const unit = equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" });
    const onSetAvailability = vi.fn();
    render(
      <EquipmentDetail
        equipment={unit} entry={runningEntry} customerName="Apex Aerospace" tasks={[]}
        specCodeById={specs} asOf={ASOF} canMaintain busy={false}
        onSetAvailability={onSetAvailability} onComplete={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Mark down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start maintenance" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mark down" }));
    await user.type(screen.getByLabelText("Note"), "the note");
    await user.click(screen.getByRole("button", { name: "Confirm down" }));

    expect(onSetAvailability).toHaveBeenCalledWith("down", "the note");
  });

  it("shows the note and Return to service for a down unit, firing onSetAvailability(available, null)", async () => {
    const user = userEvent.setup();
    const unit = equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash", availability: "down", note: "Control board fault" });
    const downEntry: EquipmentLoad = { equipmentId: "eq-wash-1", state: "down", load: null, queued: 0 };
    const onSetAvailability = vi.fn();
    render(
      <EquipmentDetail
        equipment={unit} entry={downEntry} customerName={null} tasks={[]}
        specCodeById={specs} asOf={ASOF} canMaintain busy={false}
        onSetAvailability={onSetAvailability} onComplete={() => {}}
      />
    );
    expect(screen.getByText("Control board fault")).toBeInTheDocument();
    const returnButton = screen.getByRole("button", { name: "Return to service" });
    expect(returnButton).toBeInTheDocument();

    await user.click(returnButton);
    await user.click(screen.getByRole("button", { name: "Confirm return" }));

    expect(onSetAvailability).toHaveBeenCalledWith("available", null);
  });

  it("hides all availability controls when canMaintain is false", () => {
    const unit = equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash", availability: "down", note: "Control board fault" });
    const downEntry: EquipmentLoad = { equipmentId: "eq-wash-1", state: "down", load: null, queued: 0 };
    render(
      <EquipmentDetail
        equipment={unit} entry={downEntry} customerName={null} tasks={[]}
        specCodeById={specs} asOf={ASOF} canMaintain={false} busy={false}
        onSetAvailability={() => {}} onComplete={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "Mark down" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start maintenance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Return to service" })).not.toBeInTheDocument();
  });

  it("renders the No load · available EmptyState for an idle entry", () => {
    const unit = equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" });
    render(
      <EquipmentDetail
        equipment={unit} entry={idleEntry} customerName={null} tasks={[]}
        specCodeById={specs} asOf={ASOF} canMaintain={false} busy={false}
        onSetAvailability={() => {}} onComplete={() => {}}
      />
    );
    expect(screen.getByText("No load · available")).toBeInTheDocument();
  });

  it("wires PyrometryTable's onComplete through a confirm dialog to onComplete", async () => {
    const user = userEvent.setup();
    const unit = equip({ id: "eq-wash-1", name: "Wash Station", kind: "wash" });
    const due = task({ id: "m-due", type: "sat", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const onComplete = vi.fn();
    render(
      <EquipmentDetail
        equipment={unit} entry={idleEntry} customerName={null} tasks={[due]}
        specCodeById={specs} asOf={ASOF} canMaintain busy={false}
        onSetAvailability={() => {}} onComplete={onComplete}
      />
    );
    await user.click(screen.getByTestId("pyro-complete-m-due"));
    await user.click(screen.getByRole("button", { name: "Confirm complete" }));
    expect(onComplete).toHaveBeenCalledWith(due);
  });
});

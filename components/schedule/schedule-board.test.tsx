import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduleBoard } from "./schedule-board";
import type { WorkOrder, Customer, ScheduleBlock } from "@/lib/domain";
import type { ScheduleCell } from "@/lib/logic/schedule";

const ASOF = "2026-06-30T12:00:00.000Z";
const customers = [{ id: "cust-apex", name: "Apex Aerospace" } as Customer];

function wo(over: Partial<WorkOrder>): WorkOrder {
  return {
    id: "wo-1", number: "WO-1", customerId: "cust-apex", customerPO: "", quoteId: null,
    processSummary: "Carburize", processMasterId: null, status: "received",
    orderedDate: "2026-06-01T00:00:00.000Z", due: "2026-07-03T00:00:00.000Z",
    certifyRequired: false, certSpecId: null, orderValueCents: 0, progressPct: 0,
    lines: [], pricing: [],
    steps: [{ n: 1, op: "Carburize", equip: "Batch IQ #1", instr: "", params: [], track: "track_in_out",
      areaId: "in_process", state: "pending", operatorId: null, operatorInitials: null,
      trackedInAt: null, trackedOutAt: null, inspectResult: null }],
    activity: [], createdAt: "t", updatedAt: "t", version: 0, ...over,
  };
}
const scheduledWo = wo({ id: "wo-s", number: "WO-48230", status: "scheduled" });
const receivedWo = wo({ id: "wo-r", number: "WO-48231", status: "received" });
const block: ScheduleBlock = { id: "sb-1", createdAt: "t", updatedAt: "t", version: 0,
  workOrderId: "wo-s", equipmentId: "eq-iq-2", day: "2026-07-01T00:00:00.000Z", state: "planned" };

function setup(canSchedule: boolean, handlers: Partial<{
  onAssign: (order: WorkOrder, equipmentId: string, day: string) => void;
  onMove: (cell: ScheduleCell, equipmentId: string, day: string) => void;
  onUnassign: (cell: ScheduleCell) => void;
}> = {}) {
  return render(<ScheduleBoard orders={[scheduledWo, receivedWo]} customers={customers} blocks={[block]}
    asOf={ASOF} canSchedule={canSchedule} busy={false}
    onAssign={handlers.onAssign ?? (() => {})} onMove={handlers.onMove ?? (() => {})} onUnassign={handlers.onUnassign ?? (() => {})} />);
}

describe("ScheduleBoard", () => {
  it("shows the KPI strip and the planned block in its cell", () => {
    setup(true);
    expect(screen.getByTestId("schedule-summary")).toBeInTheDocument();
    const cell = screen.getByTestId("schedule-cell-sb-1");
    expect(cell).toHaveTextContent("WO-48230");
    expect(cell).toHaveTextContent("Scheduled");
    expect(cell.querySelector("[data-testid='cell-progress']")).toBeInTheDocument();
  });

  it("lists the received order in the unscheduled queue", () => {
    setup(true);
    expect(screen.getByTestId("queue-card-WO-48231")).toBeInTheDocument();
  });

  it("assigns from the queue via the dialog", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    setup(true, { onAssign });
    // only one received order → a single "Assign" button
    await user.click(screen.getByRole("button", { name: "Assign" }));
    await user.selectOptions(screen.getByLabelText("Equipment"), "eq-vac-1");
    await user.selectOptions(screen.getByLabelText("Day"), "2026-06-29T00:00:00.000Z");
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(onAssign).toHaveBeenCalledWith(receivedWo, "eq-vac-1", "2026-06-29T00:00:00.000Z");
  });

  it("unassigns a scheduled block after confirm", async () => {
    const user = userEvent.setup();
    const onUnassign = vi.fn();
    setup(true, { onUnassign });
    await user.click(screen.getByRole("button", { name: "Unassign" }));
    await user.click(screen.getByRole("button", { name: "Unschedule" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
  });

  it("hides all write affordances without permission", () => {
    setup(false);
    expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unassign" })).not.toBeInTheDocument();
  });
});

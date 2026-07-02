import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PyrometryTable } from "./pyrometry-table";
import type { Maintenance } from "@/lib/domain";

const ASOF = "2026-06-30T12:00:00.000Z";
function task(p: Partial<Maintenance> & Pick<Maintenance, "id" | "type" | "nextDueAt">): Maintenance {
  return {
    createdAt: "", updatedAt: "", version: 0, equipmentId: "eq-vac-1",
    specificationId: "spec-ams2750", intervalDays: 30, lastDoneAt: "2026-05-31T00:00:00.000Z", ...p,
  };
}
const specs = new Map([["spec-ams2750", "AMS 2750"]]);

describe("PyrometryTable", () => {
  it("renders type pill, spec code, dates, and a due pill only for due rows", () => {
    const due = task({ id: "m-due", type: "sat", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const future = task({ id: "m-fut", type: "tus", nextDueAt: "2026-08-25T00:00:00.000Z" });
    render(<PyrometryTable tasks={[due, future]} specCodeById={specs} asOf={ASOF} canMaintain busy={false} onComplete={() => {}} />);
    expect(screen.getByTestId("pyro-row-m-due")).toHaveTextContent("SAT");
    expect(screen.getAllByText("AMS 2750").length).toBe(2);
    expect(screen.getByTestId("pyro-due-m-due")).toBeInTheDocument();
    expect(screen.queryByTestId("pyro-due-m-fut")).not.toBeInTheDocument();
  });

  it("fires onComplete from the row button and hides it without permission", () => {
    const due = task({ id: "m-due", type: "sat", nextDueAt: "2026-06-30T00:00:00.000Z" });
    const onComplete = vi.fn();
    const { rerender } = render(<PyrometryTable tasks={[due]} specCodeById={specs} asOf={ASOF} canMaintain busy={false} onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId("pyro-complete-m-due"));
    expect(onComplete).toHaveBeenCalledWith(due);
    rerender(<PyrometryTable tasks={[due]} specCodeById={specs} asOf={ASOF} canMaintain={false} busy={false} onComplete={onComplete} />);
    expect(screen.queryByTestId("pyro-complete-m-due")).not.toBeInTheDocument();
  });

  it("shows the empty state when a unit has no schedule", () => {
    render(<PyrometryTable tasks={[]} specCodeById={specs} asOf={ASOF} canMaintain busy={false} onComplete={() => {}} />);
    expect(screen.getByText("No pyrometry schedule")).toBeInTheDocument();
  });
});

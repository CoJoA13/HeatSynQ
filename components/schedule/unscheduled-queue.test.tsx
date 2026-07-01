import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnscheduledQueue } from "./unscheduled-queue";
import type { WorkOrder, Customer } from "@/lib/domain";

const cust = [{ id: "cust-apex", name: "Apex Aerospace" } as Customer];
function order(id: string, number: string): WorkOrder {
  return { id, number, customerId: "cust-apex", due: "2026-07-03T00:00:00.000Z" } as WorkOrder;
}

describe("UnscheduledQueue", () => {
  it("renders queue cards and fires onAssign when permitted", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<UnscheduledQueue orders={[order("wo-48231", "WO-48231")]} customers={cust}
      canSchedule busy={false} onAssign={onAssign} />);
    expect(screen.getByTestId("queue-card-WO-48231")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  it("hides the Assign button without permission", () => {
    render(<UnscheduledQueue orders={[order("wo-48231", "WO-48231")]} customers={cust}
      canSchedule={false} busy={false} onAssign={() => {}} />);
    expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
  });

  it("shows an empty state when the queue is empty", () => {
    render(<UnscheduledQueue orders={[]} customers={cust} canSchedule busy={false} onAssign={() => {}} />);
    expect(screen.getByText("All received orders scheduled")).toBeInTheDocument();
  });
});

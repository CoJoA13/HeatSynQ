import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnscheduledQueue } from "./unscheduled-queue";
import type { WorkOrder, Customer } from "@/lib/domain";

const ASOF = "2026-06-30T12:00:00.000Z";
const cust = [{ id: "cust-apex", name: "Apex Aerospace" } as Customer];
function order(id: string, number: string, due = "2026-07-03T00:00:00.000Z"): WorkOrder {
  return { id, number, customerId: "cust-apex", due, status: "received" } as WorkOrder;
}

describe("UnscheduledQueue", () => {
  it("renders queue cards and fires onAssign when permitted", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<UnscheduledQueue orders={[order("wo-48231", "WO-48231")]} customers={cust}
      canSchedule busy={false} onAssign={onAssign} asOf={ASOF} />);
    expect(screen.getByTestId("queue-card-WO-48231")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  it("hides the Assign button without permission", () => {
    render(<UnscheduledQueue orders={[order("wo-48231", "WO-48231")]} customers={cust}
      canSchedule={false} busy={false} onAssign={() => {}} asOf={ASOF} />);
    expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
  });

  it("shows an empty state when the queue is empty", () => {
    render(<UnscheduledQueue orders={[]} customers={cust} canSchedule busy={false} onAssign={() => {}} asOf={ASOF} />);
    expect(screen.getByText("All received orders scheduled")).toBeInTheDocument();
  });

  it("shows LATE pill for a past-due order and not for a future-due order", () => {
    const late = order("wo-late", "WO-LATE", "2026-06-20T00:00:00.000Z");
    const ok = order("wo-ok", "WO-OK", "2026-07-10T00:00:00.000Z");
    render(<UnscheduledQueue orders={[late, ok]} customers={cust}
      canSchedule busy={false} onAssign={() => {}} asOf={ASOF} />);
    const lateCard = screen.getByTestId("queue-card-WO-LATE");
    const okCard = screen.getByTestId("queue-card-WO-OK");
    expect(lateCard).toHaveTextContent("LATE");
    expect(okCard).not.toHaveTextContent("LATE");
  });
});

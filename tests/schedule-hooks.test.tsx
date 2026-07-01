import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import { useWorkOrders, useScheduleBlocks, useAssignSchedule, useUnschedule, useOperators } from "@/lib/query/hooks";

// Assign the seeded received order wo-48231 to a furnace/day, then unschedule it.
function AssignProbe() {
  const orders = useWorkOrders();
  const blocks = useScheduleBlocks();
  const ops = useOperators();
  const assign = useAssignSchedule();
  const unschedule = useUnschedule();
  const order = orders.data?.find((o) => o.id === "wo-48231");
  const operator = ops.data?.find((o) => o.id === "op-dana");
  const planned = blocks.data?.filter((b) => b.workOrderId === "wo-48231" && b.state === "planned") ?? [];
  return (
    <div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <div data-testid="planned">{planned.length}</div>
      <button disabled={!order || !operator} onClick={() => order && operator &&
        assign.mutate({ order, equipmentId: "eq-iq-1", day: "2026-06-29T00:00:00.000Z", operator, at: "2026-06-30T12:00:00.000Z" })}>Assign</button>
      <button disabled={!order || !operator || planned.length === 0} onClick={() => {
        const b = planned[0];
        if (order && operator && b) unschedule.mutate({ order, block: b, operator, at: "2026-06-30T12:00:00.000Z" });
      }}>Unschedule</button>
    </div>
  );
}

// TODO(Task 6): un-skip once wo-48231 is seeded
describe.skip("schedule mutation hooks", () => {
  it("assign drives received→scheduled and creates a planned block; unschedule reverts", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssignProbe />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("received"));

    await user.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("scheduled"));
    await waitFor(() => expect(screen.getByTestId("planned").textContent).toBe("1"));

    await user.click(screen.getByRole("button", { name: "Unschedule" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("received"));
    await waitFor(() => expect(screen.getByTestId("planned").textContent).toBe("0"));
  });
});

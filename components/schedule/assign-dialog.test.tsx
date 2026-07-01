import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssignDialog } from "./assign-dialog";
import type { WeekDay } from "@/lib/logic/schedule";

const DAYS: WeekDay[] = [
  { iso: "2026-06-29T00:00:00.000Z", label: "Mon 6/29", weekdayShort: "Mon" },
  { iso: "2026-07-01T00:00:00.000Z", label: "Wed 7/1", weekdayShort: "Wed" },
];

describe("AssignDialog", () => {
  it("confirms a chosen equipment + day", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AssignDialog open mode="assign" workOrderNumber="WO-48231" days={DAYS} busy={false}
      onOpenChange={() => {}} onConfirm={onConfirm} />);

    await user.selectOptions(screen.getByLabelText("Equipment"), "eq-vac-1");
    await user.selectOptions(screen.getByLabelText("Day"), "2026-07-01T00:00:00.000Z");
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(onConfirm).toHaveBeenCalledWith("eq-vac-1", "2026-07-01T00:00:00.000Z");
  });

  it("move mode pre-fills and labels the confirm button 'Move'", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AssignDialog open mode="move" workOrderNumber="WO-48230" days={DAYS}
      initialEquipmentId="eq-iq-2" initialDay="2026-07-01T00:00:00.000Z" busy={false}
      onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(onConfirm).toHaveBeenCalledWith("eq-iq-2", "2026-07-01T00:00:00.000Z");
  });
});

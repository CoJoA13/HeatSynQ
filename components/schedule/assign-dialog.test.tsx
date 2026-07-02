import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssignDialog } from "./assign-dialog";
import type { WeekDay } from "@/lib/logic/schedule";
import type { Equipment } from "@/lib/domain";

const DAYS: WeekDay[] = [
  { iso: "2026-06-29T00:00:00.000Z", label: "Mon 6/29", weekdayShort: "Mon" },
  { iso: "2026-07-01T00:00:00.000Z", label: "Wed 7/1", weekdayShort: "Wed" },
];

function equip(p: Partial<Equipment> & Pick<Equipment, "id" | "name" | "kind">): Equipment {
  return { createdAt: "", updatedAt: "", version: 0, availability: "available", note: null, ...p };
}
const EQUIPMENT: Equipment[] = [
  equip({ id: "eq-iq-1", name: "Batch IQ #1", kind: "batch_iq" }),
  equip({ id: "eq-vac-1", name: "Vacuum Furnace #1", kind: "vacuum" }),
  equip({ id: "eq-temper-2", name: "Temper Oven #2", kind: "temper", availability: "down", note: "Setpoint deviation" }),
];

describe("AssignDialog", () => {
  it("confirms a chosen equipment + day", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AssignDialog open mode="assign" workOrderNumber="WO-48231" days={DAYS} equipment={EQUIPMENT} busy={false}
      onOpenChange={() => {}} onConfirm={onConfirm} />);

    await user.selectOptions(screen.getByLabelText("Equipment"), "eq-vac-1");
    await user.selectOptions(screen.getByLabelText("Day"), "2026-07-01T00:00:00.000Z");
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(onConfirm).toHaveBeenCalledWith("eq-vac-1", "2026-07-01T00:00:00.000Z");
  });

  it("move mode pre-fills and labels the confirm button 'Move'", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AssignDialog open mode="move" workOrderNumber="WO-48230" days={DAYS} equipment={EQUIPMENT}
      initialEquipmentId="eq-iq-2" initialDay="2026-07-01T00:00:00.000Z" busy={false}
      onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(onConfirm).toHaveBeenCalledWith("eq-iq-2", "2026-07-01T00:00:00.000Z");
  });

  it("excludes non-available units from the equipment options", () => {
    render(<AssignDialog open mode="assign" workOrderNumber="WO-48231" days={DAYS} equipment={EQUIPMENT} busy={false}
      onOpenChange={() => {}} onConfirm={() => {}} />);
    const select = screen.getByLabelText("Equipment");
    const values = Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["eq-iq-1", "eq-vac-1"]);
  });
});

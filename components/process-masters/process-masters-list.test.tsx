import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcessMastersList } from "./process-masters-list";
import type { ProcessMaster } from "@/lib/domain";

const pm: ProcessMaster = {
  id: "pm-carb58", createdAt: "", updatedAt: "", version: 0, code: "PM-CARB-58",
  name: "Carburize & temper", description: "Case hardened", rev: "C", status: "active",
  surfaceHardness: "Rc 58-62", caseDepth: ".020-.030 in", hardnessScale: "Rockwell C",
  steps: [
    { n: 1, op: "Receive & verify", equip: "Receiving", instr: "", params: [], track: "track_in" },
    { n: 2, op: "Carburize", equip: "Batch IQ #3", instr: "", params: ["1700°F"], track: "track_in_out" },
  ],
};

describe("ProcessMastersList", () => {
  it("renders code, step count and status, and fires row select", async () => {
    const onSelect = vi.fn();
    render(<ProcessMastersList processMasters={[pm]} onSelect={onSelect} />);
    expect(screen.getByText("PM-CARB-58")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // step count
    expect(screen.getByText("Active")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Carburize & temper"));
    expect(onSelect).toHaveBeenCalledWith("pm-carb58");
  });
});

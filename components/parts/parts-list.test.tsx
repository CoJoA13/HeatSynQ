import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PartsList } from "./parts-list";
import type { Part, ProcessMaster } from "@/lib/domain";

const part: Part = {
  id: "part-ts4471", createdAt: "", updatedAt: "", version: 0, partNumber: "TS-4471",
  description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C",
  hardness: "Rc 58-62", caseDepth: ".020-.030 in", specificationId: null, processMasterId: "pm-carb58",
  priceKeyId: null, inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot",
};
const pm = { id: "pm-carb58", code: "PM-CARB-58" } as ProcessMaster;

describe("PartsList", () => {
  it("renders part number, material and resolved process-master code, and fires select", async () => {
    const onSelect = vi.fn();
    render(<PartsList parts={[part]} processMasters={[pm]} onSelect={onSelect} />);
    expect(screen.getByText("TS-4471")).toBeInTheDocument();
    expect(screen.getByText("4140 steel")).toBeInTheDocument();
    expect(screen.getByText("PM-CARB-58")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Turbine shaft"));
    expect(onSelect).toHaveBeenCalledWith("part-ts4471");
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessMasterDetail } from "./process-master-detail";
import type { ProcessMaster, Part } from "@/lib/domain";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

const pm: ProcessMaster = {
  id: "pm-carb58", createdAt: "", updatedAt: "", version: 0, code: "PM-CARB-58",
  name: "Carburize & temper", description: "Case hardened, Rc 58-62", rev: "C", status: "active",
  surfaceHardness: "Rc 58-62", caseDepth: ".020-.030 in", hardnessScale: "Rockwell C",
  steps: [{ n: 3, op: "Carburize", equip: "Batch IQ #3", instr: "", params: ["1700°F", "8.0 hr"], track: "track_in_out" }],
};
const part: Part = {
  id: "part-ts4471", createdAt: "", updatedAt: "", version: 0, partNumber: "TS-4471",
  description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C",
  hardness: "Rc 58-62", caseDepth: ".020-.030 in", specificationId: null, processMasterId: "pm-carb58",
  priceKeyId: null, inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot",
};

describe("ProcessMasterDetail", () => {
  it("renders header, steps, inspection and used-by parts", () => {
    render(<ProcessMasterDetail processMaster={pm} usedByParts={[part]} />);
    expect(screen.getByText("PM-CARB-58")).toBeInTheDocument();
    expect(screen.getByText("Carburize")).toBeInTheDocument();
    expect(screen.getByText("1700°F · 8.0 hr")).toBeInTheDocument();
    expect(screen.getByText("Rc 58-62")).toBeInTheDocument();
    expect(screen.getByText("TS-4471")).toBeInTheDocument();
  });
  it("shows an empty state when no parts use the recipe", () => {
    render(<ProcessMasterDetail processMaster={pm} usedByParts={[]} />);
    expect(screen.getByText("No parts use this recipe")).toBeInTheDocument();
  });
});

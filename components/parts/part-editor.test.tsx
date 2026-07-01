import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PartEditor } from "./part-editor";
import type { Part } from "@/lib/domain";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

const part: Part = {
  id: "part-ts4471", createdAt: "", updatedAt: "", version: 3, partNumber: "TS-4471",
  description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C",
  hardness: "Rc 58-62", caseDepth: ".020-.030 in", specificationId: null, processMasterId: null,
  priceKeyId: null, inspectionScale: "Rockwell C", inspectionSample: "3 pc / lot",
};

function setup(onSave = vi.fn()) {
  render(
    <PartEditor part={part} specifications={[]} processMasters={[]} priceKeys={[]}
      onSave={onSave} saving={false} saved={false} />,
  );
  return onSave;
}

describe("PartEditor", () => {
  it("prefills fields from the part", () => {
    setup();
    expect(screen.getByLabelText("Part number")).toHaveValue("TS-4471");
    expect(screen.getByLabelText("Material")).toHaveValue("4140 steel");
  });

  it("shows a validation error and disables save when a required field is empty", async () => {
    setup();
    const desc = screen.getByLabelText("Description");
    await userEvent.clear(desc);
    await userEvent.tab();
    const errMsgs = await screen.findAllByText("Description is required");
    expect(errMsgs.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /save part/i })).toBeDisabled();
  });

  it("submits the edited values", async () => {
    const onSave = setup();
    const desc = screen.getByLabelText("Description");
    await userEvent.clear(desc);
    await userEvent.type(desc, "Turbine shaft rev C");
    await userEvent.click(screen.getByRole("button", { name: /save part/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ description: "Turbine shaft rev C", partNumber: "TS-4471" });
  });
});

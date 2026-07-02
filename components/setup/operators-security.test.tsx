import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OperatorsSecurity } from "./operators-security";
import type { Operator } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const OPERATORS: Operator[] = [
  { ...base, id: "op-dana", name: "Dana Mercer", initials: "DM", title: "Plant Manager", role: "manager", quoteAuthLimitCents: 100_000_00 },
  { ...base, id: "op-vance", name: "S. Vance", initials: "SV", title: "Estimator", role: "sales", quoteAuthLimitCents: 25_000_00 },
  { ...base, id: "op-office", name: "R. Office", initials: "RO", title: "A/R Clerk", role: "office", quoteAuthLimitCents: 0 },
];

function renderView(over: Partial<Parameters<typeof OperatorsSecurity>[0]> = {}) {
  const onSetLimit = vi.fn();
  render(<OperatorsSecurity operators={OPERATORS} canEdit={true} busy={false} onSetLimit={onSetLimit} {...over} />);
  return { onSetLimit };
}

describe("OperatorsSecurity", () => {
  it("renders operator rows with role labels and mono limits", () => {
    renderView();
    expect(screen.getByTestId("operator-row-op-dana")).toHaveTextContent("Dana Mercer");
    expect(screen.getByText("Estimator")).toBeInTheDocument();
    expect(screen.getByText("Manager")).toBeInTheDocument();
    expect(screen.getByTestId("operator-limit-op-vance")).toHaveTextContent("$25,000");
    expect(screen.getByTestId("operator-limit-op-office")).toHaveTextContent("$0");
  });

  it("renders the 7-row permission matrix with ✓/— placement", () => {
    renderView();
    for (const p of ["approve_over_limit", "apply_discount", "release_cert", "close_period", "edit_setup", "schedule_loads", "maintain_equipment"]) {
      expect(screen.getByTestId(`permission-row-${p}`)).toBeInTheDocument();
    }
    // edit_setup row: manager ✓, sales —, office —
    const row = screen.getByTestId("permission-row-edit_setup").closest("tr")!;
    const cells = Array.from(row.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toEqual(["Edit setup", "✓", "—", "—"]);
  });

  it("shows the signatures framing note", () => {
    renderView();
    expect(screen.getByText("Signatures aren't modeled yet.")).toBeInTheDocument();
  });

  it("hides Edit-limit actions when canEdit is false", () => {
    renderView({ canEdit: false });
    expect(screen.queryByTestId("edit-limit-op-vance")).not.toBeInTheDocument();
  });

  it("edit dialog validates and submits cents", () => {
    const { onSetLimit } = renderView();
    fireEvent.click(screen.getByTestId("edit-limit-op-vance"));
    const input = screen.getByLabelText("Quote limit ($)");
    // invalid: negative disables Save
    fireEvent.change(input, { target: { value: "-5" } });
    expect(screen.getByRole("button", { name: "Save limit" })).toBeDisabled();
    // unchanged value disables Save
    fireEvent.change(input, { target: { value: "25000" } });
    expect(screen.getByRole("button", { name: "Save limit" })).toBeDisabled();
    // valid new value → converts dollars to cents
    fireEvent.change(input, { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(onSetLimit).toHaveBeenCalledWith(expect.objectContaining({ id: "op-vance" }), 30_000_00);
  });
});

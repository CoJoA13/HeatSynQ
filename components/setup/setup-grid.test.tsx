import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SetupGrid } from "./setup-grid";

describe("SetupGrid", () => {
  it("renders all 6 canon cards", () => {
    render(<SetupGrid />);
    for (const key of ["operators", "plant", "process-masters", "equipment", "pricing", "cert-defaults"]) {
      expect(screen.getByTestId(`setup-card-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Operators & Security")).toBeInTheDocument();
    expect(screen.getByText("Operator IDs, roles, module permissions and signatures.")).toBeInTheDocument();
  });

  it("5 cards are links with canon targets; Plant Setup is inert with honest caption", () => {
    render(<SetupGrid />);
    expect(screen.getByTestId("setup-card-operators")).toHaveAttribute("href", "/setup/operators");
    expect(screen.getByTestId("setup-card-process-masters")).toHaveAttribute("href", "/process-masters");
    expect(screen.getByTestId("setup-card-equipment")).toHaveAttribute("href", "/shop-floor");
    expect(screen.getByTestId("setup-card-pricing")).toHaveAttribute("href", "/setup/pricing");
    expect(screen.getByTestId("setup-card-cert-defaults")).toHaveAttribute("href", "/setup/cert-defaults");
    const plant = screen.getByTestId("setup-card-plant");
    expect(plant).not.toHaveAttribute("href");
    expect(plant).toHaveTextContent("Not built yet");
  });
});

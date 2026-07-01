import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiTile } from "./kpi-tile";

describe("KpiTile", () => {
  it("renders label, value, and sub", () => {
    render(<KpiTile label="Open Orders" value="86" sub="4 today" />);
    expect(screen.getByText("Open Orders")).toBeInTheDocument();
    expect(screen.getByText("86")).toBeInTheDocument();
    expect(screen.getByText("4 today")).toBeInTheDocument();
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportTable } from "./report-table";
import { cell } from "@/lib/logic/reports";

describe("ReportTable cell kinds", () => {
  it("renders every cell kind with house formatting", () => {
    render(
      <ReportTable
        table={{
          columns: ["A", "B", "C", "D", "E", "F", "G"],
          rows: [[
            cell.text("Apex Aerospace"),
            cell.mono("WO-48211"),
            cell.date("2026-06-27T00:00:00.000Z"),
            cell.money(674000),
            cell.pct("66.7%"),
            cell.pill("Late", "danger"),
            cell.progress(40),
          ]],
        }}
      />,
    );
    expect(screen.getByTestId("report-table")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("WO-48211")).toBeInTheDocument();
    expect(screen.getByText("Jun 27, 2026")).toBeInTheDocument();
    expect(screen.getByText("$6,740")).toBeInTheDocument();
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("Late")).toBeInTheDocument();
    const bar = screen.getByTestId("report-cell-progress");
    expect(bar.firstChild).toHaveStyle({ width: "40%" });
  });
});

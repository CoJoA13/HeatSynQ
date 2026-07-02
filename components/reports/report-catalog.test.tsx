import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportCatalog } from "./report-catalog";

describe("ReportCatalog", () => {
  it("renders the 4 canon group cards", () => {
    render(<ReportCatalog />);
    for (const key of ["sales", "ar", "production", "quotes"]) {
      expect(screen.getByTestId(`report-group-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Accounts Receivable")).toBeInTheDocument();
    expect(screen.getByText("Production & Tracking")).toBeInTheDocument();
  });
  it("renders 16 live links with report titles and hrefs", () => {
    render(<ReportCatalog />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(16);
    const aging = screen.getByTestId("report-link-ar-aging");
    expect(aging).toHaveAttribute("href", "/reports/ar-aging");
    expect(aging).toHaveTextContent("A/R Aging");
    expect(screen.getByTestId("report-link-quoted-vs-won")).toHaveAttribute("href", "/reports/quoted-vs-won");
  });
});

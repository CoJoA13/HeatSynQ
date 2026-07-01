import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StandardsList } from "./standards-list";
import type { Standard } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const asOf = "2026-06-30T12:00:00.000Z";
const standards: Standard[] = [
  { ...base, id: "std-as9100d", code: "AS9100D", title: "Aerospace quality management system", category: "quality", reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z" },
  { ...base, id: "std-cqi9", code: "CQI-9", title: "AIAG heat-treat system assessment", category: "process", reviewedAt: "2025-06-15T00:00:00.000Z", nextReviewAt: "2026-06-15T00:00:00.000Z" },
];

describe("StandardsList", () => {
  it("renders code, title, category pill, and review dates", () => {
    render(<StandardsList standards={standards} asOf={asOf} />);
    expect(screen.getByText("AS9100D")).toBeInTheDocument();
    expect(screen.getByText("Aerospace quality management system")).toBeInTheDocument();
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText("Process")).toBeInTheDocument();
    expect(screen.getByText("Nov 15, 2026")).toBeInTheDocument(); // formatDate(nextReviewAt), UTC
  });
  it("flags only the overdue row", () => {
    render(<StandardsList standards={standards} asOf={asOf} />);
    const overdue = screen.getAllByText("Overdue");
    expect(overdue).toHaveLength(1);
    // The overdue pill sits in the CQI-9 row
    expect(overdue[0].closest("tr")).toHaveTextContent("CQI-9");
  });
});

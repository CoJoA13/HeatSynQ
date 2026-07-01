import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StandardsPage from "./page";

const mockStandards = vi.fn();
vi.mock("@/lib/query/hooks", () => ({ useStandards: () => mockStandards() }));
vi.mock("@/components/standards/standards-list", () => ({
  StandardsList: () => <div data-testid="standards-list" />,
}));

beforeEach(() => {
  mockStandards.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("StandardsPage guards", () => {
  it("renders skeleton while loading", () => {
    mockStandards.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<StandardsPage />);
    expect(screen.queryByTestId("standards-list")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockStandards.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<StandardsPage />);
    expect(screen.getByText("Failed to load standards.")).toBeInTheDocument();
  });
  it("renders EmptyState when no rows", () => {
    render(<StandardsPage />);
    expect(screen.getByText("No standards")).toBeInTheDocument();
  });
  it("renders the list with data", () => {
    mockStandards.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ id: "std-as9100d", createdAt: "", updatedAt: "", version: 0, code: "AS9100D", title: "Aerospace quality management system", category: "quality", reviewedAt: "2025-11-15T00:00:00.000Z", nextReviewAt: "2026-11-15T00:00:00.000Z" }],
    });
    render(<StandardsPage />);
    expect(screen.getByTestId("standards-list")).toBeInTheDocument();
    expect(screen.getByText("Standards")).toBeInTheDocument();
  });
});

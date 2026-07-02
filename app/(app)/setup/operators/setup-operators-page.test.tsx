import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupOperatorsPage from "./page";

const mockOperators = vi.fn();
const mockMutation = vi.fn();
vi.mock("@/lib/query/hooks", () => ({
  useOperators: () => mockOperators(),
  useSetOperatorQuoteLimit: () => mockMutation(),
}));
vi.mock("@/lib/auth/provider", () => ({ useCan: () => true }));
vi.mock("@/components/setup/operators-security", () => ({
  OperatorsSecurity: () => <div data-testid="operators-security" />,
}));

beforeEach(() => {
  mockOperators.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockMutation.mockReturnValue({ isPending: false, mutate: vi.fn() });
});

describe("SetupOperatorsPage guards", () => {
  it("renders skeleton while loading", () => {
    mockOperators.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<SetupOperatorsPage />);
    expect(screen.queryByTestId("operators-security")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockOperators.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<SetupOperatorsPage />);
    expect(screen.getByText("Failed to load operators.")).toBeInTheDocument();
  });
  it("renders EmptyState when no rows", () => {
    render(<SetupOperatorsPage />);
    expect(screen.getByText("No operators")).toBeInTheDocument();
  });
  it("renders the view with data + back link to /setup", () => {
    mockOperators.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ id: "op-dana", createdAt: "", updatedAt: "", version: 0, name: "Dana Mercer", initials: "DM", title: "Plant Manager", role: "manager", quoteAuthLimitCents: 100_000_00 }],
    });
    render(<SetupOperatorsPage />);
    expect(screen.getByTestId("operators-security")).toBeInTheDocument();
    expect(screen.getByText("Operators & Security")).toBeInTheDocument();
    expect(screen.getByText("Setup")).toBeInTheDocument();
  });
});

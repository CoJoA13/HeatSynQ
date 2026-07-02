import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupPricingPage from "./page";

const mockPriceKeys = vi.fn();
const mockCustomers = vi.fn();
const mockRules = vi.fn();
vi.mock("@/lib/query/hooks", () => ({
  usePriceKeys: () => mockPriceKeys(),
  useCustomers: () => mockCustomers(),
  usePricingRulesByPriceKey: () => mockRules(),
}));
vi.mock("@/components/setup/pricing-keys", () => ({
  PricingKeyCard: () => <div data-testid="pricing-key-card" />,
}));

const base = { createdAt: "", updatedAt: "", version: 0 };

beforeEach(() => {
  mockPriceKeys.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockCustomers.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockRules.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("SetupPricingPage guards", () => {
  it("renders skeleton while loading", () => {
    mockPriceKeys.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<SetupPricingPage />);
    expect(screen.queryByTestId("pricing-key-card")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockPriceKeys.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<SetupPricingPage />);
    expect(screen.getByText("Failed to load pricing.")).toBeInTheDocument();
  });
  it("renders EmptyState when no price keys", () => {
    render(<SetupPricingPage />);
    expect(screen.getByText("No price keys")).toBeInTheDocument();
  });
  it("renders a card per key with data", () => {
    mockPriceKeys.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ ...base, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" }],
    });
    render(<SetupPricingPage />);
    expect(screen.getByTestId("pricing-key-card")).toBeInTheDocument();
    expect(screen.getByText("Pricing & Price Keys")).toBeInTheDocument();
  });
});

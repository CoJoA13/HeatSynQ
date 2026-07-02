import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ShopFloorPage from "./page";

// Mock next/navigation so useRouter doesn't throw in jsdom
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Mutable mock state — each test configures its own scenario
const mockOrders = vi.fn();
const mockCustomers = vi.fn();
const mockEquipment = vi.fn();
const mockMaintenance = vi.fn();

vi.mock("@/lib/query/hooks", () => ({
  useWorkOrders: () => mockOrders(),
  useCustomers: () => mockCustomers(),
  useEquipment: () => mockEquipment(),
  useMaintenance: () => mockMaintenance(),
}));

// ShopFloorGrid renders all 10 equipment tiles via the roster; we just
// need to confirm the page renders without crashing in the happy path.
vi.mock("@/components/shop-floor/shop-floor-grid", () => ({
  ShopFloorGrid: () => <div data-testid="shop-floor-grid" />,
}));

beforeEach(() => {
  // Default: all queries succeed with empty data
  mockOrders.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockCustomers.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockEquipment.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockMaintenance.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("ShopFloorPage guards", () => {
  it("renders the skeleton when orders is loading", () => {
    mockOrders.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    // SkeletonRows renders skeleton placeholder rows; the grid must NOT render
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders the skeleton when only customers is loading (second-query loading guard)", () => {
    // orders succeeds; only customers is still loading
    mockCustomers.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders ErrorPanel when orders.isError", () => {
    mockOrders.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.getByText("Failed to load orders.")).toBeInTheDocument();
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders ErrorPanel when customers.isError (second-query guard)", () => {
    // orders succeeds; only customers fails
    mockCustomers.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.getByText("Failed to load customers.")).toBeInTheDocument();
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders the skeleton when only equipment is loading", () => {
    mockEquipment.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders ErrorPanel when equipment.isError", () => {
    mockEquipment.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.getByText("Failed to load equipment.")).toBeInTheDocument();
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders the skeleton when only maintenance is loading", () => {
    mockMaintenance.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders ErrorPanel when maintenance.isError", () => {
    mockMaintenance.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<ShopFloorPage />);
    expect(screen.getByText("Failed to load maintenance.")).toBeInTheDocument();
    expect(screen.queryByTestId("shop-floor-grid")).not.toBeInTheDocument();
  });

  it("renders the grid when all queries succeed", () => {
    render(<ShopFloorPage />);
    expect(screen.getByTestId("shop-floor-grid")).toBeInTheDocument();
  });
});

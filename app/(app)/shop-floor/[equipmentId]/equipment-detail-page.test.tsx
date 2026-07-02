import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import EquipmentDetailPage from "./page";

const mockUnit = vi.fn();
const mockEquipment = vi.fn();
const mockOrders = vi.fn();
const mockCustomers = vi.fn();
const mockMaintenance = vi.fn();
const mockSpecs = vi.fn();
const mockSetAvailability = vi.fn();
const mockComplete = vi.fn();

vi.mock("@/lib/auth/provider", () => ({ useCan: () => true }));
vi.mock("@/lib/query/hooks", () => ({
  useEquipmentUnit: () => mockUnit(),
  useEquipment: () => mockEquipment(),
  useWorkOrders: () => mockOrders(),
  useCustomers: () => mockCustomers(),
  useMaintenance: () => mockMaintenance(),
  useSpecifications: () => mockSpecs(),
  useSetEquipmentAvailability: () => ({ mutate: mockSetAvailability, isPending: false }),
  useCompleteMaintenance: () => ({ mutate: mockComplete, isPending: false }),
}));
vi.mock("@/components/shop-floor/equipment-detail", () => ({
  EquipmentDetail: (props: { onSetAvailability: (a: string, n: string | null) => void; onComplete: (t: unknown) => void }) => (
    <div data-testid="equipment-detail">
      <button data-testid="fire-set-availability" onClick={() => props.onSetAvailability("down", "note")}>set</button>
      <button data-testid="fire-complete" onClick={() => props.onComplete({ id: "m-1", version: 0 })}>complete</button>
    </div>
  ),
}));

const unit = {
  id: "eq-wash-1", createdAt: "", updatedAt: "", version: 2, name: "Wash Station", kind: "wash" as const,
  availability: "available" as const, note: null,
};
const ok = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });
const params = Promise.resolve({ equipmentId: "eq-wash-1" });

beforeEach(() => {
  mockSetAvailability.mockReset();
  mockComplete.mockReset();
  mockUnit.mockReturnValue(ok(unit));
  mockEquipment.mockReturnValue(ok([unit]));
  mockOrders.mockReturnValue(ok([]));
  mockCustomers.mockReturnValue(ok([]));
  mockMaintenance.mockReturnValue(ok([]));
  mockSpecs.mockReturnValue(ok([]));
});

describe("EquipmentDetailPage", () => {
  it("renders skeleton while the unit loads", () => {
    mockUnit.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<EquipmentDetailPage params={params} />);
    expect(screen.queryByTestId("equipment-detail")).not.toBeInTheDocument();
  });

  it("renders ErrorPanel when the unit errors", () => {
    mockUnit.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<EquipmentDetailPage params={params} />);
    expect(screen.getByText("Failed to load equipment.")).toBeInTheDocument();
  });

  it("renders Equipment not found for an unknown id", () => {
    mockUnit.mockReturnValue(ok(null));
    render(<EquipmentDetailPage params={params} />);
    expect(screen.getByText("Equipment not found")).toBeInTheDocument();
  });

  it("holds the skeleton while context queries load (no premature detail render)", () => {
    mockOrders.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<EquipmentDetailPage params={params} />);
    expect(screen.queryByTestId("equipment-detail")).not.toBeInTheDocument();
  });

  it("renders ErrorPanel when a context query errors", () => {
    mockMaintenance.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<EquipmentDetailPage params={params} />);
    expect(screen.getByText("Failed to load equipment context.")).toBeInTheDocument();
  });

  it("renders the detail once all queries succeed", async () => {
    render(<EquipmentDetailPage params={params} />);
    expect(await screen.findByTestId("equipment-detail")).toBeInTheDocument();
  });

  it("wires onSetAvailability to setAvailability.mutate with the equipment + args", async () => {
    render(<EquipmentDetailPage params={params} />);
    (await screen.findByTestId("fire-set-availability")).click();
    expect(mockSetAvailability).toHaveBeenCalledWith({ equipment: unit, availability: "down", note: "note" });
  });

  it("wires onComplete to complete.mutate with the task + DEMO_NOW", async () => {
    render(<EquipmentDetailPage params={params} />);
    (await screen.findByTestId("fire-complete")).click();
    expect(mockComplete).toHaveBeenCalledWith({ task: { id: "m-1", version: 0 }, at: "2026-06-30T12:00:00.000Z" });
  });
});

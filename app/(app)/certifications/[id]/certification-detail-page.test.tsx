import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CertificationDetailPage from "./page";

const mockCert = vi.fn();
const mockWorkOrder = vi.fn();
const mockCustomer = vi.fn();
const mockSpecs = vi.fn();
const mockRelease = vi.fn();

vi.mock("@/lib/auth/provider", () => ({ useCan: () => true }));
vi.mock("@/lib/query/hooks", () => ({
  useCertification: () => mockCert(),
  useWorkOrder: () => mockWorkOrder(),
  useCustomer: () => mockCustomer(),
  useSpecifications: () => mockSpecs(),
  useReleaseCertification: () => ({ mutate: mockRelease, isPending: false }),
}));
vi.mock("@/components/certifications/certification-detail", () => ({
  CertificationDetail: (props: { onRelease: () => void }) => (
    <button data-testid="cert-detail" onClick={props.onRelease}>detail</button>
  ),
}));

const cert = { id: "cert-9910", createdAt: "", updatedAt: "", version: 4, number: "C-9910", customerId: "cust-summit", workOrderId: "wo-48120", specificationId: "spec-sb4", type: "Customer spec SB-4", status: "pending", copies: 1 };
const ok = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });
const params = Promise.resolve({ id: "cert-9910" });

beforeEach(() => {
  mockRelease.mockReset();
  mockCert.mockReturnValue(ok(cert));
  mockWorkOrder.mockReturnValue(ok(null));
  mockCustomer.mockReturnValue(ok(null));
  mockSpecs.mockReturnValue(ok([]));
});

describe("CertificationDetailPage", () => {
  it("renders skeleton while the cert loads", () => {
    mockCert.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.queryByTestId("cert-detail")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel when the cert errors", () => {
    mockCert.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.getByText("Failed to load certification.")).toBeInTheDocument();
  });
  it("renders not-found for an unknown id", () => {
    mockCert.mockReturnValue(ok(null));
    render(<CertificationDetailPage params={params} />);
    expect(screen.getByText("Certification not found")).toBeInTheDocument();
  });
  it("holds the skeleton while context queries load (no premature action render)", () => {
    mockWorkOrder.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.queryByTestId("cert-detail")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel when a context query errors", () => {
    mockCustomer.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<CertificationDetailPage params={params} />);
    expect(screen.getByText("Failed to load certification context.")).toBeInTheDocument();
  });
  it("wires onRelease to release.mutate with id + version", async () => {
    render(<CertificationDetailPage params={params} />);
    (await screen.findByTestId("cert-detail")).click();
    expect(mockRelease).toHaveBeenCalledWith({ id: "cert-9910", version: 4 });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SetupCertDefaultsPage from "./page";

const mockCustomers = vi.fn();
const mockSpecs = vi.fn();
vi.mock("@/lib/query/hooks", () => ({
  useCustomers: () => mockCustomers(),
  useSpecifications: () => mockSpecs(),
}));
vi.mock("@/components/setup/cert-defaults", () => ({
  CertDefaults: () => <div data-testid="cert-defaults" />,
}));

beforeEach(() => {
  mockCustomers.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
  mockSpecs.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
});

describe("SetupCertDefaultsPage guards", () => {
  it("renders skeleton while loading", () => {
    mockCustomers.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<SetupCertDefaultsPage />);
    expect(screen.queryByTestId("cert-defaults")).not.toBeInTheDocument();
  });
  it("renders ErrorPanel on error", () => {
    mockSpecs.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch: vi.fn() });
    render(<SetupCertDefaultsPage />);
    expect(screen.getByText("Failed to load cert defaults.")).toBeInTheDocument();
  });
  it("renders EmptyState when no customers", () => {
    render(<SetupCertDefaultsPage />);
    expect(screen.getByText("No customers")).toBeInTheDocument();
  });
  it("renders the view with data", () => {
    mockCustomers.mockReturnValue({
      isLoading: false, isError: false, refetch: vi.fn(),
      data: [{ id: "cust-apex", createdAt: "", updatedAt: "", version: 0, name: "Apex Aerospace", defaultCertSpecId: null, defaultCertCopies: 0 }],
    });
    render(<SetupCertDefaultsPage />);
    expect(screen.getByTestId("cert-defaults")).toBeInTheDocument();
    expect(screen.getByText("Certifications & Forms")).toBeInTheDocument();
  });
});

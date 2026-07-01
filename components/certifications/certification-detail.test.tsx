import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CertificationDetail } from "./certification-detail";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

const base = { createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", version: 0 };
const pendingCert: Certification = { ...base, id: "cert-9910", number: "C-9910", customerId: "cust-summit", workOrderId: "wo-48120", specificationId: "spec-sb4", type: "Customer spec SB-4", status: "pending", copies: 1 };
const releasedCert: Certification = { ...pendingCert, status: "released" };
const readyWo = { ...base, id: "wo-48120", number: "WO-48120", status: "ready_to_ship", due: "2026-06-26T00:00:00.000Z", processSummary: "Neutral harden" } as unknown as WorkOrder;
const inProcessWo = { ...readyWo, status: "in_process" } as WorkOrder;
const customer = { ...base, id: "cust-summit", name: "Summit Bearing" } as unknown as Customer;
const spec = { ...base, id: "spec-sb4", code: "SB-4", rev: "2" } as unknown as Specification;

const renderDetail = (over: Partial<Parameters<typeof CertificationDetail>[0]> = {}) =>
  render(<CertificationDetail cert={pendingCert} workOrder={readyWo} customer={customer} specification={spec}
    canRelease busy={false} onRelease={vi.fn()} {...over} />);

describe("CertificationDetail", () => {
  it("renders cert fields, spec, and customer link", () => {
    renderDetail();
    expect(screen.getByText("C-9910")).toBeInTheDocument();
    expect(screen.getByText("SB-4 rev 2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Summit Bearing" })).toHaveAttribute("href", "/customers/cust-summit");
  });
  it("links to the work order and shows its status", () => {
    renderDetail();
    expect(screen.getByRole("link", { name: "WO-48120" })).toHaveAttribute("href", "/orders/wo-48120");
    expect(screen.getByText("Ready to ship")).toBeInTheDocument();
  });
  it("shows the blocking note only when pending + ready_to_ship", () => {
    renderDetail();
    expect(screen.getByText("This cert blocks shipment of WO-48120.")).toBeInTheDocument();
  });
  it("hides the blocking note when the order is not ready_to_ship", () => {
    renderDetail({ workOrder: inProcessWo });
    expect(screen.queryByText(/blocks shipment/)).not.toBeInTheDocument();
  });
  it("fires onRelease from the header action", async () => {
    const onRelease = vi.fn();
    renderDetail({ onRelease });
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
  it("hides Release when released or when the user cannot release", () => {
    renderDetail({ cert: releasedCert });
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    renderDetail({ canRelease: false });
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });
  it("renders a fallback when the work order is missing", () => {
    renderDetail({ workOrder: null });
    expect(screen.getByText("Work order not found.")).toBeInTheDocument();
  });
});

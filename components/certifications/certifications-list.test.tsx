import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CertificationsList } from "./certifications-list";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const certs: Certification[] = [
  { ...base, id: "cert-9921", number: "C-9921", customerId: "cust-apex", workOrderId: "wo-48211", specificationId: "spec-ams2759-3", type: "Carburize", status: "pending", copies: 2 },
  { ...base, id: "cert-9918", number: "C-9918", customerId: "cust-delta", workOrderId: "wo-48190", specificationId: "spec-mils6090", type: "Nitride", status: "released", copies: 1 },
];
const customers = [{ ...base, id: "cust-apex", name: "Apex Aerospace" }] as unknown as Customer[];
const workOrders = [{ ...base, id: "wo-48211", number: "WO-48211" }] as unknown as WorkOrder[];
const specs = [{ ...base, id: "spec-ams2759-3", code: "AMS 2759/3" }] as unknown as Specification[];

describe("CertificationsList", () => {
  it("renders certs with status and shows Release only on pending rows for managers", async () => {
    const onRelease = vi.fn();
    render(
      <CertificationsList certifications={certs} customers={customers} workOrders={workOrders}
        specifications={specs} canRelease onRelease={onRelease} />,
    );
    expect(screen.getByText("C-9921")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Released")).toBeInTheDocument();
    const releaseButtons = screen.getAllByRole("button", { name: /release/i });
    expect(releaseButtons).toHaveLength(1); // only the pending cert
    await userEvent.click(releaseButtons[0]);
    expect(onRelease).toHaveBeenCalledWith("cert-9921");
  });

  it("hides the Release action when the user cannot release", () => {
    render(
      <CertificationsList certifications={certs} customers={customers} workOrders={workOrders}
        specifications={specs} canRelease={false} onRelease={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
  });

  it("navigates on row click but NOT when Release is clicked", async () => {
    const onSelect = vi.fn();
    const onRelease = vi.fn();
    render(
      <CertificationsList certifications={certs} customers={customers} workOrders={workOrders}
        specifications={specs} canRelease onRelease={onRelease} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByText("C-9918"));
    expect(onSelect).toHaveBeenCalledWith("cert-9918");
    await userEvent.click(screen.getByRole("button", { name: /release/i }));
    expect(onRelease).toHaveBeenCalledWith("cert-9921");
    expect(onSelect).toHaveBeenCalledTimes(1); // Release click must not bubble into row navigation
  });
});

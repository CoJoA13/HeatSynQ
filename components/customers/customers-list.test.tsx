import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomersList } from "./customers-list";
import type { Customer, WorkOrder, Invoice } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const customers = [
  { ...base, id: "cust-apex", customerNumber: "1042", name: "Apex Aerospace", initials: "AA", city: "Wichita, KS", billingAddress: "", phone: "", terms: "Net 30", status: "active", priceKeyId: "pk-aero1", taxExempt: true, defaultCertSpecId: null, defaultCertCopies: 0, ytdSalesCents: 0 },
] as Customer[];
const orders = [
  { ...base, id: "wo1", customerId: "cust-apex", status: "in_process" },
  { ...base, id: "wo2", customerId: "cust-apex", status: "shipped" },
] as unknown as WorkOrder[];
const invoices = [
  { ...base, id: "i1", customerId: "cust-apex", status: "sent", amountCents: 674000 },
] as unknown as Invoice[];

describe("CustomersList", () => {
  it("renders computed open-order count and A/R balance, and fires select", async () => {
    const onSelect = vi.fn();
    render(<CustomersList customers={customers} workOrders={orders} invoices={invoices} onSelect={onSelect} />);
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("1042")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();       // 1 open order (shipped excluded)
    expect(screen.getByText("$6,740")).toBeInTheDocument();  // A/R balance
    expect(screen.getByText("Active")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Apex Aerospace"));
    expect(onSelect).toHaveBeenCalledWith("cust-apex");
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ARView } from "./ar-view";
import type { Invoice, Customer } from "@/lib/domain";

const baseCustomer: Customer = {
  id: "c1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  customerNumber: "1042",
  name: "Delta Turbine",
  initials: "DT",
  city: "Phoenix",
  billingAddress: "100 Industrial Way",
  phone: "555-0200",
  terms: "Net 30",
  status: "active",
  priceKeyId: null,
  taxExempt: false,
  defaultCertSpecId: null,
  defaultCertCopies: 1,
  ytdSalesCents: 0,
};

const customers: Customer[] = [baseCustomer];

// Invoice invoiced on 2026-01-01, Net 30 => due 2026-01-31
// asOf 2026-07-01 => 151 days past due => d90_plus bucket
const invoices: Invoice[] = [
  {
    id: "inv-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    number: "INV-00001",
    customerId: "c1",
    workOrderId: "wo-1",
    amountCents: 50000,
    status: "sent",
    shippedDate: "2026-01-01T00:00:00.000Z",
    invoicedDate: "2026-01-01T00:00:00.000Z",
    paidDate: null,
  },
];

const AS_OF = "2026-07-01T00:00:00.000Z";

describe("ARView", () => {
  it("shows aging tiles and a per-customer balance", () => {
    render(
      <ARView
        invoices={invoices}
        customers={customers}
        asOf={AS_OF}
        canClose
        onClosePeriod={vi.fn()}
        closedNote={null}
      />,
    );
    expect(screen.getByText(/Current/)).toBeInTheDocument();
    expect(screen.getByText("Delta Turbine")).toBeInTheDocument();
  });

  it("hides Close period button when canClose is false", () => {
    render(
      <ARView
        invoices={invoices}
        customers={customers}
        asOf={AS_OF}
        canClose={false}
        onClosePeriod={vi.fn()}
        closedNote={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /close period/i })).not.toBeInTheDocument();
  });

  it("Close period confirms then fires onClosePeriod", async () => {
    const onClose = vi.fn();
    render(
      <ARView
        invoices={invoices}
        customers={customers}
        asOf={AS_OF}
        canClose
        onClosePeriod={onClose}
        closedNote={null}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /close period/i }));
    await userEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows closedNote when provided", () => {
    render(
      <ARView
        invoices={invoices}
        customers={customers}
        asOf={AS_OF}
        canClose={false}
        onClosePeriod={vi.fn()}
        closedNote="Period closed — invoices are locked from edits (advisory)."
      />,
    );
    expect(screen.getByText(/Period closed/)).toBeInTheDocument();
  });
});

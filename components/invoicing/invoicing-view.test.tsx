import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InvoicingView } from "./invoicing-view";
import type { Invoice, Customer, WorkOrder } from "@/lib/domain";

const baseCustomer: Customer = {
  id: "c1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  customerNumber: "1042",
  name: "Apex Aerospace",
  initials: "AA",
  city: "Tucson",
  billingAddress: "123 Main St",
  phone: "555-0100",
  terms: "Net 30",
  status: "active",
  priceKeyId: null,
  taxExempt: false,
  defaultCertSpecId: null,
  defaultCertCopies: 1,
  ytdSalesCents: 0,
};

const customers: Customer[] = [baseCustomer];

const baseOrder: WorkOrder = {
  id: "wo-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  version: 1,
  number: "WO-48120",
  customerId: "c1",
  customerPO: "PO-999",
  quoteId: null,
  processSummary: "Carburize + Temper",
  processMasterId: null,
  status: "shipped",
  orderedDate: "2026-06-01T00:00:00.000Z",
  due: "2026-07-01T00:00:00.000Z",
  certifyRequired: false,
  certSpecId: null,
  orderValueCents: 320000,
  progressPct: 100,
  lines: [],
  pricing: [],
  steps: [],
  activity: [],
};

const orders: WorkOrder[] = [
  baseOrder,
  { ...baseOrder, id: "wo-2", number: "WO-48121" },
];

const invoices: Invoice[] = [
  {
    id: "inv-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    version: 1,
    number: null,
    customerId: "c1",
    workOrderId: "wo-1",
    amountCents: 320000,
    status: "to_bill",
    shippedDate: "2026-06-10T00:00:00.000Z",
    invoicedDate: null,
    paidDate: null,
  },
  {
    id: "inv-2",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    version: 1,
    number: null,
    customerId: "c1",
    workOrderId: "wo-2",
    amountCents: 150000,
    status: "to_bill",
    shippedDate: "2026-06-11T00:00:00.000Z",
    invoicedDate: null,
    paidDate: null,
  },
  {
    id: "inv-3",
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    version: 2,
    number: "INV-00001",
    customerId: "c1",
    workOrderId: "wo-1",
    amountCents: 500000,
    status: "sent",
    shippedDate: "2026-06-05T00:00:00.000Z",
    invoicedDate: "2026-06-12T00:00:00.000Z",
    paidDate: null,
  },
];

describe("InvoicingView", () => {
  it("To-bill tab lists to-bill invoices and fires onBill", async () => {
    const onBill = vi.fn();
    render(
      <InvoicingView
        invoices={invoices}
        customers={customers}
        orders={orders}
        busy={false}
        onBill={onBill}
        onPay={vi.fn()}
      />,
    );
    expect(screen.getByText("WO-48120")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /^bill$/i })[0]);
    expect(onBill).toHaveBeenCalled();
  });

  it("Sent tab exposes Record payment", async () => {
    render(
      <InvoicingView
        invoices={invoices}
        customers={customers}
        orders={orders}
        busy={false}
        onBill={vi.fn()}
        onPay={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /sent/i }));
    expect(
      screen.getByRole("button", { name: /record payment/i }),
    ).toBeInTheDocument();
  });

  it("to-bill rows show — for number (null)", () => {
    render(
      <InvoicingView
        invoices={invoices}
        customers={customers}
        orders={orders}
        busy={false}
        onBill={vi.fn()}
        onPay={vi.fn()}
      />,
    );
    // Both to-bill invoices have null number, so "—" should appear
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("Bill button is disabled when busy", () => {
    render(
      <InvoicingView
        invoices={invoices}
        customers={customers}
        orders={orders}
        busy={true}
        onBill={vi.fn()}
        onPay={vi.fn()}
      />,
    );
    const billButtons = screen.getAllByRole("button", { name: /^bill$/i });
    billButtons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("fires onPay when Record payment is clicked", async () => {
    const onPay = vi.fn();
    render(
      <InvoicingView
        invoices={invoices}
        customers={customers}
        orders={orders}
        busy={false}
        onBill={vi.fn()}
        onPay={onPay}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /sent/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /record payment/i }),
    );
    expect(onPay).toHaveBeenCalled();
  });
});

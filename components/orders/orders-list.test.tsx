import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrdersList } from "./orders-list";
import type { WorkOrder, Customer } from "@/lib/domain";

const customers = [{ id: "c1", name: "Apex Aerospace" } as Customer];
const orders = [{
  id: "wo1", number: "WO-48211", customerId: "c1", customerPO: "PO-999",
  quoteId: "q1", processSummary: "Carburize + Temper",
  processMasterId: null, status: "in_process",
  orderedDate: "2026-06-15T00:00:00.000Z", due: "2026-07-15T00:00:00.000Z",
  certifyRequired: false, certSpecId: null,
  orderValueCents: 320000, progressPct: 40,
  lines: [], pricing: [], steps: [], activity: [],
  createdAt: "", updatedAt: "", version: 0,
} as WorkOrder];

describe("OrdersList", () => {
  it("renders work order number, customer name, status pill and fires onSelect", async () => {
    const onSelect = vi.fn();
    render(<OrdersList orders={orders} customers={customers} onSelect={onSelect} />);
    expect(screen.getByText("WO-48211")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("In Process")).toBeInTheDocument();
    await userEvent.click(screen.getByText("WO-48211"));
    expect(onSelect).toHaveBeenCalledWith("wo1");
  });
});

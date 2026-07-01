import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuotesList } from "./quotes-list";
import type { Quote, Customer } from "@/lib/domain";

const customers = [{ id: "c1", name: "Apex Aerospace" } as Customer];
const quotes = [{
  id: "q1", number: "Q-2841", rev: 0, customerId: "c1", customerPO: "PO", status: "sent",
  salespersonId: "op", date: "2026-06-30T00:00:00.000Z", validUntil: "2026-07-30T00:00:00.000Z",
  requiredBy: null, discount: null, estCostCents: 0, notes: "", wonOrderId: null,
  parts: [{ id: "p", partId: "part", material: "4140", quantity: 1,
    lines: [{ id: "l", process: "Carburize", basis: "flat", qtyOrWeight: 1, rateCents: 80000, minChargeCents: null }] }],
  createdAt: "", updatedAt: "", version: 0,
} as Quote];

describe("QuotesList", () => {
  it("renders quote number, customer, total, status and fires onSelect", async () => {
    const onSelect = vi.fn();
    render(<QuotesList quotes={quotes} customers={customers} onSelect={onSelect} />);
    expect(screen.getByText("Q-2841")).toBeInTheDocument();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("$800")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Q-2841"));
    expect(onSelect).toHaveBeenCalledWith("q1");
  });
});

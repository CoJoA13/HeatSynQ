import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuoteView } from "./quote-view";
import type { Quote, Customer } from "@/lib/domain";

const sentQuote: Quote = {
  id: "q-sent",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  number: "Q-1001",
  rev: 0,
  customerId: "cust-apex",
  customerPO: "PO-999",
  status: "sent",
  salespersonId: "op-vance",
  date: "2026-01-01",
  validUntil: "2026-02-01",
  requiredBy: null,
  discount: null,
  estCostCents: 50000,
  notes: "",
  parts: [],
  wonOrderId: null,
};

const approveQuote: Quote = {
  ...sentQuote,
  id: "q-approve",
  status: "approve",
};

const cust: Customer = {
  id: "cust-apex",
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
  priceKeyId: "pk-1",
  taxExempt: false,
  defaultCertSpecId: null,
  defaultCertCopies: 1,
  ytdSalesCents: 0,
};

describe("QuoteView", () => {
  it("sent quote exposes won/lost/revise and fires onWin", async () => {
    const onWin = vi.fn();
    render(
      <QuoteView
        quote={sentQuote}
        customer={cust}
        parts={[]}
        canApprove={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onWin={onWin}
        onLose={vi.fn()}
        onRevise={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /mark won/i }));
    expect(onWin).toHaveBeenCalled();
  });

  it("sent quote shows mark lost and revise buttons", () => {
    render(
      <QuoteView
        quote={sentQuote}
        customer={cust}
        parts={[]}
        canApprove={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onWin={vi.fn()}
        onLose={vi.fn()}
        onRevise={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByRole("button", { name: /mark lost/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revise/i })).toBeInTheDocument();
  });

  it("approve quote with canApprove exposes approve/reject", () => {
    render(
      <QuoteView
        quote={approveQuote}
        customer={cust}
        parts={[]}
        canApprove
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onWin={vi.fn()}
        onLose={vi.fn()}
        onRevise={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("approve quote without canApprove hides approve/reject", () => {
    render(
      <QuoteView
        quote={approveQuote}
        customer={cust}
        parts={[]}
        canApprove={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onWin={vi.fn()}
        onLose={vi.fn()}
        onRevise={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject/i })).not.toBeInTheDocument();
  });
});

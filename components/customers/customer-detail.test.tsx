import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerDetail } from "./customer-detail";
import type { Customer, Contact, Part, WorkOrder, Invoice, PriceKey, PricingRule } from "@/lib/domain";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

const base = { createdAt: "", updatedAt: "", version: 0 };
const customer: Customer = {
  ...base, id: "cust-apex", customerNumber: "1042", name: "Apex Aerospace", initials: "AA",
  city: "Wichita, KS", billingAddress: "4120 Industrial Pkwy", phone: "(316) 555-0142",
  terms: "Net 30", status: "active", priceKeyId: "pk-aero1", taxExempt: true,
  defaultCertSpecId: "spec-ams2759-3", defaultCertCopies: 2, ytdSalesCents: 214_000_00,
};
const contacts = [{ ...base, id: "ct1", customerId: "cust-apex", name: "Sara Lin", role: "Buyer", email: "sara@apex.com", phone: "x" }] as Contact[];
const parts = [{ ...base, id: "p1", partNumber: "TS-4471", description: "Turbine shaft", customerId: "cust-apex", material: "4140 steel", drawingRev: "C", hardness: "Rc 58-62", caseDepth: "", specificationId: null, processMasterId: null, priceKeyId: null, inspectionScale: "", inspectionSample: "" }] as Part[];
const orders = [{ ...base, id: "wo1", number: "WO-48211", customerId: "cust-apex", customerPO: "", quoteId: null, processSummary: "Carburize + Temper", processMasterId: null, status: "in_process", orderedDate: "2026-06-26T00:00:00.000Z", due: "2026-07-02T00:00:00.000Z", certifyRequired: true, certSpecId: null, orderValueCents: 842000, progressPct: 68, lines: [], pricing: [], steps: [], activity: [] }] as WorkOrder[];
const invoices = [{ ...base, id: "i1", number: "INV-1", customerId: "cust-apex", workOrderId: "wo1", amountCents: 674000, status: "sent", shippedDate: "", invoicedDate: "2026-06-27T00:00:00.000Z", paidDate: null }] as Invoice[];
const priceKey: PriceKey = { ...base, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" };
const rules = [{ ...base, id: "pr1", priceKeyId: "pk-aero1", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 }] as PricingRule[];

function setup() {
  render(<CustomerDetail customer={customer} contacts={contacts} parts={parts} orders={orders} invoices={invoices} priceKey={priceKey} pricingRules={rules} />);
}

describe("CustomerDetail", () => {
  it("renders the header, status pill and Overview by default", () => {
    setup();
    expect(screen.getByText("Apex Aerospace")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Net 30")).toBeInTheDocument();
    expect(screen.getByText("$6,740")).toBeInTheDocument(); // computed A/R balance on Overview
  });
  it("shows contacts, parts and pricing on their tabs", async () => {
    setup();
    await userEvent.click(screen.getByRole("tab", { name: "Contacts" }));
    expect(await screen.findByText("Sara Lin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Parts" }));
    expect(await screen.findByText("TS-4471")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Pricing" }));
    expect(await screen.findByText("AERO-1")).toBeInTheDocument();
    expect(await screen.findByText("Carburize")).toBeInTheDocument();
  });
  it("shows an empty documents tab", async () => {
    setup();
    await userEvent.click(screen.getByRole("tab", { name: "Documents" }));
    expect(await screen.findByText(/no documents/i)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderDetail } from "./order-detail";
import type { WorkOrder, Customer, ProcessMaster, Certification } from "@/lib/domain";

const baseOrder: WorkOrder = {
  id: "wo-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  version: 1,
  number: "WO-48211",
  customerId: "c1",
  customerPO: "PO-999",
  quoteId: "q1",
  processSummary: "Carburize + Temper",
  processMasterId: "pm-1",
  status: "ready_to_ship",
  orderedDate: "2026-06-01T00:00:00.000Z",
  due: "2026-07-01T00:00:00.000Z",
  certifyRequired: true,
  certSpecId: "spec-1",
  orderValueCents: 320000,
  progressPct: 80,
  lines: [],
  pricing: [{ process: "Carburize", detail: "600 lb", amountCents: 320000 }],
  steps: [],
  activity: [{ at: "2026-06-01T00:00:00.000Z", actor: "System", message: "Order created" }],
};

const certReqOrder: WorkOrder = { ...baseOrder, status: "ready_to_ship", certifyRequired: true };

const cust: Customer = {
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
  defaultCertSpecId: "spec-1",
  defaultCertCopies: 1,
  ytdSalesCents: 0,
};

const pm: ProcessMaster = {
  id: "pm-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  code: "PM-CARB-58",
  name: "Carburize & Temper",
  description: "Standard carburize process",
  rev: "A",
  status: "active",
  steps: [
    { n: 1, op: "Carburize", equip: "Furnace A", instr: "", params: ["920°C", "2h"], track: "track_in" },
  ],
  surfaceHardness: "62 HRC",
  caseDepth: "0.030\"",
  hardnessScale: "HRC",
};

const pendingCert: Certification = {
  id: "cert-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  version: 1,
  number: "C-9921",
  customerId: "c1",
  workOrderId: "wo-1",
  specificationId: "spec-1",
  type: "Carburize + Temper",
  status: "pending",
  copies: 1,
};

const releasedCert: Certification = { ...pendingCert, status: "released" };

describe("OrderDetail", () => {
  it("blocks ship when a required cert is pending, with the reason", () => {
    render(
      <OrderDetail
        order={certReqOrder}
        customer={cust}
        processMaster={pm}
        cert={pendingCert}
        canRelease
        busy={false}
        onRelease={vi.fn()}
        onTransition={vi.fn()}
        onShip={vi.fn()}
      />,
    );
    const ship = screen.getByRole("button", { name: /^ship$/i });
    expect(ship).toBeDisabled();
    expect(screen.getByText(/certification must be released before ship/i)).toBeInTheDocument();
  });

  it("allows ship when cert released and fires onShip", async () => {
    const onShip = vi.fn();
    render(
      <OrderDetail
        order={{ ...certReqOrder, status: "ready_to_ship" }}
        customer={cust}
        processMaster={pm}
        cert={releasedCert}
        canRelease={false}
        busy={false}
        onRelease={vi.fn()}
        onTransition={vi.fn()}
        onShip={onShip}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^ship$/i }));
    expect(onShip).toHaveBeenCalled();
  });

  it("shows Release for a pending cert when canRelease", () => {
    render(
      <OrderDetail
        order={certReqOrder}
        customer={cust}
        processMaster={pm}
        cert={pendingCert}
        canRelease
        busy={false}
        onRelease={vi.fn()}
        onTransition={vi.fn()}
        onShip={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument();
  });
});

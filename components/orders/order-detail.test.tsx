import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderDetail } from "./order-detail";
import type { WorkOrder, Customer, ProcessMaster, Certification, OrderStep } from "@/lib/domain";

function ostep(p: Partial<OrderStep> & Pick<OrderStep, "n" | "op" | "track" | "state">): OrderStep {
  return {
    equip: "Batch IQ #3", instr: "", params: [], areaId: "in_process",
    operatorId: null, operatorInitials: null, trackedInAt: null, trackedOutAt: null, inspectResult: null, ...p,
  };
}

const cust: Customer = {
  id: "c1", createdAt: "", updatedAt: "", version: 1, customerNumber: "1042", name: "Apex Aerospace",
  initials: "AA", city: "", billingAddress: "", phone: "", terms: "Net 30", status: "active",
  priceKeyId: null, taxExempt: false, defaultCertSpecId: "spec-1", defaultCertCopies: 1, ytdSalesCents: 0,
};
const heldCust: Customer = { ...cust, status: "hold" };

const baseOrder: WorkOrder = {
  id: "wo-1", createdAt: "", updatedAt: "", version: 1, number: "WO-48211", customerId: "c1",
  customerPO: "PO-999", quoteId: "q1", processSummary: "Carburize + Temper", processMasterId: "pm-1",
  status: "in_process", orderedDate: "2026-06-01T00:00:00.000Z", due: "2026-07-01T00:00:00.000Z",
  certifyRequired: true, certSpecId: "spec-1", orderValueCents: 320000, progressPct: 0,
  lines: [], pricing: [{ process: "Carburize", detail: "600 lb", amountCents: 320000 }],
  steps: [
    ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "done" }),
    ostep({ n: 2, op: "Temper", track: "track_in_out", state: "pending" }),
  ],
  activity: [{ at: "2026-06-01T00:00:00.000Z", actor: "System", message: "Order received" }],
};

const pm: ProcessMaster = {
  id: "pm-1", createdAt: "", updatedAt: "", version: 1, code: "PM-CARB-58", name: "Carburize & Temper",
  description: "", rev: "A", status: "active",
  steps: [{ n: 1, op: "Carburize", equip: "Furnace A", instr: "", params: [], track: "track_in_out" }],
  surfaceHardness: "62 HRC", caseDepth: "0.030\"", hardnessScale: "HRC",
};

const pendingCert: Certification = {
  id: "cert-1", createdAt: "", updatedAt: "", version: 1, number: "C-9921", customerId: "c1",
  workOrderId: "wo-1", specificationId: "spec-1", type: "Carburize + Temper", status: "pending", copies: 1,
};
const releasedCert: Certification = { ...pendingCert, status: "released" };

const readyOrder: WorkOrder = {
  ...baseOrder, status: "ready_to_ship",
  steps: [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "done" })],
};

function noop() {}
const handlers = { onRelease: noop, onShip: noop, onTrackIn: noop, onTrackOut: noop, onHold: noop, onResume: noop };

describe("OrderDetail traveler", () => {
  it("shows the Track Out action on the active step and fires onTrackOut", async () => {
    const onTrackOut = vi.fn();
    render(<OrderDetail order={{ ...baseOrder, steps: [ostep({ n: 1, op: "Carburize", track: "track_in_out", state: "in_process" })] }}
      customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} onTrackOut={onTrackOut} />);
    const row = screen.getByTestId("traveler-step-1");
    await userEvent.click(within(row).getByRole("button", { name: "Track Out" }));
    expect(onTrackOut).toHaveBeenCalledWith(1, undefined);
  });

  it("offers Pass/Fail on an inspect step and passes the result", async () => {
    const onTrackOut = vi.fn();
    render(<OrderDetail order={{ ...baseOrder, steps: [ostep({ n: 1, op: "Final inspect", track: "inspect", state: "pending", areaId: "final_inspect" })] }}
      customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} onTrackOut={onTrackOut} />);
    const row = screen.getByTestId("traveler-step-1");
    await userEvent.click(within(row).getByRole("button", { name: "Pass" }));
    expect(onTrackOut).toHaveBeenCalledWith(1, "pass");
  });

  it("does NOT render manual forward-status buttons", () => {
    render(<OrderDetail order={baseOrder} customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} />);
    expect(screen.queryByRole("button", { name: "Ready to ship" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scheduled" })).not.toBeInTheDocument();
  });

  it("blocks ship for a credit-hold customer with a reason", () => {
    render(<OrderDetail order={readyOrder} customer={heldCust} processMaster={pm} cert={releasedCert} canRelease={false} busy={false} {...handlers} />);
    expect(screen.getByRole("button", { name: /^ship$/i })).toBeDisabled();
    expect(screen.getByText(/credit hold/i)).toBeInTheDocument();
  });

  it("allows ship when cert released + customer active and fires onShip", async () => {
    const onShip = vi.fn();
    render(<OrderDetail order={readyOrder} customer={cust} processMaster={pm} cert={releasedCert} canRelease={false} busy={false} {...handlers} onShip={onShip} />);
    await userEvent.click(screen.getByRole("button", { name: /^ship$/i }));
    expect(onShip).toHaveBeenCalled();
  });

  it("shows Release for a pending cert when canRelease", () => {
    render(<OrderDetail order={readyOrder} customer={cust} processMaster={pm} cert={pendingCert} canRelease busy={false} {...handlers} />);
    expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument();
  });
});

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import { useRepositories } from "@/lib/data/provider";
import { usePart, useUpdatePart, useCertifications, useReleaseCertification, useQuotes, useWorkOrders, useWinQuote, useShipOrder, useInvoices, useBillInvoice, usePayInvoice, useTrackInStep, useTrackOutStep, useOperators, useCustomers } from "@/lib/query/hooks";

// ---------------------------------------------------------------------------
// Probe A: useUpdatePart
// ---------------------------------------------------------------------------
function UpdatePartProbe() {
  const part = usePart("part-ts4471");
  const update = useUpdatePart();

  function handleClick() {
    if (!part.data) return;
    update.mutate({
      id: "part-ts4471",
      patch: { description: "Turbine shaft REV D" },
      version: part.data.version,
    });
  }

  return (
    <div>
      <div data-testid="description">{part.data?.description ?? "loading"}</div>
      <button onClick={handleClick} disabled={!part.data}>
        Update
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probe B: useReleaseCertification
// ---------------------------------------------------------------------------
function ReleaseCertProbe() {
  const certs = useCertifications();
  const release = useReleaseCertification();

  const pendingCert = certs.data?.find((c) => c.id === "cert-9921");

  function handleClick() {
    if (!pendingCert) return;
    release.mutate({ id: "cert-9921", version: pendingCert.version });
  }

  const pendingNumbers = certs.data
    ? certs.data.filter((c) => c.status === "pending").map((c) => c.number).join(",")
    : "loading";

  return (
    <div>
      <div data-testid="pending">{pendingNumbers}</div>
      <button onClick={handleClick} disabled={!pendingCert}>
        Release
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probe C: useWinQuote
// ---------------------------------------------------------------------------
function WinQuoteProbe() {
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const win = useWinQuote();
  const q = quotes.data?.find((x) => x.id === "q-2840"); // sent, Midwest, certifyRequired via customer? Midwest defaultCertSpecId null → cert not required
  const orderCount = orders.data?.length ?? 0;
  return (
    <div>
      <div data-testid="status">{q?.status ?? "loading"}</div>
      <div data-testid="orders">{orderCount}</div>
      <button onClick={() => q && win.mutate(q)} disabled={!q}>Win</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("mutation hooks — write + version + invalidation", () => {
  it("useUpdatePart: persists write, passes correct version, invalidates part cache", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UpdatePartProbe />);

    // Wait for initial load
    expect(await screen.findByText("Turbine shaft")).toBeInTheDocument();

    // Fire the mutation
    await user.click(screen.getByRole("button", { name: "Update" }));

    // After invalidation + refetch, the updated description must appear
    expect(await screen.findByText("Turbine shaft REV D")).toBeInTheDocument();
  });

  it("useReleaseCertification: persists release, invalidates certifications cache", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReleaseCertProbe />);

    // cert-9921 (C-9921) should appear among pending initially
    await screen.findByText(/C-9921/);

    // Fire the mutation
    await user.click(screen.getByRole("button", { name: "Release" }));

    // After invalidation + refetch, C-9921 is no longer pending so it drops from the display
    await waitFor(() => expect(screen.queryByText(/C-9921/)).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Probe C2: useWinQuote with a STALE version — must throw before any side effect
// ---------------------------------------------------------------------------
function WinStaleQuoteProbe() {
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const win = useWinQuote();
  const q = quotes.data?.find((x) => x.id === "q-2840");
  const orderCount = orders.data?.length ?? 0;
  return (
    <div>
      <div data-testid="win-error">{win.isError ? "error" : "ok"}</div>
      <div data-testid="status">{q?.status ?? "loading"}</div>
      <div data-testid="orders">{orderCount}</div>
      {/* pass a deliberately stale version → optimistic-concurrency conflict */}
      <button onClick={() => q && win.mutate({ ...q, version: q.version - 1 })} disabled={!q}>WinStale</button>
    </div>
  );
}

describe("quote mutations", () => {
  it("useWinQuote: creates an order and marks the quote won", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WinQuoteProbe />);
    await screen.findByText("sent");
    const before = Number(screen.getByTestId("orders").textContent);
    await user.click(screen.getByRole("button", { name: "Win" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("won"));
    await waitFor(() => expect(Number(screen.getByTestId("orders").textContent)).toBe(before + 1));
  });

  it("useWinQuote: a stale version throws and creates NO work order (version-check first)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WinStaleQuoteProbe />);
    await screen.findByText("sent");
    const before = Number(screen.getByTestId("orders").textContent);
    await user.click(screen.getByRole("button", { name: "WinStale" }));
    await waitFor(() => expect(screen.getByTestId("win-error").textContent).toBe("error"));
    // quote stays sent and no orphan order was created
    expect(screen.getByTestId("status").textContent).toBe("sent");
    expect(Number(screen.getByTestId("orders").textContent)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Probe D: useShipOrder — idempotent invoice on an order that already has one
// wo-48120 is ready_to_ship and already has inv-summit-48120 (to_bill).
// ---------------------------------------------------------------------------
function ShipExistingInvoiceProbe() {
  const orders = useWorkOrders();
  const certs = useCertifications();
  const invoices = useInvoices();
  const ship = useShipOrder();
  const order = orders.data?.find((o) => o.id === "wo-48120");
  const cert = certs.data?.find((c) => c.workOrderId === "wo-48120") ?? null;
  const invForOrder = invoices.data?.filter((i) => i.workOrderId === "wo-48120").length ?? 0;
  return (
    <div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <div data-testid="inv-for-order">{invForOrder}</div>
      <button disabled={!order} onClick={() => order && ship.mutate({ order, cert, actor: "Test", at: "2026-07-01T00:00:00.000Z" })}>Ship</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probe D2: useShipOrder — a freshly created ready_to_ship, non-cert order with
// no invoice yet gets exactly one to-bill invoice on ship.
// ---------------------------------------------------------------------------
function ShipFreshOrderProbe() {
  const repos = useRepositories();
  const invoices = useInvoices();
  const ship = useShipOrder();
  const [orderId, setOrderId] = useState<string | null>(null);
  const invForOrder = orderId ? (invoices.data?.filter((i) => i.workOrderId === orderId).length ?? 0) : 0;

  async function createAndShip() {
    const order = await repos.workOrders.create({
      customerId: "cust-vulcan", customerPO: "PO-FRESH", quoteId: null,
      processSummary: "Anneal", processMasterId: null, status: "ready_to_ship",
      orderedDate: "2026-06-30T00:00:00.000Z", due: "2026-07-10T00:00:00.000Z",
      certifyRequired: false, certSpecId: null, orderValueCents: 5000, progressPct: 90,
      lines: [], pricing: [], steps: [], activity: [],
    });
    setOrderId(order.id);
    await ship.mutateAsync({ order, cert: null, actor: "Test", at: "2026-07-01T00:00:00.000Z" });
  }

  return (
    <div>
      <div data-testid="order-id">{orderId ?? "none"}</div>
      <div data-testid="inv-for-order">{invForOrder}</div>
      <button onClick={createAndShip}>CreateAndShip</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probe D3: useShipOrder — a STALE order (wrong version) throws and creates NO invoice.
// Uses a fresh, non-cert ready_to_ship order that has no invoice yet, then ships it
// with a deliberately stale version → version-check must fire BEFORE the invoice write.
// ---------------------------------------------------------------------------
function ShipStaleOrderProbe() {
  const repos = useRepositories();
  const invoices = useInvoices();
  const ship = useShipOrder();
  const [orderId, setOrderId] = useState<string | null>(null);
  const invForOrder = orderId ? (invoices.data?.filter((i) => i.workOrderId === orderId).length ?? 0) : 0;

  async function createAndShipStale() {
    const order = await repos.workOrders.create({
      customerId: "cust-vulcan", customerPO: "PO-STALE", quoteId: null,
      processSummary: "Anneal", processMasterId: null, status: "ready_to_ship",
      orderedDate: "2026-06-30T00:00:00.000Z", due: "2026-07-10T00:00:00.000Z",
      certifyRequired: false, certSpecId: null, orderValueCents: 5000, progressPct: 90,
      lines: [], pricing: [], steps: [], activity: [],
    });
    setOrderId(order.id);
    // Deliberately stale version → optimistic-concurrency conflict in the WO update.
    await ship.mutateAsync({ order: { ...order, version: order.version - 1 }, cert: null, actor: "Test", at: "2026-07-01T00:00:00.000Z" });
  }

  return (
    <div>
      <div data-testid="ship-error">{ship.isError ? "error" : "ok"}</div>
      <div data-testid="order-id">{orderId ?? "none"}</div>
      <div data-testid="inv-for-order">{invForOrder}</div>
      <button onClick={() => { createAndShipStale().catch(() => {}); }}>CreateAndShipStale</button>
    </div>
  );
}

describe("order mutations", () => {
  it("useShipOrder: a stale order (wrong version) throws and creates NO invoice", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipStaleOrderProbe />);
    await user.click(screen.getByRole("button", { name: "CreateAndShipStale" }));
    await waitFor(() => expect(screen.getByTestId("order-id").textContent).not.toBe("none"));
    await waitFor(() => expect(screen.getByTestId("ship-error").textContent).toBe("error"));
    // version-check fired before the invoice write → no orphan invoice for this order
    await waitFor(() => expect(screen.getByTestId("inv-for-order").textContent).toBe("0"));
  });

  it("useShipOrder: shipping an order that already has an invoice does NOT create a duplicate", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipExistingInvoiceProbe />);
    await screen.findByText("ready_to_ship");
    await waitFor(() => expect(screen.getByTestId("inv-for-order").textContent).toBe("1"));
    await user.click(screen.getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("shipped"));
    // still exactly one invoice for wo-48120 — no duplicate created
    await waitFor(() => expect(screen.getByTestId("inv-for-order").textContent).toBe("1"));
  });

  it("useShipOrder: shipping a fresh order with no invoice creates exactly one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipFreshOrderProbe />);
    await user.click(screen.getByRole("button", { name: "CreateAndShip" }));
    await waitFor(() => expect(screen.getByTestId("order-id").textContent).not.toBe("none"));
    await waitFor(() => expect(screen.getByTestId("inv-for-order").textContent).toBe("1"));
  });
});

// ---------------------------------------------------------------------------
// Probe E: useBillInvoice
// ---------------------------------------------------------------------------
function BillProbe() {
  const invoices = useInvoices();
  const bill = useBillInvoice();
  const inv = invoices.data?.find((i) => i.id === "inv-summit-48120");
  return (
    <div>
      <div data-testid="num">{inv?.number ?? "null"}</div>
      <div data-testid="status">{inv?.status ?? "loading"}</div>
      <button disabled={!inv} onClick={() => inv && bill.mutate({ invoice: inv, at: "2026-07-01T00:00:00.000Z" })}>Bill</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probe F: usePayInvoice
// ---------------------------------------------------------------------------
function PayProbe() {
  const invoices = useInvoices();
  const pay = usePayInvoice();
  const inv = invoices.data?.find((i) => i.id === "inv-30412");
  return (
    <div>
      <div data-testid="pay-status">{inv?.status ?? "loading"}</div>
      <div data-testid="paid-date">{inv?.paidDate ?? "null"}</div>
      <button disabled={!inv} onClick={() => inv && pay.mutate({ invoice: inv, at: "2026-07-01T00:00:00.000Z" })}>Pay</button>
    </div>
  );
}

describe("invoice mutations", () => {
  it("useBillInvoice: assigns INV-30413 and sets status to sent", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillProbe />);
    await waitFor(() => expect(screen.getByTestId("num").textContent).toBe("null"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("to_bill"));
    await user.click(screen.getByRole("button", { name: "Bill" }));
    await waitFor(() => expect(screen.getByTestId("num").textContent).toBe("INV-30413"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("sent"));
  });

  it("usePayInvoice: sets status to paid and records paidDate", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayProbe />);
    await waitFor(() => expect(screen.getByTestId("pay-status").textContent).toBe("sent"));
    await waitFor(() => expect(screen.getByTestId("paid-date").textContent).toBe("null"));
    await user.click(screen.getByRole("button", { name: "Pay" }));
    await waitFor(() => expect(screen.getByTestId("pay-status").textContent).toBe("paid"));
    await waitFor(() => expect(screen.getByTestId("paid-date").textContent).toBe("2026-07-01T00:00:00.000Z"));
  });
});

// ---------------------------------------------------------------------------
// Probe G: useTrackInStep / useTrackOutStep drive status + progress
// wo-48098 (Vulcan) is ready_to_ship in seed; use wo-48211 (Apex, in_process) which
// starts with step 1 done, step 2 in_process (Wash & rack), rest pending.
// ---------------------------------------------------------------------------
function TrackProbe() {
  const orders = useWorkOrders();
  const ops = useOperators();
  const trackIn = useTrackInStep();
  const trackOut = useTrackOutStep();
  const order = orders.data?.find((o) => o.id === "wo-48211");
  const operator = ops.data?.find((o) => o.id === "op-dana");
  return (
    <div>
      <div data-testid="progress">{order?.progressPct ?? "loading"}</div>
      <div data-testid="step2">{order?.steps.find((s) => s.n === 2)?.state ?? "loading"}</div>
      <div data-testid="step3">{order?.steps.find((s) => s.n === 3)?.state ?? "loading"}</div>
      <button
        disabled={!order || !operator}
        onClick={() => order && operator && trackIn.mutate({ order, stepN: 3, operator })}
      >TrackIn3</button>
      <button
        disabled={!order || !operator}
        onClick={() => order && operator && trackOut.mutate({ order, stepN: 2, operator, cert: null })}
      >TrackOut2</button>
    </div>
  );
}

// Probe H: inspect pass auto-releases the pending cert.
// wo-48211 has cert-9921 (pending). Track out its Final inspect (step 5) with pass.
function InspectPassProbe() {
  const orders = useWorkOrders();
  const certs = useCertifications();
  const ops = useOperators();
  const trackOut = useTrackOutStep();
  const order = orders.data?.find((o) => o.id === "wo-48211");
  const operator = ops.data?.find((o) => o.id === "op-dana");
  const cert = certs.data?.find((c) => c.workOrderId === "wo-48211") ?? null;
  return (
    <div>
      <div data-testid="cert-status">{cert?.status ?? "loading"}</div>
      <button
        disabled={!order || !operator}
        onClick={() => order && operator && trackOut.mutate({ order, stepN: 5, operator, cert, inspectResult: "pass" })}
      >InspectPass</button>
    </div>
  );
}

// Probe I: shipping a credit-hold customer's order is blocked.
function ShipHeldProbe() {
  const orders = useWorkOrders();
  const customers = useCustomers();
  const ship = useShipOrder();
  const order = orders.data?.find((o) => o.id === "wo-48098"); // Vulcan, ready_to_ship
  const customer = customers.data?.find((c) => c.id === "cust-vulcan") ?? null;
  return (
    <div>
      <div data-testid="ship-error">{ship.isError ? "error" : "ok"}</div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <button
        disabled={!order}
        onClick={() => order && ship.mutate({ order, cert: null, customer, actor: "Test", at: "2026-07-01T00:00:00.000Z" })}
      >ShipHeld</button>
    </div>
  );
}

describe("tracking mutations", () => {
  it("useTrackInStep: moves a pending step to in_process", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackProbe />);
    await waitFor(() => expect(screen.getByTestId("step3").textContent).toBe("pending"));
    await user.click(screen.getByRole("button", { name: "TrackIn3" }));
    await waitFor(() => expect(screen.getByTestId("step3").textContent).toBe("in_process"));
  });

  it("useTrackOutStep: completes a step and advances progress", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackProbe />);
    await waitFor(() => expect(screen.getByTestId("step2").textContent).toBe("in_process"));
    await user.click(screen.getByRole("button", { name: "TrackOut2" }));
    await waitFor(() => expect(screen.getByTestId("step2").textContent).toBe("done"));
    await waitFor(() => expect(Number(screen.getByTestId("progress").textContent)).toBe(33)); // 2 of 6 trackable
  });

  it("useTrackOutStep: inspect pass auto-releases the pending cert", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InspectPassProbe />);
    await waitFor(() => expect(screen.getByTestId("cert-status").textContent).toBe("pending"));
    await user.click(screen.getByRole("button", { name: "InspectPass" }));
    await waitFor(() => expect(screen.getByTestId("cert-status").textContent).toBe("released"));
  });

  it("useShipOrder: a credit-hold customer's order cannot ship", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipHeldProbe />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready_to_ship"));
    await user.click(screen.getByRole("button", { name: "ShipHeld" }));
    await waitFor(() => expect(screen.getByTestId("ship-error").textContent).toBe("error"));
    expect(screen.getByTestId("status").textContent).toBe("ready_to_ship"); // not shipped
  });
});

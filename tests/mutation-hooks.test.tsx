import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import { usePart, useUpdatePart, useCertifications, useReleaseCertification, useQuotes, useWorkOrders, useWinQuote, useShipOrder, useInvoices, useBillInvoice, usePayInvoice } from "@/lib/query/hooks";

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
});

// ---------------------------------------------------------------------------
// Probe D: useShipOrder
// ---------------------------------------------------------------------------
function ShipProbe() {
  const orders = useWorkOrders();
  const certs = useCertifications();
  const invoices = useInvoices();
  const ship = useShipOrder();
  const order = orders.data?.find((o) => o.id === "wo-48120");
  const cert = certs.data?.find((c) => c.workOrderId === "wo-48120") ?? null;
  return (
    <div>
      <div data-testid="status">{order?.status ?? "loading"}</div>
      <div data-testid="invoices">{invoices.data?.length ?? 0}</div>
      <button disabled={!order} onClick={() => order && ship.mutate({ order, cert, actor: "Test", at: "2026-07-01T00:00:00.000Z" })}>Ship</button>
    </div>
  );
}

describe("order mutations", () => {
  it("useShipOrder: sets status to shipped and creates to-bill invoice", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipProbe />);
    await screen.findByText("ready_to_ship");
    const before = Number(screen.getByTestId("invoices").textContent);
    await user.click(screen.getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("shipped"));
    await waitFor(() => expect(Number(screen.getByTestId("invoices").textContent)).toBe(before + 1));
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

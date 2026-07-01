import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import { usePart, useUpdatePart, useCertifications, useReleaseCertification, useQuotes, useWorkOrders, useWinQuote } from "@/lib/query/hooks";

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

import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import { useAuth, useCan } from "@/lib/auth/provider";

// Regression: `useCan` must follow the authenticated operator's real role,
// never the display-only `viewAs` dashboard preview. Switching the preview
// persona must not grant or revoke permissions.
function CanProbe() {
  const { operator, setViewAs, login } = useAuth();
  const canRelease = useCan("release_cert");
  return (
    <div>
      <div data-testid="who">{operator?.role ?? "none"}</div>
      <div data-testid="can">{canRelease ? "yes" : "no"}</div>
      <button onClick={() => setViewAs("sales")}>preview-sales</button>
      <button onClick={() => login("op-vance")}>login-sales</button>
    </div>
  );
}

describe("useCan is decoupled from the dashboard 'Viewing as' preview", () => {
  it("keeps a manager's permission when previewing another persona", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CanProbe />);
    // auto-login = op-dana (manager) -> release_cert allowed
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("manager"));
    expect(screen.getByTestId("can")).toHaveTextContent("yes");

    // Previewing the Sales dashboard must NOT drop the manager's permission.
    await user.click(screen.getByRole("button", { name: "preview-sales" }));
    expect(screen.getByTestId("can")).toHaveTextContent("yes");
  });

  it("reflects the real operator role, not the preview, for a non-manager", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CanProbe />);
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("manager"));

    // Actually authenticating as a sales operator revokes the manager-only action.
    await user.click(screen.getByRole("button", { name: "login-sales" }));
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("sales"));
    expect(screen.getByTestId("can")).toHaveTextContent("no");
  });
});

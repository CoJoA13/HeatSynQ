import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/tests/utils";
import TodayPage from "./page";

describe("TodayPage (integration)", () => {
  it("wires seed data through dashboardKpis into the manager dashboard", async () => {
    renderWithProviders(<TodayPage />);
    // default viewAs = manager (AuthProvider auto-logs in op-dana);
    // these two labels are manager-only and date-independent.
    expect(await screen.findByText("Open Orders")).toBeInTheDocument();
    expect(await screen.findByText("Certs Awaiting Release")).toBeInTheDocument();
  });
});

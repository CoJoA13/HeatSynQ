import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/tests/utils";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import TodayPage from "./page";

describe("TodayPage (integration)", () => {
  it("wires seed data through dashboardKpis into the manager dashboard", async () => {
    renderWithProviders(<TodayPage />);
    // default viewAs = manager (AuthProvider auto-logs in op-dana);
    // these two labels are manager-only and date-independent.
    expect(await screen.findByText("Open Orders")).toBeInTheDocument();
    expect(await screen.findByText("Certs Awaiting Release")).toBeInTheDocument();
  });

  it("shows an error state (not misleading zeros) when the queries fail", async () => {
    // failRate:1 makes every repo call reject, so all four dashboard queries error.
    renderWithProviders(<TodayPage />, {
      repositories: createMockRepositories({ latencyMs: 0, failRate: 1 }),
    });
    expect(await screen.findByText("Failed to load dashboard data.")).toBeInTheDocument();
    // The dashboard must not have rendered zeroed KPIs.
    expect(screen.queryByText("Open Orders")).not.toBeInTheDocument();
  });
});

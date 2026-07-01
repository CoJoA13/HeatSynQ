import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodayDashboard } from "./today-dashboard";
import type { KpiDescriptor } from "@/lib/logic/dashboard";

const tiles: KpiDescriptor[] = [
  { label: "Open Orders", value: "7", sub: "2 late" },
  { label: "Late Orders", value: "2", tone: "danger" },
];

describe("TodayDashboard", () => {
  it("renders the greeting, role switch and KPI tiles", () => {
    render(<TodayDashboard greeting="Good day, Dana" viewAs="manager" onViewAs={() => {}} tiles={tiles} />);
    expect(screen.getByText("Good day, Dana")).toBeInTheDocument();
    expect(screen.getByText("Open Orders")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
  it("fires onViewAs when a role is chosen", async () => {
    const onViewAs = vi.fn();
    render(<TodayDashboard greeting="Hi" viewAs="manager" onViewAs={onViewAs} tiles={tiles} />);
    await userEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(onViewAs).toHaveBeenCalledWith("sales");
  });
});

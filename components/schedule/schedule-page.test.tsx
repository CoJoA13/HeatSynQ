import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/tests/utils";
import SchedulePage from "@/app/(app)/schedule/page";

describe("SchedulePage", () => {
  it("renders the board with the seeded planned block after load", async () => {
    renderWithProviders(<SchedulePage />);
    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    // seeded block sb-1 (WO-48230 on Batch IQ #2, Wed 7/1)
    expect(await screen.findByTestId("schedule-cell-sb-1")).toHaveTextContent("WO-48230");
    // seeded received order in the queue
    expect(await screen.findByTestId("queue-card-WO-48231")).toBeInTheDocument();
  });
});

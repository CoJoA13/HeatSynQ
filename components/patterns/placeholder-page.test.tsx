import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlaceholderPage } from "./placeholder-page";

describe("PlaceholderPage", () => {
  it("renders the title and a later-phase empty state", () => {
    render(<PlaceholderPage title="Schedule" note="Equipment load scheduling arrives later." />);
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByText("Coming in a later phase")).toBeInTheDocument();
    expect(screen.getByText("Equipment load scheduling arrives later.")).toBeInTheDocument();
  });
});

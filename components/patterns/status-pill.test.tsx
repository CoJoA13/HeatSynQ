import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
  it("renders label with tone classes", () => {
    render(<StatusPill tone="success">Won</StatusPill>);
    const el = screen.getByText("Won");
    expect(el.className).toContain("text-status-success");
    expect(el.className).toContain("bg-status-success-tint");
  });
});

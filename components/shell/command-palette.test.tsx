import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./command-palette";

// next/navigation router mock
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("CommandPalette", () => {
  it("filters destinations by query and shows empty state", async () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText("Orders")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/search/i), "zzzzz");
    expect(screen.getByText(/no results/i)).toBeInTheDocument();
  });
});

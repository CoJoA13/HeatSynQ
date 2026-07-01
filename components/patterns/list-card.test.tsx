import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListCard } from "./list-card";

describe("ListCard", () => {
  it("renders headers and rows and fires row click", async () => {
    const onRowClick = vi.fn();
    render(<ListCard headers={["A","B"]} rows={[["1","2"],["3","4"]]} onRowClick={onRowClick} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    await userEvent.click(screen.getByText("3"));
    expect(onRowClick).toHaveBeenCalledWith(1);
  });
});

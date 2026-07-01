import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpecificationsList } from "./specifications-list";
import type { Specification } from "@/lib/domain";

const specs: Specification[] = [
  { id: "s1", createdAt: "", updatedAt: "", version: 0, code: "AMS 2759/3", title: "Carburize & harden", rev: "K", owner: "SAE" },
  { id: "s2", createdAt: "", updatedAt: "", version: 0, code: "MIL-S-6090", title: "Bearing steels", rev: "A", owner: "DoD" },
];

describe("SpecificationsList", () => {
  it("renders spec code, title and owner", () => {
    render(<SpecificationsList specifications={specs} />);
    expect(screen.getByText("AMS 2759/3")).toBeInTheDocument();
    expect(screen.getByText("Carburize & harden")).toBeInTheDocument();
    expect(screen.getByText("DoD")).toBeInTheDocument();
  });
});

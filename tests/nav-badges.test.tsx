import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./utils";
import { useNavBadges } from "@/lib/query/hooks";

function BadgeProbe() {
  const b = useNavBadges();
  return <div>{Object.keys(b).length ? `q${b.quotes}-o${b.orders}-c${b.certifications}` : "loading"}</div>;
}

describe("useNavBadges", () => {
  it("computes live counts from the seed", async () => {
    renderWithProviders(<BadgeProbe />);
    expect(await screen.findByText("q3-o7-c2")).toBeInTheDocument();
  });
});

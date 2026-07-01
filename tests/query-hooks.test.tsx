import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./utils";
import { useCustomers, usePricingRulesByPriceKey } from "@/lib/query/hooks";

function CustomerProbe() {
  const q = useCustomers();
  return <div>{q.data ? `count:${q.data.length}` : "loading"}</div>;
}
function RulesProbe() {
  const q = usePricingRulesByPriceKey("pk-aero1");
  return <div>{q.data ? `rules:${q.data.length}` : "loading"}</div>;
}

describe("query hooks + test harness", () => {
  it("wires injected repositories through the read hooks", async () => {
    renderWithProviders(<CustomerProbe />);
    expect(await screen.findByText("count:8")).toBeInTheDocument();
  });
  it("resolves pricing rules by price key", async () => {
    renderWithProviders(<RulesProbe />);
    expect(await screen.findByText("rules:4")).toBeInTheDocument();
  });
});

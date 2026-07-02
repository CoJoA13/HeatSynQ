import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PricingKeyCard } from "./pricing-keys";
import type { PriceKey, PricingRule } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const KEY: PriceKey = { ...base, id: "pk-aero1", code: "AERO-1", description: "Aerospace step pricing" };
const RULES: PricingRule[] = [
  { ...base, id: "pr-carb", priceKeyId: "pk-aero1", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
  { ...base, id: "pr-temper", priceKeyId: "pk-aero1", process: "Temper", basis: "per_lot", rateCents: 144000, minChargeCents: null },
  { ...base, id: "pr-cert", priceKeyId: "pk-aero1", process: "Certification", basis: "flat", rateCents: 80000, minChargeCents: null },
  { ...base, id: "pr-neutral", priceKeyId: "pk-aero1", process: "Neutral harden", basis: "per_lb", rateCents: 680, minChargeCents: 18000 },
];

describe("PricingKeyCard", () => {
  it("renders key header, customer count, and the 4 seed rules (whole-dollar formatMoney)", () => {
    render(<PricingKeyCard priceKey={KEY} rules={RULES} customerCount={1} />);
    const card = screen.getByTestId("price-key-AERO-1");
    expect(card).toHaveTextContent("AERO-1");
    expect(card).toHaveTextContent("Aerospace step pricing");
    expect(card).toHaveTextContent("Used by 1 customer");
    expect(card).toHaveTextContent("Carburize");
    expect(card).toHaveTextContent("per lb");
    expect(card).toHaveTextContent("$10");   // 1030¢ — house whole-dollar convention (matches customer Pricing tab)
    expect(card).toHaveTextContent("$250");  // min charge 25000¢
    expect(card).toHaveTextContent("$1,440");
    expect(card).toHaveTextContent("$800");
    expect(card).toHaveTextContent("$7");    // 680¢ rounds to $7
  });

  it("pluralizes the customer count and shows an empty state for zero rules", () => {
    render(<PricingKeyCard priceKey={KEY} rules={[]} customerCount={0} />);
    expect(screen.getByTestId("price-key-AERO-1")).toHaveTextContent("Used by 0 customers");
    expect(screen.getByText("No rules")).toBeInTheDocument();
  });
});

// components/quotes/quote-builder.test.tsx (essentials)
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuoteBuilder } from "./quote-builder";
import type { Customer, Part, PricingRule } from "@/lib/domain";

const customers = [{ id: "cust-apex", name: "Apex Aerospace", priceKeyId: "pk", customerNumber: "1042" } as Customer];
const parts = [{ id: "part-ts4471", partNumber: "TS-4471", description: "Turbine shaft", material: "4140 steel", customerId: "cust-apex" } as Part];
const rules: PricingRule[] = [
  { id: "r", createdAt: "", updatedAt: "", version: 0, priceKeyId: "pk", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
];

function setup(onSaveDraft = vi.fn(), onSend = vi.fn()) {
  render(<QuoteBuilder customers={customers} parts={parts} pricingRules={rules}
    salespersonId="op-vance" canDiscount todayIso="2026-07-01T00:00:00.000Z"
    submitting={false} onSaveDraft={onSaveDraft} onSend={onSend} />);
  return { onSaveDraft, onSend };
}

describe("QuoteBuilder", () => {
  it("adds a part + line, computes a live total honoring the min-charge floor, and saves the draft", async () => {
    const user = userEvent.setup();
    const { onSaveDraft } = setup();
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-apex");
    await user.click(screen.getByRole("button", { name: /add part/i }));
    const block = screen.getByTestId("part-block-0");
    await user.selectOptions(within(block).getByLabelText("Part"), "part-ts4471");
    await user.type(within(block).getByLabelText("Quantity"), "480");
    await user.click(within(block).getByRole("button", { name: /add line/i }));
    const line = within(block).getByTestId("line-0");
    await user.selectOptions(within(line).getByLabelText("Process"), "Carburize");
    await user.selectOptions(within(line).getByLabelText("Basis"), "per_lb");
    // rate prefilled from the rule (1030); enter a below-floor weight (10 lb → 10300 < 25000 min)
    await user.type(within(line).getByLabelText("Qty / weight"), "10");
    expect(screen.getByTestId("quote-total")).toHaveTextContent("$250"); // min-charge floor
    await user.click(screen.getByRole("button", { name: /save draft/i }));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    const draft = onSaveDraft.mock.calls[0][0];
    expect(draft.customerId).toBe("cust-apex");
    expect(draft.parts[0].lines[0]).toMatchObject({ process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 });
  });
});

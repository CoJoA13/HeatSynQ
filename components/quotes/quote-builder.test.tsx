// components/quotes/quote-builder.test.tsx (essentials)
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuoteBuilder } from "./quote-builder";
import type { Customer, Part, PricingRule } from "@/lib/domain";

function renderBuilder(rules: PricingRule[], onSaveDraft = vi.fn(), onSend = vi.fn()) {
  return render(<QuoteBuilder customers={customers} parts={parts} pricingRules={rules}
    salespersonId="op-vance" canDiscount todayIso="2026-07-01T00:00:00.000Z"
    submitting={false} onSaveDraft={onSaveDraft} onSend={onSend} />);
}

const customers = [
  { id: "cust-apex", name: "Apex Aerospace", priceKeyId: "pk", customerNumber: "1042" } as Customer,
  { id: "cust-vulcan", name: "Vulcan Forge", priceKeyId: "pk", customerNumber: "1099" } as Customer,
];
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

  it("backfills a rate-0 line once pricingRules load after the process was picked", async () => {
    const user = userEvent.setup();
    const { rerender } = renderBuilder([]); // rules not loaded yet
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-apex");
    await user.click(screen.getByRole("button", { name: /add part/i }));
    const block = screen.getByTestId("part-block-0");
    await user.selectOptions(within(block).getByLabelText("Part"), "part-ts4471");
    await user.click(within(block).getByRole("button", { name: /add line/i }));
    const line = within(block).getByTestId("line-0");
    await user.selectOptions(within(line).getByLabelText("Process"), "Carburize");
    await user.selectOptions(within(line).getByLabelText("Basis"), "per_lb");
    await user.type(within(line).getByLabelText("Qty / weight"), "1000"); // rate is 0 → total $0
    expect(screen.getByTestId("quote-total")).toHaveTextContent("$0");
    // rules arrive → the untouched rate-0 line is backfilled (1000 lb × $10.30 = $10,300; above the $250 min)
    rerender(<QuoteBuilder customers={customers} parts={parts} pricingRules={rules}
      salespersonId="op-vance" canDiscount todayIso="2026-07-01T00:00:00.000Z"
      submitting={false} onSaveDraft={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByTestId("quote-total")).toHaveTextContent("$10,300");
  });

  it("generates non-colliding ids when reopening a draft with existing qp-/ql- ids", async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn();
    render(<QuoteBuilder customers={customers} parts={parts} pricingRules={rules}
      salespersonId="op-vance" canDiscount todayIso="2026-07-01T00:00:00.000Z"
      initial={{ customerPO: "", requiredBy: "", notes: "", discount: null, parts: [
        { id: "qp-1", partId: "part-ts4471", material: "4140 steel", quantity: 5,
          lines: [{ id: "ql-1", process: "Carburize", basis: "per_lb", qtyOrWeight: 10, rateCents: 1030, minChargeCents: 25000 }] },
      ] }}
      initialCustomerId="cust-apex"
      submitting={false} onSaveDraft={onSaveDraft} onSend={vi.fn()} />);
    // add a second line to the first part + a second (valid) part — new ids must not collide with qp-1/ql-1
    await user.click(within(screen.getByTestId("part-block-0")).getByRole("button", { name: /add line/i }));
    const line1 = within(screen.getByTestId("part-block-0")).getByTestId("line-1");
    await user.selectOptions(within(line1).getByLabelText("Process"), "Carburize");
    await user.click(screen.getByRole("button", { name: /add part/i }));
    const block1 = screen.getByTestId("part-block-1");
    await user.selectOptions(within(block1).getByLabelText("Part"), "part-ts4471");
    await user.click(within(block1).getByRole("button", { name: /add line/i }));
    await user.selectOptions(within(within(block1).getByTestId("line-0")).getByLabelText("Process"), "Carburize");
    await user.click(screen.getByRole("button", { name: /save draft/i }));
    const draft = onSaveDraft.mock.calls[0][0];
    const partIds = draft.parts.map((p: { id: string }) => p.id);
    const lineIds = draft.parts.flatMap((p: { lines: { id: string }[] }) => p.lines.map((l) => l.id));
    expect(new Set(partIds).size).toBe(partIds.length); // all part ids unique
    expect(new Set(lineIds).size).toBe(lineIds.length); // all line ids unique
  });

  it("clears built parts when the customer changes (no stale partIds under the new customer)", async () => {
    const user = userEvent.setup();
    renderBuilder(rules);
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-apex");
    await user.click(screen.getByRole("button", { name: /add part/i }));
    expect(screen.getByTestId("part-block-0")).toBeInTheDocument();
    // switch customer → parts reset
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-vulcan");
    expect(screen.queryByTestId("part-block-0")).not.toBeInTheDocument();
  });

  it("keeps Save/Send disabled when the discount is out of range (150%)", async () => {
    const user = userEvent.setup();
    renderBuilder(rules);
    await user.selectOptions(screen.getByLabelText("Customer"), "cust-apex");
    await user.click(screen.getByRole("button", { name: /add part/i }));
    const block = screen.getByTestId("part-block-0");
    await user.selectOptions(within(block).getByLabelText("Part"), "part-ts4471");
    await user.type(within(block).getByLabelText("Quantity"), "10");
    await user.click(within(block).getByRole("button", { name: /add line/i }));
    const line = within(block).getByTestId("line-0");
    await user.selectOptions(within(line).getByLabelText("Process"), "Carburize");
    await user.type(within(line).getByLabelText("Qty / weight"), "10");
    // valid so far
    expect(screen.getByRole("button", { name: /send quote/i })).toBeEnabled();
    await user.type(screen.getByLabelText("Discount %"), "150");
    expect(screen.getByRole("button", { name: /send quote/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save draft/i })).toBeDisabled();
  });
});

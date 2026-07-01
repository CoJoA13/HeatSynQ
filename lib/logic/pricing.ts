import type { Discount, QuotePart, Quote } from "@/lib/domain";

export function lineAmountCents(line: { qtyOrWeight: number; rateCents: number; minChargeCents: number | null }): number {
  const raw = Math.round(line.qtyOrWeight * line.rateCents);
  return line.minChargeCents != null ? Math.max(raw, line.minChargeCents) : raw;
}

export function quoteSubtotalCents(parts: QuotePart[]): number {
  return parts.reduce((sum, p) => sum + p.lines.reduce((s, l) => s + lineAmountCents(l), 0), 0);
}

export function applyDiscountCents(subtotalCents: number, discount: Discount | null): number {
  if (!discount) return subtotalCents;
  if (discount.kind === "amount") return Math.max(0, subtotalCents - discount.value);
  return Math.round(subtotalCents * (1 - discount.value / 100));
}

export function quoteTotalCents(quote: Pick<Quote, "parts" | "discount">): number {
  return applyDiscountCents(quoteSubtotalCents(quote.parts), quote.discount);
}

export function marginPct(totalCents: number, costCents: number): number {
  if (totalCents <= 0) return 0;
  return Math.round(((totalCents - costCents) / totalCents) * 100);
}

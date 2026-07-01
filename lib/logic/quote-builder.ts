import type { CreateInput } from "@/lib/data/repositories";
import type { Quote, QuotePart, PricingRule, PricingBasis, Discount } from "@/lib/domain";
import { quoteTotalCents } from "./pricing";

const DAY = 86_400_000;
export const STUB_COST_RATIO = 0.58; // margin display stub (~42%); real cost model is a later spec

export function rateForLine(
  rules: PricingRule[], process: string, basis: PricingBasis,
): { rateCents: number; minChargeCents: number | null } {
  const r = rules.find((x) => x.process === process && x.basis === basis);
  return r ? { rateCents: r.rateCents, minChargeCents: r.minChargeCents } : { rateCents: 0, minChargeCents: null };
}

export function quoteDates(todayIso: string): { date: string; validUntil: string } {
  const t = new Date(todayIso).getTime();
  return { date: todayIso, validUntil: new Date(t + 30 * DAY).toISOString() };
}

export function buildQuoteDraft(
  args: {
    customerId: string; customerPO: string; salespersonId: string;
    requiredBy: string | null; discount: Discount | null; notes: string; parts: QuotePart[];
  },
  todayIso: string,
): CreateInput<Quote> {
  const { date, validUntil } = quoteDates(todayIso);
  const total = quoteTotalCents({ parts: args.parts, discount: args.discount });
  return {
    rev: 0, customerId: args.customerId, customerPO: args.customerPO, status: "draft",
    salespersonId: args.salespersonId, date, validUntil, requiredBy: args.requiredBy,
    discount: args.discount, estCostCents: Math.round(total * STUB_COST_RATIO),
    notes: args.notes, parts: args.parts, wonOrderId: null,
  };
}

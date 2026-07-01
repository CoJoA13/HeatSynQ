import type { Quote, Operator, QuoteStatus } from "@/lib/domain";
import type { CreateInput } from "@/lib/data/repositories";
import { quoteTotalCents } from "./pricing";

export function isEditable(quote: Quote): boolean {
  return quote.status === "draft";
}

export function requiresApproval(quote: Quote, operator: Operator): boolean {
  return quoteTotalCents(quote) > operator.quoteAuthLimitCents;
}

export function sendQuote(quote: Quote, operator: Operator): { status: QuoteStatus } {
  return { status: requiresApproval(quote, operator) ? "approve" : "sent" };
}

export function approveQuote(quote: Quote): Quote {
  return { ...quote, status: "sent" };
}
export function rejectQuote(quote: Quote): Quote {
  return { ...quote, status: "draft" };
}
export function winQuote(quote: Quote): Quote {
  return { ...quote, status: "won" };
}
export function loseQuote(quote: Quote): Quote {
  return { ...quote, status: "lost" };
}

export function reviseQuote(quote: Quote): CreateInput<Quote> {
  const { id: _id, createdAt: _c, updatedAt: _u, version: _v, number: _n, ...rest } = quote;
  return { ...rest, status: "draft", rev: quote.rev + 1, wonOrderId: null };
}

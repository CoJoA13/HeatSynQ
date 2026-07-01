"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useCan } from "@/lib/auth/provider";
import { useCustomers, useParts, usePricingRulesByPriceKey, useCreateQuoteDraft, useSendQuote } from "@/lib/query/hooks";
import { SkeletonRows } from "@/components/patterns";
import { QuoteBuilder } from "@/components/quotes/quote-builder";

export default function QuoteBuilderPage() {
  const router = useRouter();
  const { operator } = useAuth();
  const canDiscount = useCan("apply_discount");
  const customers = useCustomers();
  const parts = useParts();
  const [priceKeyId, setPriceKeyId] = useState(""); // selected customer's price key drives the rule query
  const rules = usePricingRulesByPriceKey(priceKeyId);
  const createDraft = useCreateQuoteDraft();
  const send = useSendQuote();

  if (customers.isLoading || parts.isLoading) return <SkeletonRows />;

  return (
    <QuoteBuilder
      customers={customers.data ?? []}
      parts={parts.data ?? []}
      pricingRules={rules.data ?? []}
      salespersonId={operator?.id ?? ""}
      canDiscount={canDiscount}
      todayIso={new Date().toISOString()}
      submitting={createDraft.isPending || send.isPending}
      onSaveDraft={async (input) => { const q = await createDraft.mutateAsync(input); router.push(`/quotes/${q.id}`); }}
      onSend={async (input) => {
        const q = await createDraft.mutateAsync(input);
        if (operator) await send.mutateAsync({ quote: q, operator });
        router.push(`/quotes/${q.id}`);
      }}
      onCustomerChange={(cid) => { const c = (customers.data ?? []).find((x) => x.id === cid); setPriceKeyId(c?.priceKeyId ?? ""); }}
    />
  );
}

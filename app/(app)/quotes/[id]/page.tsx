"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useQuote,
  useCustomer,
  useParts,
  usePricingRulesByPriceKey,
  useUpdateQuote,
  useSendQuote,
  useApproveQuote,
  useRejectQuote,
  useWinQuote,
  useLoseQuote,
  useReviseQuote,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { QuoteBuilder, type BuilderState } from "@/components/quotes/quote-builder";
import { QuoteView } from "@/components/quotes/quote-view";
import { isEditable } from "@/lib/logic/quote-state";
import type { CreateInput } from "@/lib/data/repositories";
import type { Quote } from "@/lib/domain";

export default function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { operator } = useAuth();
  const canApprove = useCan("approve_over_limit");
  const canDiscount = useCan("apply_discount");
  const quote = useQuote(id);
  const customer = useCustomer(quote.data?.customerId ?? "");
  const parts = useParts();
  const rules = usePricingRulesByPriceKey(customer.data?.priceKeyId ?? "");
  const update = useUpdateQuote();
  const send = useSendQuote();
  const approve = useApproveQuote();
  const reject = useRejectQuote();
  const win = useWinQuote();
  const lose = useLoseQuote();
  const revise = useReviseQuote();

  if (quote.isLoading || !operator) return <SkeletonRows />;
  if (quote.isError) return <ErrorPanel message="Failed to load quote." onRetry={() => quote.refetch()} />;
  if (!quote.data) return <EmptyState title="Quote not found" />;
  const q = quote.data;

  if (isEditable(q)) {
    const initial: BuilderState = {
      customerPO: q.customerPO,
      requiredBy: q.requiredBy ? q.requiredBy.slice(0, 10) : "",
      notes: q.notes,
      discount: q.discount,
      parts: q.parts.map((p) => ({
        id: p.id,
        partId: p.partId,
        material: p.material,
        quantity: p.quantity,
        lines: p.lines,
      })),
    };
    const toPatch = (input: CreateInput<Quote>) => ({
      customerId: input.customerId,
      customerPO: input.customerPO,
      requiredBy: input.requiredBy,
      discount: input.discount,
      notes: input.notes,
      parts: input.parts,
      estCostCents: input.estCostCents,
    });
    return (
      <QuoteBuilder
        customers={customer.data ? [customer.data] : []}
        parts={parts.data ?? []}
        pricingRules={rules.data ?? []}
        salespersonId={q.salespersonId}
        canDiscount={canDiscount}
        todayIso={new Date().toISOString()}
        initial={initial}
        initialCustomerId={q.customerId}
        submitting={update.isPending || send.isPending}
        onSaveDraft={async (input) => {
          await update.mutateAsync({ id: q.id, patch: toPatch(input), version: q.version });
        }}
        onSend={async (input) => {
          const saved = await update.mutateAsync({ id: q.id, patch: toPatch(input), version: q.version });
          if (operator) await send.mutateAsync({ quote: saved, operator });
        }}
        onCustomerChange={() => {}}
      />
    );
  }

  return (
    <QuoteView
      quote={q}
      customer={customer.data ?? null}
      parts={parts.data ?? []}
      canApprove={canApprove}
      busy={
        approve.isPending ||
        reject.isPending ||
        win.isPending ||
        lose.isPending ||
        revise.isPending
      }
      onApprove={() => approve.mutate({ quote: q })}
      onReject={() => reject.mutate({ quote: q })}
      onWin={() => win.mutate(q)}
      onLose={() => lose.mutate({ quote: q })}
      onRevise={async () => {
        const r = await revise.mutateAsync(q);
        router.push(`/quotes/${r.id}`);
      }}
    />
  );
}

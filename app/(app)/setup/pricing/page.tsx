"use client";
import { usePriceKeys, usePricingRulesByPriceKey, useCustomers } from "@/lib/query/hooks";
import { DetailHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { PricingKeyCard } from "@/components/setup/pricing-keys";
import type { PriceKey } from "@/lib/domain";

function PriceKeySection({ priceKey, customerCount }: { priceKey: PriceKey; customerCount: number }) {
  const rules = usePricingRulesByPriceKey(priceKey.id);
  if (rules.isLoading) return <SkeletonRows count={3} />;
  if (rules.isError) return <ErrorPanel message="Failed to load pricing rules." onRetry={() => rules.refetch()} />;
  return <PricingKeyCard priceKey={priceKey} rules={rules.data ?? []} customerCount={customerCount} />;
}

export default function SetupPricingPage() {
  const keys = usePriceKeys();
  const customers = useCustomers();
  return (
    <div>
      <DetailHeader backHref="/setup" backLabel="Setup" title="Pricing & Price Keys"
        subtitle="Step pricing, customer overrides and dimensional pricing." />
      {keys.isLoading || customers.isLoading ? (
        <SkeletonRows />
      ) : keys.isError || customers.isError ? (
        <ErrorPanel message="Failed to load pricing." onRetry={() => { keys.refetch(); customers.refetch(); }} />
      ) : !keys.data || keys.data.length === 0 ? (
        <EmptyState title="No price keys" description="No pricing profiles on file yet." />
      ) : (
        <div className="space-y-6">
          {keys.data.map((k) => (
            <PriceKeySection key={k.id} priceKey={k}
              customerCount={(customers.data ?? []).filter((c) => c.priceKeyId === k.id).length} />
          ))}
        </div>
      )}
    </div>
  );
}

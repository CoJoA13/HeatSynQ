import { ListCard, MonoId, EmptyState } from "@/components/patterns";
import { basisLabel } from "@/lib/domain/enums";
import { formatMoney } from "@/lib/utils";
import type { PriceKey, PricingRule } from "@/lib/domain";

export function PricingKeyCard({ priceKey, rules, customerCount }: {
  priceKey: PriceKey; rules: PricingRule[]; customerCount: number;
}) {
  return (
    <div data-testid={`price-key-${priceKey.code}`} className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <MonoId>{priceKey.code}</MonoId>
          <span className="text-text-muted text-xs">— {priceKey.description}</span>
        </div>
        <p className="text-text-muted text-xs">Used by {customerCount} customer{customerCount === 1 ? "" : "s"}</p>
      </div>
      {rules.length === 0 ? (
        <EmptyState title="No rules" />
      ) : (
        <ListCard
          headers={["PROCESS", "BASIS", "RATE", "MIN CHARGE"]}
          rows={rules.map((r) => [
            r.process,
            basisLabel[r.basis],
            <span key="rate" className="font-mono">{formatMoney(r.rateCents)}</span>,
            <span key="min" className="font-mono">{r.minChargeCents != null ? formatMoney(r.minChargeCents) : "—"}</span>,
          ])}
        />
      )}
    </div>
  );
}

import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { quoteStatusMeta, basisLabel } from "@/lib/domain/enums";
import { quoteSubtotalCents, quoteTotalCents, lineAmountCents, marginPct } from "@/lib/logic/pricing";
import { formatMoney, formatDate } from "@/lib/utils";
import type { Quote, Customer, Part } from "@/lib/domain";

export function QuoteView({
  quote,
  customer,
  parts,
  canApprove,
  onApprove,
  onReject,
  onWin,
  onLose,
  onRevise,
  busy,
}: {
  quote: Quote;
  customer: Customer | null;
  parts: Part[];
  canApprove: boolean;
  onApprove: () => void;
  onReject: () => void;
  onWin: () => void;
  onLose: () => void;
  onRevise: () => void;
  busy: boolean;
}) {
  const meta = quoteStatusMeta[quote.status];
  const partById = new Map(parts.map((p) => [p.id, p]));
  const total = quoteTotalCents(quote);
  const actions = (
    <>
      {quote.status === "approve" && canApprove && (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={onReject}>
            Reject
          </Button>
          <Button size="sm" disabled={busy} onClick={onApprove}>
            Approve
          </Button>
        </>
      )}
      {quote.status === "sent" && (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={onRevise}>
            Revise
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onLose}>
            Mark lost
          </Button>
          <Button size="sm" disabled={busy} onClick={onWin}>
            Mark won
          </Button>
        </>
      )}
    </>
  );

  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader
          backHref="/quotes"
          backLabel="Quotes"
          title={
            <MonoId>
              {quote.rev > 0 ? `${quote.number} · rev ${quote.rev}` : quote.number}
            </MonoId>
          }
          subtitle={`${customer?.name ?? ""} · PO ${quote.customerPO || "—"}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>}
          actions={actions}
        />
        {quote.parts.map((p) => (
          <div key={p.id} className="mb-4 rounded-card border border-border bg-surface p-4">
            <div className="mb-2 font-semibold">
              {partById.get(p.partId)?.partNumber ?? p.partId} · {p.material} · qty {p.quantity}
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">
                  <th className="py-1">Process</th>
                  <th>Basis</th>
                  <th>Qty/Wt</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.id} className="border-t border-border-faint">
                    <td className="py-1">{l.process}</td>
                    <td>{basisLabel[l.basis]}</td>
                    <td className="font-mono">{l.qtyOrWeight}</td>
                    <td className="text-right font-mono">{formatMoney(lineAmountCents(l))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <SummaryRail title="Summary">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-text-muted">Subtotal</dt>
            <dd className="font-mono">{formatMoney(quoteSubtotalCents(quote.parts))}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-2">
            <dt className="font-semibold">Total</dt>
            <dd className="font-mono font-semibold">{formatMoney(total)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Est. margin</dt>
            <dd className="font-mono">{marginPct(total, quote.estCostCents)}%</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Valid until</dt>
            <dd className="font-mono">{formatDate(quote.validUntil)}</dd>
          </div>
        </dl>
      </SummaryRail>
    </div>
  );
}

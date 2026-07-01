"use client";
import { useState } from "react";
import { ListCard } from "@/components/patterns";
import { ConfirmDialog } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { ageInvoices, netDaysByCustomer, customerAging, parseNetDays, type Bucket } from "@/lib/logic/ar";
import { formatMoney } from "@/lib/utils";
import type { Invoice, Customer } from "@/lib/domain";

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "current", label: "Current" }, { key: "d1_30", label: "1–30" },
  { key: "d31_60", label: "31–60" }, { key: "d61_90", label: "61–90" }, { key: "d90_plus", label: "90+" },
];

export function ARView({ invoices, customers, asOf, canClose, onClosePeriod, closedNote }: {
  invoices: Invoice[]; customers: Customer[]; asOf: string; canClose: boolean;
  onClosePeriod: () => void; closedNote: string | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const nd = netDaysByCustomer(customers);
  const totals = ageInvoices(invoices, nd, asOf);
  const rows = customers
    .map((c) => ({ c, a: customerAging(invoices, c.id, parseNetDays(c.terms), asOf) }))
    .filter((x) => x.a.balanceCents > 0);

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">A/R aging</h1>
          <p className="text-text-muted text-xs">Open receivables by age, per customer. Net terms drive the due date.</p>
        </div>
        {canClose && <Button variant="outline" onClick={() => setConfirm(true)}>Close period</Button>}
      </div>

      {closedNote && <p className="mb-4 rounded-card border border-status-success-tint bg-status-success-tint px-3 py-2 text-xs text-status-success">{closedNote}</p>}

      <div className="mb-5 grid grid-cols-5 gap-3">
        {BUCKETS.map((b) => (
          <div key={b.key} className="rounded-card border border-border bg-surface p-3">
            <div className="font-mono text-[10.5px] uppercase tracking-[.06em] text-text-faint">{b.label}</div>
            <div className="font-mono text-[20px] font-semibold">{formatMoney(totals[b.key])}</div>
          </div>
        ))}
      </div>

      <ListCard headers={["CUSTOMER", "BALANCE", "CURRENT", "PAST DUE", "OLDEST"]}
        rows={rows.map(({ c, a }) => [
          c.name,
          <span key="b" className="font-mono">{formatMoney(a.balanceCents)}</span>,
          <span key="cu" className="font-mono">{formatMoney(a.currentCents)}</span>,
          <span key="pd" className="font-mono text-status-warn">{formatMoney(a.pastDueCents)}</span>,
          <span key="o" className="font-mono">{a.oldestDaysPastDue > 0 ? `${a.oldestDaysPastDue}d` : "—"}</span>,
        ])} />

      <ConfirmDialog open={confirm} onOpenChange={setConfirm}
        title="Close period" description="This locks the current period's invoices from edits (advisory in this slice)."
        confirmLabel="Close" onConfirm={onClosePeriod} />
    </div>
  );
}

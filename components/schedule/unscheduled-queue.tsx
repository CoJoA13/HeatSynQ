import { MonoId, EmptyState, StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { formatDate } from "@/lib/utils";
import { isLate } from "@/lib/logic/dashboard";
import type { WorkOrder, Customer } from "@/lib/domain";

export function UnscheduledQueue({ orders, customers, canSchedule, busy, onAssign, asOf }: {
  orders: WorkOrder[];
  customers: Customer[];
  canSchedule: boolean;
  busy: boolean;
  onAssign: (order: WorkOrder) => void;
  asOf: string;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  return (
    <div data-testid="unscheduled-queue" className="rounded-card border border-border bg-canvas-alt p-3">
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-text-faint">Unscheduled ({orders.length})</div>
      {orders.length === 0 ? (
        <EmptyState title="All received orders scheduled" />
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} data-testid={`queue-card-${o.number}`} className="rounded-card border border-border bg-surface p-2">
              <div className="flex items-center justify-between">
                <MonoId className="text-xs">{o.number}</MonoId>
                <div className="flex items-center gap-1">
                  {isLate(o, asOf) && <StatusPill tone="danger">LATE</StatusPill>}
                  <span className="text-text-muted text-[11px]">Due {formatDate(o.due)}</span>
                </div>
              </div>
              <div className="text-[12px] font-medium">{custById.get(o.customerId)?.name ?? "—"}</div>
              {canSchedule && (
                <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => onAssign(o)}>Assign</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

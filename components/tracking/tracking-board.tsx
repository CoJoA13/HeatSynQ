import { StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { AREAS, areaMeta, orderStatusMeta } from "@/lib/domain/enums";
import { boardAreaForOrder, activeStep, stepActions } from "@/lib/logic/tracking";
import { isLate } from "@/lib/logic/dashboard";
import type { WorkOrder, Customer, AreaId } from "@/lib/domain";

export function TrackingBoard({ orders, customers, asOf, busy, onTrackIn, onTrackOut }: {
  orders: WorkOrder[]; customers: Customer[]; asOf: string; busy: boolean;
  onTrackIn: (order: WorkOrder, stepN: number) => void;
  onTrackOut: (order: WorkOrder, stepN: number, inspectResult?: "pass" | "fail") => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const byArea = new Map<AreaId, WorkOrder[]>(AREAS.map((a) => [a, []]));
  for (const o of orders) byArea.get(boardAreaForOrder(o))!.push(o);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {AREAS.map((area) => {
        const col = byArea.get(area)!;
        return (
          <div key={area} data-testid={`area-col-${area}`} className="w-64 shrink-0 rounded-card border border-border bg-canvas-alt p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-faint">{areaMeta[area].label}</span>
              <span className="font-mono text-xs text-text-muted">{col.length}</span>
            </div>
            <div className="space-y-2">
              {col.map((o) => {
                const active = activeStep(o.steps);
                const late = isLate(o, asOf);
                const sm = orderStatusMeta[o.status];
                return (
                  <div key={o.id} data-testid={`board-card-WO-${o.number.replace(/^WO-/, "")}`} className="rounded-card border border-border bg-surface p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span data-label={o.number} className="wono-badge font-mono text-[11px] text-text-muted" />
                      {late && <StatusPill tone="danger">LATE</StatusPill>}
                    </div>
                    <div className="text-[13px] font-medium">{custById.get(o.customerId)?.name ?? "—"}</div>
                    <div className="text-xs text-text-muted">{o.processSummary}</div>
                    <div className="mt-1 flex items-center justify-between">
                      <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
                      <span className="text-xs text-text-muted">{active ? active.op : "—"}</span>
                    </div>
                    {active && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {stepActions(active).map((a) => (
                          <Button key={a.label} size="sm" variant="outline" disabled={busy}
                            onClick={() => (a.action === "in" ? onTrackIn(o, active.n) : onTrackOut(o, active.n, a.inspectResult))}>
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

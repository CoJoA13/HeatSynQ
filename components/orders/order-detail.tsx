import Link from "next/link";
import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { orderStatusMeta, certStatusMeta, orderStepStateMeta, areaMeta } from "@/lib/domain/enums";
import { canShipOrder } from "@/lib/logic/order";
import { stepActions, activeStep } from "@/lib/logic/tracking";
import { formatMoney, formatDate } from "@/lib/utils";
import type { WorkOrder, Customer, ProcessMaster, Certification } from "@/lib/domain";

export function OrderDetail({
  order, customer, processMaster, cert, canRelease, busy,
  onRelease, onShip, onTrackIn, onTrackOut, onHold, onResume,
}: {
  order: WorkOrder; customer: Customer | null; processMaster: ProcessMaster | null; cert: Certification | null;
  canRelease: boolean; busy: boolean;
  onRelease: () => void; onShip: () => void;
  onTrackIn: (stepN: number) => void; onTrackOut: (stepN: number, inspectResult?: "pass" | "fail") => void;
  onHold: () => void; onResume: () => void;
}) {
  const meta = orderStatusMeta[order.status];
  const gate = canShipOrder(order, cert, customer);
  const active = activeStep(order.steps);
  const canHold = order.status !== "shipped" && order.status !== "on_hold";
  const actions = (
    <>
      {order.status === "on_hold" && <Button size="sm" variant="outline" disabled={busy} onClick={onResume}>Resume</Button>}
      {canHold && <Button size="sm" variant="outline" disabled={busy} onClick={onHold}>On Hold</Button>}
      {order.status === "ready_to_ship" && <Button size="sm" disabled={busy || !gate.ok} onClick={onShip}>Ship</Button>}
    </>
  );

  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/orders" backLabel="Orders" title={<MonoId>{order.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · PO ${order.customerPO || "—"} · ${order.processSummary}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>} actions={actions} />

        {order.status === "ready_to_ship" && !gate.ok && (
          <p className="mb-4 rounded-card border border-status-warn-tint bg-status-warn-tint px-3 py-2 text-xs text-status-warn">{gate.reason}</p>
        )}

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">Progress</span>
            <span className="font-mono text-xs text-text-muted" data-testid="order-progress">{order.progressPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-canvas-alt">
            <div className="h-2 rounded-full bg-primary" style={{ width: `${order.progressPct}%` }} />
          </div>
        </div>

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Pricing</div>
          <table className="w-full text-[13px]">
            <tbody>
              {order.pricing.map((l, i) => (
                <tr key={i} className="border-t border-border-faint first:border-0">
                  <td className="py-1">{l.process}{l.detail ? ` · ${l.detail}` : ""}</td>
                  <td className="text-right font-mono">{formatMoney(l.amountCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-border"><td className="py-1 font-semibold">Total</td>
                <td className="text-right font-mono font-semibold">{formatMoney(order.orderValueCents)}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Traveler {processMaster && <span className="font-mono text-xs text-text-muted">· {processMaster.code} rev {processMaster.rev}</span>}</div>
          {order.steps.length > 0 ? (
            <ol className="space-y-2 text-[13px]">
              {order.steps.map((s) => {
                const sm = orderStepStateMeta[s.state];
                const isActive = active?.n === s.n;
                return (
                  <li key={s.n} data-testid={`traveler-step-${s.n}`} className="flex items-start justify-between gap-3 border-t border-border-faint pt-2 first:border-0 first:pt-0">
                    <div className="flex gap-3">
                      <span className="font-mono text-text-muted">{s.n}</span>
                      <div>
                        <div className="font-medium">{s.op} <span className="text-text-muted">· {s.equip}</span></div>
                        <div className="text-xs text-text-muted">
                          {areaMeta[s.areaId].label}
                          {s.operatorInitials && <span className="font-mono"> · {s.operatorInitials}</span>}
                          {s.state === "done" && (s.trackedOutAt ?? s.trackedInAt) && <span className="font-mono"> · {formatDate((s.trackedOutAt ?? s.trackedInAt) as string)}</span>}
                        </div>
                        {s.params.length > 0 && <div className="font-mono text-xs text-text-muted">{s.params.join(" · ")}</div>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
                      {isActive && order.status !== "on_hold" && stepActions(s).map((a) => (
                        <Button key={a.label} size="sm" variant="outline" disabled={busy}
                          onClick={() => (a.action === "in" ? onTrackIn(s.n) : onTrackOut(s.n, a.inspectResult))}>
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-text-muted text-xs">No traveler steps.</p>}
        </div>

        <div className="rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Activity</div>
          <ul className="space-y-2 text-[13px]">
            {order.activity.map((a, i) => (
              <li key={i} className="flex justify-between border-t border-border-faint pt-2 first:border-0 first:pt-0">
                <span>{a.message} <span className="text-text-muted">· {a.actor}</span></span>
                <span className="font-mono text-text-muted">{formatDate(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <SummaryRail title="Order">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Ordered</dt><dd className="font-mono">{formatDate(order.orderedDate)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Due</dt><dd className="font-mono">{formatDate(order.due)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Value</dt><dd className="font-mono">{formatMoney(order.orderValueCents)}</dd></div>
        </dl>
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 font-semibold">Certification</div>
          {order.certifyRequired && cert ? (
            <div className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <Link href={`/certifications/${cert.id}`} className="text-primary"><MonoId>{cert.number}</MonoId></Link>
                <StatusPill tone={certStatusMeta[cert.status].tone}>{certStatusMeta[cert.status].label}</StatusPill>
              </div>
              {cert.status === "pending" && canRelease && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onRelease}>Release</Button>
              )}
            </div>
          ) : order.certifyRequired ? (
            <p className="text-text-muted text-xs">Cert pending generation.</p>
          ) : (
            <p className="text-text-muted text-xs">No certification required.</p>
          )}
        </div>
      </SummaryRail>
    </div>
  );
}

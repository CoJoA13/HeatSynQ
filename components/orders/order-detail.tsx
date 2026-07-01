import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { orderStatusMeta, certStatusMeta } from "@/lib/domain/enums";
import { ORDER_TRANSITIONS, canShipOrder } from "@/lib/logic/order";
import { formatMoney, formatDate } from "@/lib/utils";
import type { WorkOrder, Customer, ProcessMaster, Certification, OrderStatus } from "@/lib/domain";

export function OrderDetail({ order, customer, processMaster, cert, canRelease, busy, onRelease, onTransition, onShip }: {
  order: WorkOrder; customer: Customer | null; processMaster: ProcessMaster | null; cert: Certification | null;
  canRelease: boolean; busy: boolean; onRelease: () => void; onTransition: (to: OrderStatus) => void; onShip: () => void;
}) {
  const meta = orderStatusMeta[order.status];
  const gate = canShipOrder(order, cert);
  const targets = ORDER_TRANSITIONS[order.status].filter((t) => t !== "shipped");
  const canShipStatus = order.status === "ready_to_ship"; // ship is offered from ready_to_ship
  const actions = (
    <>
      {targets.map((t) => (
        <Button key={t} size="sm" variant="outline" disabled={busy} onClick={() => onTransition(t)}>
          {orderStatusMeta[t].label}
        </Button>
      ))}
      {canShipStatus && <Button size="sm" disabled={busy || !gate.ok} onClick={onShip}>Ship</Button>}
    </>
  );
  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/orders" backLabel="Orders" title={<MonoId>{order.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · PO ${order.customerPO || "—"} · ${order.processSummary}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>} actions={actions} />

        {canShipStatus && !gate.ok && (
          <p className="mb-4 rounded-card border border-status-warn-tint bg-status-warn-tint px-3 py-2 text-xs text-status-warn">{gate.reason}</p>
        )}

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
          {processMaster ? (
            <ol className="space-y-2 text-[13px]">
              {processMaster.steps.map((s) => (
                <li key={s.n} className="flex gap-3 border-t border-border-faint pt-2 first:border-0 first:pt-0">
                  <span className="font-mono text-text-muted">{s.n}</span>
                  <div>
                    <div className="font-medium">{s.op} <span className="text-text-muted">· {s.equip}</span></div>
                    {s.params.length > 0 && <div className="font-mono text-xs text-text-muted">{s.params.join(" · ")}</div>}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="text-text-muted text-xs">No process master assigned.</p>}
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
                <MonoId>{cert.number}</MonoId>
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

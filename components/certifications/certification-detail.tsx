import Link from "next/link";
import { DetailHeader, StatusPill, MonoId, SummaryRail } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { certStatusMeta, orderStatusMeta } from "@/lib/domain/enums";
import { formatDate } from "@/lib/utils";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

export function CertificationDetail({
  cert, workOrder, customer, specification, canRelease, busy, onRelease,
}: {
  cert: Certification; workOrder: WorkOrder | null; customer: Customer | null;
  specification: Specification | null; canRelease: boolean; busy: boolean; onRelease: () => void;
}) {
  const meta = certStatusMeta[cert.status];
  const blocking = cert.status === "pending" && workOrder?.status === "ready_to_ship";
  return (
    <div className="grid grid-cols-[1fr_300px] gap-6">
      <div>
        <DetailHeader backHref="/certifications" backLabel="Certifications" title={<MonoId>{cert.number}</MonoId>}
          subtitle={`${customer?.name ?? ""} · ${cert.type}`}
          statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>}
          actions={cert.status === "pending" && canRelease
            ? <Button size="sm" disabled={busy} onClick={onRelease}>Release</Button>
            : undefined} />

        {blocking && workOrder && (
          <p className="mb-4 rounded-card border border-status-warn-tint bg-status-warn-tint px-3 py-2 text-xs text-status-warn">
            This cert blocks shipment of {workOrder.number}.
          </p>
        )}

        <div className="mb-4 rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Certification</div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between"><dt className="text-text-muted">Type</dt><dd>{cert.type}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Specification</dt>
              <dd className="font-mono">{specification ? `${specification.code} rev ${specification.rev}` : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Copies</dt><dd className="font-mono">{cert.copies}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Created</dt><dd className="font-mono">{formatDate(cert.createdAt)}</dd></div>
          </dl>
        </div>

        <div className="rounded-card border border-border bg-surface p-4">
          <div className="mb-2 font-semibold">Work order</div>
          {workOrder ? (
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between"><dt className="text-text-muted">Order</dt>
                <dd><Link href={`/orders/${workOrder.id}`} className="text-primary"><MonoId>{workOrder.number}</MonoId></Link></dd></div>
              <div className="flex justify-between"><dt className="text-text-muted">Status</dt>
                <dd><StatusPill tone={orderStatusMeta[workOrder.status].tone}>{orderStatusMeta[workOrder.status].label}</StatusPill></dd></div>
              <div className="flex justify-between"><dt className="text-text-muted">Due</dt><dd className="font-mono">{formatDate(workOrder.due)}</dd></div>
              <div className="flex justify-between"><dt className="text-text-muted">Process</dt><dd>{workOrder.processSummary}</dd></div>
            </dl>
          ) : <p className="text-text-muted text-xs">Work order not found.</p>}
        </div>
      </div>

      <SummaryRail title="Certification">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-text-muted">Customer</dt>
            <dd>{customer ? <Link href={`/customers/${customer.id}`} className="text-primary">{customer.name}</Link> : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Status</dt>
            <dd><StatusPill tone={meta.tone}>{meta.label}</StatusPill></dd></div>
          <div className="flex justify-between"><dt className="text-text-muted">Copies</dt><dd className="font-mono">{cert.copies}</dd></div>
        </dl>
      </SummaryRail>
    </div>
  );
}

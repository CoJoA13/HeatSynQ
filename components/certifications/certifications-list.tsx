import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { certStatusMeta } from "@/lib/domain/enums";
import type { Certification, Customer, WorkOrder, Specification } from "@/lib/domain";

export function CertificationsList({
  certifications,
  customers,
  workOrders,
  specifications,
  canRelease,
  onRelease,
}: {
  certifications: Certification[];
  customers: Customer[];
  workOrders: WorkOrder[];
  specifications: Specification[];
  canRelease: boolean;
  onRelease: (id: string) => void;
}) {
  const custById = new Map(customers.map((c) => [c.id, c]));
  const woById = new Map(workOrders.map((w) => [w.id, w]));
  const specById = new Map(specifications.map((s) => [s.id, s]));
  return (
    <ListCard
      headers={["CERT", "CUSTOMER", "WORK ORDER", "SPEC", "TYPE", "COPIES", "STATUS", ""]}
      rows={certifications.map((c) => {
        const meta = certStatusMeta[c.status];
        return [
          <MonoId key="c">{c.number}</MonoId>,
          custById.get(c.customerId)?.name ?? "—",
          <MonoId key="w">{woById.get(c.workOrderId)?.number ?? "—"}</MonoId>,
          c.specificationId ? specById.get(c.specificationId)?.code ?? "—" : "—",
          c.type,
          <span key="cp" className="font-mono">{c.copies}</span>,
          <StatusPill key="s" tone={meta.tone}>{meta.label}</StatusPill>,
          canRelease && c.status === "pending"
            ? <Button key="r" size="sm" variant="outline" onClick={() => onRelease(c.id)}>Release</Button>
            : null,
        ];
      })}
    />
  );
}

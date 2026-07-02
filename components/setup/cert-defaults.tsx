import { ListCard, MonoId } from "@/components/patterns";
import type { Customer, Specification } from "@/lib/domain";

export function CertDefaults({ customers, specifications }: {
  customers: Customer[]; specifications: Specification[];
}) {
  const codeById = new Map(specifications.map((s) => [s.id, s.code]));
  return (
    <div className="space-y-3">
      <ListCard
        headers={["CUSTOMER", "DEFAULT CERT", "COPIES"]}
        rows={customers.map((c) => [
          <span key="n" data-testid={`cert-default-row-${c.id}`}>{c.name}</span>,
          c.defaultCertSpecId ? <MonoId key="s">{codeById.get(c.defaultCertSpecId) ?? c.defaultCertSpecId}</MonoId> : "—",
          <span key="c" className="font-mono">{c.defaultCertCopies}</span>,
        ])}
      />
      <p className="text-text-faint text-[11px]">Cert formats and form / message inserts aren&apos;t modeled yet — customer defaults only.</p>
    </div>
  );
}

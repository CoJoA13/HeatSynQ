import { ListCard, MonoId } from "@/components/patterns";
import type { Specification } from "@/lib/domain";

export function SpecificationsList({ specifications }: { specifications: Specification[] }) {
  return (
    <ListCard
      headers={["SPEC", "TITLE", "REV", "OWNER"]}
      rows={specifications.map((s) => [
        <MonoId key="code">{s.code}</MonoId>,
        s.title,
        <span key="rev" className="font-mono">{s.rev}</span>,
        s.owner,
      ])}
    />
  );
}

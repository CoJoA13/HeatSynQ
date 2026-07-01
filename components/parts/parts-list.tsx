import { ListCard, MonoId } from "@/components/patterns";
import type { Part, ProcessMaster } from "@/lib/domain";

export function PartsList({
  parts,
  processMasters,
  onSelect,
}: {
  parts: Part[];
  processMasters: ProcessMaster[];
  onSelect?: (id: string) => void;
}) {
  const pmById = new Map(processMasters.map((p) => [p.id, p]));
  return (
    <ListCard
      headers={["PART", "DESCRIPTION", "MATERIAL", "DWG", "HARDNESS", "PROCESS"]}
      onRowClick={onSelect ? (i) => onSelect(parts[i].id) : undefined}
      rows={parts.map((p) => [
        <MonoId key="pn">{p.partNumber}</MonoId>,
        p.description,
        p.material,
        <span key="dwg" className="font-mono">{p.drawingRev}</span>,
        p.hardness,
        p.processMasterId ? <MonoId key="pm">{pmById.get(p.processMasterId)?.code ?? "—"}</MonoId> : "—",
      ])}
    />
  );
}

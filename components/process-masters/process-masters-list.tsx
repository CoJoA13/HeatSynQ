import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import type { ProcessMaster } from "@/lib/domain";

export function ProcessMastersList({
  processMasters,
  onSelect,
}: {
  processMasters: ProcessMaster[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ListCard
      headers={["PROCESS MASTER", "NAME", "REV", "STEPS", "SURFACE", "STATUS"]}
      onRowClick={onSelect ? (i) => onSelect(processMasters[i].id) : undefined}
      rows={processMasters.map((pm) => [
        <MonoId key="code">{pm.code}</MonoId>,
        pm.name,
        <span key="rev" className="font-mono">{pm.rev}</span>,
        <span key="steps" className="font-mono">{pm.steps.length}</span>,
        pm.surfaceHardness,
        <StatusPill key="status" tone="success">Active</StatusPill>,
      ])}
    />
  );
}

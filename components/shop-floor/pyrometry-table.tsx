import { ListCard, StatusPill, EmptyState } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { maintenanceTypeMeta } from "@/lib/domain/enums";
import { isMaintenanceDue } from "@/lib/logic/maintenance";
import { formatDate } from "@/lib/utils";
import type { Maintenance } from "@/lib/domain";

export function PyrometryTable({ tasks, specCodeById, asOf, canMaintain, busy, onComplete }: {
  tasks: Maintenance[];
  specCodeById: Map<string, string>;
  asOf: string;
  canMaintain: boolean;
  busy: boolean;
  onComplete: (task: Maintenance) => void;
}) {
  if (tasks.length === 0) return <EmptyState title="No pyrometry schedule" />;
  return (
    <ListCard
      headers={["Type", "Spec", "Interval", "Last done", "Next due", ""]}
      rows={tasks.map((t) => [
        <span key="type" data-testid={`pyro-row-${t.id}`}><StatusPill tone="info">{maintenanceTypeMeta[t.type].label}</StatusPill></span>,
        <span key="spec" className="font-mono text-xs">{specCodeById.get(t.specificationId) ?? t.specificationId}</span>,
        <span key="int" className="font-mono text-xs">{t.intervalDays}d</span>,
        <span key="last" className="font-mono text-xs">{formatDate(t.lastDoneAt)}</span>,
        <span key="due" className="font-mono text-xs">
          {formatDate(t.nextDueAt)}{" "}
          {isMaintenanceDue(t, asOf) && <span data-testid={`pyro-due-${t.id}`}><StatusPill tone="danger">Overdue</StatusPill></span>}
        </span>,
        canMaintain
          ? <Button key="act" size="sm" variant="outline" disabled={busy} data-testid={`pyro-complete-${t.id}`} onClick={() => onComplete(t)}>Mark complete</Button>
          : <span key="act" />,
      ])}
    />
  );
}

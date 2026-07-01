import { StatusPill, MonoId } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { orderStatusMeta } from "@/lib/domain/enums";
import type { ScheduleCell } from "@/lib/logic/schedule";

export function ScheduleCellCard({ cell, customerName, canSchedule, busy, onMove, onUnassign }: {
  cell: ScheduleCell;
  customerName: string | null;
  canSchedule: boolean;
  busy: boolean;
  onMove: (cell: ScheduleCell) => void;
  onUnassign: (cell: ScheduleCell) => void;
}) {
  const sm = orderStatusMeta[cell.status];
  return (
    <div data-testid={`schedule-cell-${cell.blockId}`} className="rounded-card border border-border bg-surface p-2">
      <div className="mb-1 flex items-center justify-between">
        <MonoId className="text-xs">{cell.workOrderNumber}</MonoId>
        {cell.late && <StatusPill tone="danger">LATE</StatusPill>}
      </div>
      <div className="text-[12px] font-medium">{customerName ?? "—"}</div>
      <div className="text-text-muted text-[11px]">{cell.op ?? "—"}</div>
      <div className="mt-1"><StatusPill tone={sm.tone}>{sm.label}</StatusPill></div>
      <div data-testid="cell-progress" className="mt-2 h-1.5 rounded-full bg-canvas-alt">
        <div className="h-1.5 rounded-full bg-primary" style={{ width: `${cell.progressPct}%` }} />
      </div>
      {cell.actionable && canSchedule && (
        <div className="mt-2 flex gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onMove(cell)}>Move</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onUnassign(cell)}>Unassign</Button>
        </div>
      )}
    </div>
  );
}

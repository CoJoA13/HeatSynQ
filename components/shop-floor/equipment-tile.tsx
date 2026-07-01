import { StatusPill, MonoId } from "@/components/patterns";
import { equipmentStateMeta, equipmentKindMeta, type EquipmentDef } from "@/lib/domain/enums";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

/** Format an ISO instant as a UTC h:mm AM/PM clock (deterministic — no local timezone). */
function clockUtc(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours();
  const hh = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "AM" : "PM";
  return `${hh}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap}`;
}

export function EquipmentTile({ equipment, entry, customerName, onSelect }: {
  equipment: EquipmentDef;
  entry: EquipmentLoad;
  customerName: string | null;
  onSelect?: (workOrderId: string) => void;
}) {
  const sm = equipmentStateMeta[entry.state];
  const testId = `equipment-tile-${equipment.id}`;
  const header = (
    <div className="flex items-start justify-between">
      <div>
        <div className="text-[13px] font-medium">{equipment.name}</div>
        <div className="text-text-muted text-[11px]">{equipmentKindMeta[equipment.kind].label}</div>
      </div>
      <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
    </div>
  );

  if (!entry.load) {
    return (
      <div data-testid={testId} className="rounded-card border border-border bg-surface p-4 opacity-60">
        {header}
        <div className="text-text-muted mt-3 text-xs">No load · available</div>
      </div>
    );
  }

  const l = entry.load;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => onSelect?.(l.workOrderId)}
      className="w-full rounded-card border border-border bg-surface p-4 text-left"
    >
      {header}
      <div className="mt-3 flex items-center justify-between">
        <MonoId>{l.workOrderNumber}</MonoId>
        {l.late && <StatusPill tone="danger">LATE</StatusPill>}
      </div>
      <div className="text-[13px] font-medium">{customerName ?? "—"}</div>
      <div className="text-text-muted text-xs">{l.op}</div>
      <div className="mt-2 h-2 w-full rounded-full bg-canvas-alt">
        <div className="h-2 rounded-full bg-primary" style={{ width: `${l.progressPct}%` }} />
      </div>
      <div className="text-text-muted mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
        {l.operatorInitials && <span>{l.operatorInitials}</span>}
        {l.setpoint && <span>Setpoint {l.setpoint}</span>}
        {l.estFinishIso && <span>Est. finish {clockUtc(l.estFinishIso)}</span>}
        {entry.queued > 0 && <span>+{entry.queued} queued</span>}
      </div>
    </button>
  );
}

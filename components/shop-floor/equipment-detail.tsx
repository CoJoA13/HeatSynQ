"use client";
import { useState } from "react";
import Link from "next/link";
import { StatusPill, MonoId, EmptyState, ConfirmDialog } from "@/components/patterns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
import { equipmentStateMeta, equipmentKindMeta, maintenanceTypeMeta, type EquipmentAvailability } from "@/lib/domain/enums";
import { PyrometryTable } from "./pyrometry-table";
import type { Equipment, Maintenance } from "@/lib/domain";
import type { EquipmentLoad } from "@/lib/logic/shop-floor";

function maintenanceLabel(t: Maintenance): string { return maintenanceTypeMeta[t.type].label; }

function NoteForm({ mode, busy, onCancel, onConfirm }: {
  mode: "down" | "maintenance"; busy: boolean; onCancel: () => void; onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "down" ? "Mark down" : "Start maintenance"}</DialogTitle>
        <DialogDescription>Add a note explaining why the unit is out of service.</DialogDescription>
      </DialogHeader>
      <label className="block text-xs">
        <span className="text-text-muted mb-1 block">Note</span>
        <textarea aria-label="Note" className="w-full rounded-lg border border-input bg-transparent p-2 text-sm" rows={3}
          value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button disabled={busy || note.trim() === ""} onClick={() => onConfirm(note.trim())}>
          {mode === "down" ? "Confirm down" : "Confirm maintenance"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function EquipmentDetail({ equipment, entry, customerName, tasks, specCodeById, asOf, canMaintain, busy, onSetAvailability, onComplete }: {
  equipment: Equipment; entry: EquipmentLoad; customerName: string | null;
  tasks: Maintenance[]; specCodeById: Map<string, string>; asOf: string;
  canMaintain: boolean; busy: boolean;
  onSetAvailability: (availability: EquipmentAvailability, note: string | null) => void;
  onComplete: (task: Maintenance) => void;
}) {
  const [noteMode, setNoteMode] = useState<"down" | "maintenance" | null>(null);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState<Maintenance | null>(null);
  const sm = equipmentStateMeta[entry.state];
  const l = entry.load;

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">{equipment.name}</h1>
          <div className="text-text-muted text-xs">{equipmentKindMeta[equipment.kind].label} · <MonoId>{equipment.id}</MonoId></div>
          {equipment.note && <div className="text-text-muted mt-1 text-xs">{equipment.note}</div>}
        </div>
        <span data-testid="equipment-state-pill"><StatusPill tone={sm.tone}>{sm.label}</StatusPill></span>
      </div>

      {/* availability controls */}
      {canMaintain && (
        <div className="flex gap-2">
          {equipment.availability === "available" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setNoteMode("down")}>Mark down</Button>
              <Button variant="outline" disabled={busy} onClick={() => setNoteMode("maintenance")}>Start maintenance</Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setConfirmReturn(true)}>Return to service</Button>
          )}
        </div>
      )}

      {/* current load */}
      <div className="rounded-card border border-border bg-surface p-4">
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Current load</div>
        {l ? (
          <div>
            <div className="flex items-center justify-between">
              <Link href={`/orders/${l.workOrderId}`} className="underline-offset-2 hover:underline"><MonoId>{l.workOrderNumber}</MonoId></Link>
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
              {entry.queued > 0 && <span>+{entry.queued} queued</span>}
            </div>
          </div>
        ) : (
          <EmptyState title={entry.state === "idle" ? "No load · available" : "No load"} />
        )}
      </div>

      {/* pyrometry */}
      <div>
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Pyrometry (AMS 2750)</div>
        <PyrometryTable tasks={tasks} specCodeById={specCodeById} asOf={asOf} canMaintain={canMaintain} busy={busy}
          onComplete={(t) => setConfirmComplete(t)} />
        <p className="text-text-faint mt-2 text-[11px]">TUS — Temperature Uniformity Survey · SAT — System Accuracy Test</p>
      </div>

      <Dialog open={noteMode !== null} onOpenChange={(o) => { if (!o) setNoteMode(null); }}>
        <DialogContent showCloseButton={false}>
          {noteMode && (
            <NoteForm key={noteMode} mode={noteMode} busy={busy} onCancel={() => setNoteMode(null)}
              onConfirm={(note) => { onSetAvailability(noteMode, note); setNoteMode(null); }} />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirmReturn} onOpenChange={setConfirmReturn}
        title="Return to service" description={`${equipment.name} will be marked available.`}
        confirmLabel="Confirm return" onConfirm={() => onSetAvailability("available", null)} />
      <ConfirmDialog open={confirmComplete !== null} onOpenChange={(o) => { if (!o) setConfirmComplete(null); }}
        title="Mark survey complete"
        description={confirmComplete ? `${maintenanceLabel(confirmComplete)} — completion rolls the next due date forward.` : ""}
        confirmLabel="Confirm complete" onConfirm={() => { if (confirmComplete) onComplete(confirmComplete); }} />
    </div>
  );
}

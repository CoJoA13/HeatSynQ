"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
import { equipmentKindMeta } from "@/lib/domain/enums";
import type { WeekDay } from "@/lib/logic/schedule";
import type { Equipment } from "@/lib/domain";

const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm";

function AssignForm({ mode, workOrderNumber, days, equipment, initialEquipmentId, initialDay, busy, onOpenChange, onConfirm }: {
  mode: "assign" | "move";
  workOrderNumber: string;
  days: WeekDay[];
  equipment: Equipment[];
  initialEquipmentId?: string;
  initialDay?: string;
  busy: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (equipmentId: string, day: string) => void;
}) {
  const options = equipment.filter((e) => e.availability === "available");
  const [equipmentId, setEquipmentId] = useState(initialEquipmentId ?? options[0]?.id ?? "");
  const [day, setDay] = useState(initialDay ?? days[0]?.iso ?? "");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "assign" ? "Schedule order" : "Move scheduled order"}</DialogTitle>
        <DialogDescription>{workOrderNumber} — choose a furnace and day.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <label className="block text-xs">
          <span className="text-text-muted mb-1 block">Equipment</span>
          <select aria-label="Equipment" className={selectCls} value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
            {options.map((eq) => (
              <option key={eq.id} value={eq.id}>{eq.name} — {equipmentKindMeta[eq.kind].label}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-text-muted mb-1 block">Day</span>
          <select aria-label="Day" className={selectCls} value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((d) => (<option key={d.iso} value={d.iso}>{d.label}</option>))}
          </select>
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={busy || !equipmentId || !day} onClick={() => onConfirm(equipmentId, day)}>
          {mode === "assign" ? "Schedule" : "Move"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function AssignDialog({ open, onOpenChange, mode, workOrderNumber, days, equipment, initialEquipmentId, initialDay, busy, onConfirm }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "assign" | "move";
  workOrderNumber: string;
  days: WeekDay[];
  equipment: Equipment[];
  initialEquipmentId?: string;
  initialDay?: string;
  busy: boolean;
  onConfirm: (equipmentId: string, day: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <AssignForm
          key={open ? `${initialEquipmentId}-${initialDay}` : "closed"}
          mode={mode}
          workOrderNumber={workOrderNumber}
          days={days}
          equipment={equipment}
          initialEquipmentId={initialEquipmentId}
          initialDay={initialDay}
          busy={busy}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}

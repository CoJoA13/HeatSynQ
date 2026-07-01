"use client";
import { Fragment, useState } from "react";
import { KpiTile, ConfirmDialog } from "@/components/patterns";
import { EQUIPMENT, equipmentKindMeta } from "@/lib/domain/enums";
import { weekDays, scheduleCells, unscheduledOrders, scheduleSummary, type ScheduleCell } from "@/lib/logic/schedule";
import { ScheduleCellCard } from "./schedule-cell";
import { UnscheduledQueue } from "./unscheduled-queue";
import { AssignDialog } from "./assign-dialog";
import type { WorkOrder, Customer, ScheduleBlock } from "@/lib/domain";

export function ScheduleBoard({ orders, customers, blocks, asOf, canSchedule, busy, onAssign, onMove, onUnassign }: {
  orders: WorkOrder[];
  customers: Customer[];
  blocks: ScheduleBlock[];
  asOf: string;
  canSchedule: boolean;
  busy: boolean;
  onAssign: (order: WorkOrder, equipmentId: string, day: string) => void;
  onMove: (cell: ScheduleCell, equipmentId: string, day: string) => void;
  onUnassign: (cell: ScheduleCell) => void;
}) {
  const days = weekDays(asOf);
  const cells = scheduleCells(blocks, orders, asOf);
  const queue = unscheduledOrders(orders, blocks);
  const summary = scheduleSummary(cells, queue);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const cellsAt = new Map<string, ScheduleCell[]>();
  for (const c of cells) {
    const k = `${c.equipmentId}|${c.day}`;
    const arr = cellsAt.get(k);
    if (arr) arr.push(c); else cellsAt.set(k, [c]);
  }

  const [assignFor, setAssignFor] = useState<WorkOrder | null>(null);
  const [moveFor, setMoveFor] = useState<ScheduleCell | null>(null);
  const [unassignFor, setUnassignFor] = useState<ScheduleCell | null>(null);

  return (
    <div>
      <div data-testid="schedule-summary" className="mb-5 grid grid-cols-3 gap-3">
        <KpiTile label="Scheduled" value={String(summary.scheduled)} />
        <KpiTile label="Unscheduled" value={String(summary.unscheduled)} />
        <KpiTile label="Late" value={String(summary.late)} tone="danger" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[720px]"
            style={{ gridTemplateColumns: `10rem repeat(${days.length}, minmax(9rem, 1fr))` }}
          >
            <div />
            {days.map((d) => (
              <div key={d.iso} className="text-text-faint px-2 pb-2 font-mono text-[10.5px] uppercase tracking-wider">{d.label}</div>
            ))}
            {EQUIPMENT.map((eq) => (
              <Fragment key={eq.id}>
                <div className="border-border border-t px-2 py-2">
                  <div className="text-[12px] font-medium">{eq.name}</div>
                  <div className="text-text-muted text-[10.5px]">{equipmentKindMeta[eq.kind].label}</div>
                </div>
                {days.map((d) => {
                  const slotCells = cellsAt.get(`${eq.id}|${d.iso}`) ?? [];
                  return (
                    <div key={d.iso} data-testid={`grid-cell-${eq.id}-${d.iso}`} className="border-border border-t border-l p-1">
                      {slotCells.length > 0 ? (
                        <div className="space-y-1">
                          {slotCells.map((cell) => (
                            <ScheduleCellCard
                              key={cell.blockId}
                              cell={cell}
                              customerName={custById.get(cell.customerId)?.name ?? null}
                              canSchedule={canSchedule}
                              busy={busy}
                              onMove={(c) => setMoveFor(c)}
                              onUnassign={(c) => setUnassignFor(c)}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="text-text-faint p-2 text-center text-xs">—</div>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        <UnscheduledQueue
          orders={queue}
          customers={customers}
          canSchedule={canSchedule}
          busy={busy}
          onAssign={(o) => setAssignFor(o)}
          asOf={asOf}
        />
      </div>

      <AssignDialog
        open={assignFor !== null}
        onOpenChange={(o) => { if (!o) setAssignFor(null); }}
        mode="assign"
        workOrderNumber={assignFor?.number ?? ""}
        days={days}
        busy={busy}
        onConfirm={(equipmentId, day) => { if (assignFor) { onAssign(assignFor, equipmentId, day); setAssignFor(null); } }}
      />
      <AssignDialog
        open={moveFor !== null}
        onOpenChange={(o) => { if (!o) setMoveFor(null); }}
        mode="move"
        workOrderNumber={moveFor?.workOrderNumber ?? ""}
        days={days}
        initialEquipmentId={moveFor?.equipmentId}
        initialDay={moveFor?.day}
        busy={busy}
        onConfirm={(equipmentId, day) => { if (moveFor) { onMove(moveFor, equipmentId, day); setMoveFor(null); } }}
      />
      <ConfirmDialog
        open={unassignFor !== null}
        onOpenChange={(o) => { if (!o) setUnassignFor(null); }}
        title="Unschedule order"
        description={`Return ${unassignFor?.workOrderNumber ?? ""} to Received? Its schedule block will be cancelled.`}
        confirmLabel="Unschedule"
        onConfirm={() => { if (unassignFor) { onUnassign(unassignFor); setUnassignFor(null); } }}
      />
    </div>
  );
}

import { KpiTile } from "@/components/patterns";
import { equipmentLoads, shopFloorSummary } from "@/lib/logic/shop-floor";
import { dueMaintenance } from "@/lib/logic/maintenance";
import { EquipmentTile } from "./equipment-tile";
import type { WorkOrder, Customer, Equipment, Maintenance } from "@/lib/domain";

export function ShopFloorGrid({ orders, customers, equipment, maintenance, asOf, onSelect }: {
  orders: WorkOrder[];
  customers: Customer[];
  equipment: Equipment[];
  maintenance: Maintenance[];
  asOf: string;
  onSelect?: (equipmentId: string) => void;
}) {
  const loads = equipmentLoads(orders, equipment, asOf);
  const summary = shopFloorSummary(loads);
  const pyroDue = dueMaintenance(maintenance, asOf).length;
  const custById = new Map(customers.map((c) => [c.id, c]));
  const equipById = new Map(equipment.map((e) => [e.id, e]));

  return (
    <div>
      <div data-testid="shopfloor-summary" className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Running" value={String(summary.running)} />
        <KpiTile label="Idle" value={String(summary.idle)} />
        <KpiTile label="On hold" value={String(summary.onHold)} tone="warn" />
        <KpiTile label="Late" value={String(summary.late)} tone="danger" />
        <KpiTile label="Out of service" value={String(summary.outOfService)} tone="warn" />
        <KpiTile label="Pyrometry due" value={String(pyroDue)} tone={pyroDue > 0 ? "danger" : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loads.map((entry) => {
          const unit = equipById.get(entry.equipmentId)!;
          const name = entry.load ? (custById.get(entry.load.customerId)?.name ?? null) : null;
          return (
            <EquipmentTile key={entry.equipmentId} equipment={unit} entry={entry} customerName={name} onSelect={onSelect} />
          );
        })}
      </div>
    </div>
  );
}
